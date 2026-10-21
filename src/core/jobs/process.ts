import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * How long a Docker probe (`docker info`, `docker version`) may take. A Docker Desktop that is
 * installed but cannot start leaves its CLI waiting on the backend.
 */
export const DOCKER_PROBE_TIMEOUT_MS = 3000;

const MAX_OUTPUT_CHARS = 1024 * 1024;

/**
 * Runs `file` with array arguments in a process group of its own and resolves with its output
 * once it exits 0. Rejects like `execFile` when it cannot start (`code` ENOENT) or exits non-zero
 * (`code`, `stderr`, and a `Command failed: …` message). After `timeoutMs` it kills the whole
 * group and rejects at once (`code` ETIMEDOUT), so a helper the program started cannot keep it
 * running or holding its output open.
 */
export function execBounded(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const command = [file, ...args].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    const timer = setTimeout(() => {
      // The group outlives its leader while a member runs, so its id is not reused before this.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(
        Object.assign(new Error(`${command} did not finish within ${timeoutMs / 1000} s`), {
          code: "ETIMEDOUT",
        }),
      );
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          Object.assign(new Error(`Command failed: ${command}\n${stderr}`), {
            code,
            signal,
            stderr,
          }),
        );
    });
  });
}

/** Linux allows PIDs up to 2^22; the bound only rejects nonsense. */
export const PidSchema = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/**
 * A process group id UFO may signal. `kill(-1)` and `kill(0)` address every process and the
 * caller's own group, and pid 1 is init, so ids below 2 are never valid.
 */
export const PgidSchema = PidSchema.min(2);

/** Opaque per-process start time, compared to tell a live process from one that reused its PID. */
export const StartTimeSchema = z.string().min(1).max(64);

export function isPidAlive(pid: number): boolean {
  if (!PidSchema.safeParse(pid).success) return false;
  return probe(pid);
}

export function isProcessGroupAlive(pgid: number): boolean {
  if (!PgidSchema.safeParse(pgid).success) return false;
  return probe(-pgid);
}

function probe(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads `/proc/<pid>/stat`; a test passes its own. */
export type ProcStatReader = (pid: number) => Promise<string>;

const readProcStat: ProcStatReader = (pid) => readFile(`/proc/${pid}/stat`, "utf8");

/**
 * Field 22 of a `/proc/<pid>/stat` line, the start in clock ticks since boot, as `ticks:<n>`.
 * The fields are read after the last `)`, since the command name (field 2) may hold spaces and
 * parentheses.
 */
export function procStatStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // After the name, the first field is field 3 (state), so field 22 is the twentieth.
  const ticks = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return ticks !== undefined && /^\d{1,20}$/.test(ticks) ? `ticks:${ticks}` : undefined;
}

/**
 * The start time of `pid`, or `undefined` when the process does not exist or the platform cannot
 * tell. On Linux it is the start in clock ticks since boot (`/proc/<pid>/stat`): `ps -o lstart`
 * there adds the boot time, which the kernel recomputes from the clock on every read, so a clock
 * step (NTP, a resumed VM) would move a live process's start. Elsewhere it is what `ps` reports
 * (one-second resolution), in a fixed locale and time zone so that it is comparable across
 * processes with different environments; compare it with `sameStartTime`.
 */
export async function readProcessStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readStat: ProcStatReader = readProcStat,
): Promise<string | undefined> {
  if (platform === "win32" || !PidSchema.safeParse(pid).success) return undefined;
  if (platform === "linux") {
    return readStat(pid).then(procStatStartTime, () => undefined);
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
    });
    const value = stdout.trim().replace(/\s+/g, " ");
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Seconds two `ps` start times of one process may differ by and still name it. */
export const START_TIME_TOLERANCE_S = 2;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A `ps -o lstart` time in the C locale and UTC (`Wed Oct 22 00:21:24 2026`) in epoch seconds. */
function lstartSeconds(value: string): number | undefined {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    value.replace(/\s+/g, " "),
  );
  if (match === null) return undefined;
  const [, month, day, hours, minutes, seconds, year] = match;
  const index = MONTHS.indexOf(month ?? "");
  if (index < 0) return undefined;
  return (
    Date.UTC(Number(year), index, Number(day), Number(hours), Number(minutes), Number(seconds)) /
    1000
  );
}

/**
 * Whether two start times read with `readProcessStartTime` name the same process: equal, or two
 * `ps` times at most `START_TIME_TOLERANCE_S` apart (a reading that crossed a second, or a clock
 * that moved under it). Linux's tick counts must be equal.
 */
export function sameStartTime(a: string, b: string): boolean {
  if (a === b) return true;
  const x = lstartSeconds(a);
  const y = lstartSeconds(b);
  return x !== undefined && y !== undefined && Math.abs(x - y) <= START_TIME_TOLERANCE_S;
}

/**
 * The full command line `ps` reports for `pid`, or `undefined` when the process does not exist
 * or `ps` cannot tell. Used to check that a recorded PID still runs what UFO started.
 */
export async function readProcessCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "win32" || !PidSchema.safeParse(pid).success) return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
