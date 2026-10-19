import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appendNoFollow,
  type ChildGroup,
  isPidAlive,
  LOGS_DIR,
  OPEN_APPEND,
  openNoFollow,
  readProcessStartTime,
} from "../core/jobs/index.js";
import { trackChildGroup, untrackChildGroup } from "../worker/index.js";

/** The longest any one approved command may run before it is killed. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;
/** stdout and stderr each keep at most this many bytes; the rest is dropped and reported. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;
export const COMMANDS_LOG = "commands.log";

export interface CommandOptions {
  /** Run state directory: the process group is tracked in its `run.json` while it runs. */
  readonly runDir: string;
  readonly cwd: string;
  /** The command's whole environment; nothing else is inherited. */
  readonly env: NodeJS.ProcessEnv;
  /** e.g. `a setup`, `b sample 3`; used in `logs/commands.log`. */
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly command: string;
  /** `null` when the process was killed by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Output beyond `MAX_OUTPUT_BYTES` was dropped. */
  readonly truncated: boolean;
}

export function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.aborted;
}

/** One line for a decision detail: the exit status and the end of stderr. */
export function describeResult(result: CommandResult): string {
  const status = result.timedOut
    ? "timed out"
    : result.aborted
      ? "was cancelled"
      : result.exitCode === null
        ? "was killed"
        : `exited with code ${result.exitCode}`;
  const tail = result.stderr
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(-300);
  return tail === ""
    ? `\`${result.command}\` ${status}`
    : `\`${result.command}\` ${status}: ${tail}`;
}

/** Signals a whole process group; a group that is already gone is not an error. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid < 2) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
}

/**
 * Signals the group of a leader UFO already reaped. Members keep the group id from being reused
 * while they live; a live process with the leader's PID is another process that reused it
 * (its start time differs from the recorded one), and is left alone.
 */
async function killReapedGroup(
  pgid: number | undefined,
  startTime: string | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  if (pgid === undefined) return;
  if (isPidAlive(pgid)) {
    if (startTime === undefined || (await readProcessStartTime(pgid)) !== startTime) return;
  }
  killGroup(pgid, signal);
}

/** Signals `child`'s group: directly while the leader is not reaped (its id is still ours). */
async function killChildGroup(
  child: ChildProcess,
  group: ChildGroup | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) killGroup(child.pid, signal);
  else await killReapedGroup(child.pid, group?.startTime, signal);
}

function spawnShell(command: string, options: CommandOptions, stdio: "pipe" | number[]) {
  return spawn("/bin/sh", ["-c", command], {
    cwd: options.cwd,
    env: options.env,
    // Its own process group, so the command and everything it starts can be stopped together,
    // and so resume and cancel can find it in run.json after the worker died.
    detached: true,
    stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : ["ignore", ...stdio],
  });
}

async function logCommand(options: CommandOptions, line: string): Promise<void> {
  await appendNoFollow(path.join(options.runDir, LOGS_DIR, COMMANDS_LOG), `${line}\n`).catch(
    () => undefined,
  );
}

function collector() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      bytes += kept.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    get truncated() {
      return truncated;
    },
  };
}

/**
 * Runs one approved command line with `/bin/sh -c` in its own process group, tracked in
 * `run.json` while it runs. When it exits, whatever it left running in its group is killed, so
 * a benchmark cannot leak a server into the next sample.
 */
export async function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const started = performance.now();
  const child = spawnShell(command, options, "pipe");
  const stdout = collector();
  const stderr = collector();
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = once(child, "exit").catch(() => undefined);
  const closed = once(child, "close").catch(() => undefined);
  try {
    await once(child, "spawn");
  } catch (error) {
    throw new Error(`could not start /bin/sh for \`${command}\``, { cause: error });
  }
  const { pid } = child;
  // Without a start time the group is not tracked, and once its leader exited it is signalled
  // only while no process holds the leader's PID.
  const group =
    pid === undefined
      ? undefined
      : await trackChildGroup(options.runDir, pid).catch(() => undefined);

  let timedOut = false;
  let aborted = false;
  let forceKill: NodeJS.Timeout | undefined;
  const stop = (reason: "timeout" | "abort") => {
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    void killChildGroup(child, group, "SIGTERM");
    // Cleared once the leader exits; until then its id is still this command's.
    forceKill ??= setTimeout(() => void killChildGroup(child, group, "SIGKILL"), KILL_GRACE_MS);
    forceKill.unref();
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const onAbort = () => stop("abort");
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    clearTimeout(forceKill);
    options.signal?.removeEventListener("abort", onAbort);
    // Anything the command left behind (a server started with `&`) still holds its group and
    // maybe its output pipes; it goes now, then the pipes close. The leader was reaped, so the
    // start-time guard keeps a reused id from being signalled.
    await killReapedGroup(pid, group?.startTime, "SIGKILL");
    await closed;
    if (pid !== undefined) await untrackChildGroup(options.runDir, pid).catch(() => undefined);
  }
  const result: CommandResult = {
    command,
    exitCode: child.exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    durationMs: performance.now() - started,
    timedOut,
    aborted,
    truncated: stdout.truncated || stderr.truncated,
  };
  await logCommand(
    options,
    `${new Date().toISOString()} [${options.label}] ${describeResult(result).split(": ")[0]} in ${Math.round(result.durationMs)} ms`,
  );
  return result;
}

/** A long-running `start` command (a server), stopped by `stop()` at teardown. */
export interface BackgroundProcess {
  readonly command: string;
  readonly pid: number;
  /** Whether it is still running. */
  running(): boolean;
  stop(): Promise<void>;
}

/** Starts `command` in its own tracked process group with output appended to `logs/<log>`. */
export async function startBackground(
  command: string,
  options: CommandOptions & { readonly log: string },
): Promise<BackgroundProcess> {
  const log = await openNoFollow(path.join(options.runDir, LOGS_DIR, options.log), OPEN_APPEND);
  let child: ChildProcess;
  try {
    child = spawnShell(command, options, [log.fd, log.fd]);
    await once(child, "spawn");
  } finally {
    await log.close();
  }
  const { pid } = child;
  if (pid === undefined) throw new Error(`\`${command}\` has no pid`);
  const group = await trackChildGroup(options.runDir, pid).catch(() => undefined);
  let exited = false;
  const closed = once(child, "close").then(() => {
    exited = true;
  });
  await logCommand(options, `${new Date().toISOString()} [${options.label}] started pid ${pid}`);
  return {
    command,
    pid,
    running: () => !exited,
    stop: async () => {
      await killChildGroup(child, group, "SIGTERM");
      const done = await Promise.race([closed.then(() => true), delay(KILL_GRACE_MS, false)]);
      await killChildGroup(child, group, "SIGKILL");
      if (!done) await closed;
      await untrackChildGroup(options.runDir, pid).catch(() => undefined);
    },
  };
}
