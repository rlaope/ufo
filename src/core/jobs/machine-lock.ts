import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isErrno, writeJsonAtomic } from "./atomic-file.js";
import { MACHINE_LOCK_FILE, RunIdSchema, ufoHome } from "./paths.js";
import { isPidAlive, PidSchema, readProcessStartTime, StartTimeSchema } from "./process.js";

export const MachineLockSchema = z.strictObject({
  pid: PidSchema,
  /** Absent when the platform cannot report process start times. */
  startTime: StartTimeSchema.optional(),
  runId: RunIdSchema,
  acquiredAt: z.iso.datetime({ offset: true }),
});
export type MachineLock = z.infer<typeof MachineLockSchema>;

/** Added to results when a holder's start time is unknown, so PID reuse cannot be detected. */
export const PID_ONLY_LIMITATION =
  "machine lock: process start time unavailable, so stale-lock detection uses PID liveness " +
  "only; a lock whose PID was reused by another process is reported as held";

/** A lock file that is still empty or partial this long after creation is abandoned. */
const UNREADABLE_LOCK_STALE_MS = 2000;
const MAX_ATTEMPTS = 3;

export type AcquireResult =
  | { acquired: true; lock: MachineLock; cleared?: MachineLock; limitation?: string }
  | { acquired: false; holder?: MachineLock; limitation?: string };

interface LockOptions {
  /** Defaults to `ufoHome()`. */
  home?: string;
}

function lockPath(home: string | undefined): string {
  return path.join(home ?? ufoHome(), MACHINE_LOCK_FILE);
}

/**
 * Takes the machine-wide run lock at `$UFO_HOME/lock` by exclusive create (`wx`). Fails while a
 * live process holds it. A lock is stale, and is cleared, when its PID is dead or when that PID
 * now belongs to a process with a different start time (PID reuse).
 *
 * Limitation: two processes that clear the same stale lock at the same instant can both acquire.
 */
export async function acquireMachineLock(
  options: LockOptions & { runId: string; pid?: number },
): Promise<AcquireResult> {
  const file = lockPath(options.home);
  await mkdir(path.dirname(file), { recursive: true });
  const pid = options.pid ?? process.pid;
  const startTime = await readProcessStartTime(pid);
  const lock = MachineLockSchema.parse({
    pid,
    ...(startTime === undefined ? {} : { startTime }),
    runId: options.runId,
    acquiredAt: new Date().toISOString(),
  });
  const ownLimitation = startTime === undefined ? { limitation: PID_ONLY_LIMITATION } : {};
  let cleared: MachineLock | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await createExclusive(file, `${JSON.stringify(lock, null, 2)}\n`)) {
      return { acquired: true, lock, ...(cleared ? { cleared } : {}), ...ownLimitation };
    }
    const state = await inspect(file);
    if (state.kind === "held") {
      const { holder, limitation } = state;
      return {
        acquired: false,
        ...(holder ? { holder } : {}),
        ...(limitation ? { limitation } : {}),
      };
    }
    if (state.kind === "stale") {
      cleared = state.holder ?? cleared;
      await rm(file, { force: true });
    }
  }
  return { acquired: false };
}

/** Removes the lock if `runId` holds it. Returns whether it did. */
export async function releaseMachineLock(
  options: LockOptions & { runId: string },
): Promise<boolean> {
  const file = lockPath(options.home);
  const holder = await readLock(file);
  if (holder?.runId !== options.runId) return false;
  await rm(file, { force: true });
  return true;
}

/**
 * Hands the lock held by `runId` to another process, e.g. from the CLI that acquired it to the
 * detached worker it launched.
 */
export async function transferMachineLock(
  options: LockOptions & { runId: string; pid: number },
): Promise<MachineLock> {
  const file = lockPath(options.home);
  const holder = await readLock(file);
  if (holder?.runId !== options.runId) {
    throw new Error(`the machine lock is not held by run ${options.runId}`);
  }
  const startTime = await readProcessStartTime(options.pid);
  const lock = MachineLockSchema.parse({
    pid: options.pid,
    ...(startTime === undefined ? {} : { startTime }),
    runId: options.runId,
    acquiredAt: holder.acquiredAt,
  });
  await writeJsonAtomic(file, lock);
  return lock;
}

export function readMachineLock(options: LockOptions = {}): Promise<MachineLock | undefined> {
  return readLock(lockPath(options.home));
}

async function createExclusive(file: string, text: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "wx");
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

async function readLock(file: string): Promise<MachineLock | undefined> {
  try {
    return MachineLockSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

type LockState =
  | { kind: "held"; holder?: MachineLock; limitation?: string }
  | { kind: "stale"; holder?: MachineLock }
  | { kind: "gone" };

async function inspect(file: string): Promise<LockState> {
  let holder: MachineLock;
  try {
    holder = MachineLockSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "gone" };
    // Empty or partial: another process may be writing it right now.
    try {
      const { mtimeMs } = await stat(file);
      return Date.now() - mtimeMs > UNREADABLE_LOCK_STALE_MS ? { kind: "stale" } : { kind: "held" };
    } catch (statError) {
      if (isErrno(statError, "ENOENT")) return { kind: "gone" };
      throw statError;
    }
  }
  if (!isPidAlive(holder.pid)) return { kind: "stale", holder };
  if (holder.startTime === undefined) {
    return { kind: "held", holder, limitation: PID_ONLY_LIMITATION };
  }
  const current = await readProcessStartTime(holder.pid);
  if (current === undefined) {
    // Alive but `ps` cannot see it (e.g. it exited since the liveness check, or ps failed).
    return isPidAlive(holder.pid)
      ? { kind: "held", holder, limitation: PID_ONLY_LIMITATION }
      : { kind: "stale", holder };
  }
  return current === holder.startTime ? { kind: "held", holder } : { kind: "stale", holder };
}
