import { execFile, spawn } from "node:child_process";
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

/**
 * The start time `ps` reports for `pid` (one-second resolution), or `undefined` when the process
 * does not exist or the platform has no `ps`. The fixed locale and time zone make the value
 * comparable across processes with different environments.
 */
export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === "win32" || !PidSchema.safeParse(pid).success) return undefined;
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
