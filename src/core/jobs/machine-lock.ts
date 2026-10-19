import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensureTrustedDir, privateRoot, TrustError } from "../paths.js";
import {
  isErrno,
  OPEN_CREATE_EXCLUSIVE,
  openNoFollow,
  readJsonIfExists,
  readTextNoFollow,
} from "./atomic-file.js";
import { machineLockPath, RUN_FILE, RunIdSchema, runDirFor } from "./paths.js";
import { abandonedStart, RunRecordSchema } from "./run-record.js";

/**
 * The machine lock names the run that holds it, not a process: a run holds it from `startRun`
 * until it finishes, is cancelled, or fails to start, whether or not a worker is alive.
 */
export const MachineLockSchema = z.strictObject({
  runId: RunIdSchema,
  repoId: RunRecordSchema.shape.repoId,
  acquiredAt: z.iso.datetime({ offset: true }),
});
export type MachineLock = z.infer<typeof MachineLockSchema>;

/** A lock file that is still empty or partial this long after creation is abandoned. */
const UNREADABLE_LOCK_STALE_MS = 2000;
const MAX_ATTEMPTS = 3;

export type AcquireResult =
  | { acquired: true; lock: MachineLock; cleared?: MachineLock }
  | { acquired: false; holder?: MachineLock };

interface LockOptions {
  /** The trusted home's real path (see `trustedHome`). */
  home: string;
}

/**
 * Takes the machine-wide run lock at `$UFO_HOME/private/lock` for `runId` by exclusive create.
 * The run's state must exist first: a lock is stale, and is cleared, only when the run holding
 * it is no longer `running` or its state is gone. A `running` run holds the lock even while no
 * worker is alive; `ufo cancel` or `ufo resume` handle it.
 *
 * Limitation: two processes that clear the same stale lock at the same instant can both acquire.
 */
export async function acquireMachineLock(
  options: LockOptions & { runId: string; repoId: string },
): Promise<AcquireResult> {
  const file = machineLockPath(options.home);
  await ensureTrustedDir(options.home, privateRoot(options.home));
  const lock = MachineLockSchema.parse({
    runId: options.runId,
    repoId: options.repoId,
    acquiredAt: new Date().toISOString(),
  });
  let cleared: MachineLock | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await createExclusive(file, `${JSON.stringify(lock, null, 2)}\n`)) {
      return { acquired: true, lock, ...(cleared ? { cleared } : {}) };
    }
    const state = await inspect(options.home, file);
    if (state.kind === "held") {
      return { acquired: false, ...(state.holder ? { holder: state.holder } : {}) };
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
  const file = machineLockPath(options.home);
  const holder = await readLock(file);
  if (holder?.runId !== options.runId) return false;
  await rm(file, { force: true });
  return true;
}

export function readMachineLock(options: LockOptions): Promise<MachineLock | undefined> {
  return readLock(machineLockPath(options.home));
}

async function createExclusive(file: string, text: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof openNoFollow>>;
  try {
    handle = await openNoFollow(file, OPEN_CREATE_EXCLUSIVE);
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
    return MachineLockSchema.parse(JSON.parse(await readTextNoFollow(file)));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

type LockState =
  | { kind: "held"; holder?: MachineLock }
  | { kind: "stale"; holder?: MachineLock }
  | { kind: "gone" };

async function inspect(home: string, file: string): Promise<LockState> {
  let holder: MachineLock;
  try {
    holder = MachineLockSchema.parse(JSON.parse(await readTextNoFollow(file)));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "gone" };
    if (error instanceof TrustError) throw error;
    // Empty or partial: another process may be writing it right now.
    try {
      const { mtimeMs } = await stat(file);
      return Date.now() - mtimeMs > UNREADABLE_LOCK_STALE_MS ? { kind: "stale" } : { kind: "held" };
    } catch (statError) {
      if (isErrno(statError, "ENOENT")) return { kind: "gone" };
      throw statError;
    }
  }
  let value: unknown;
  try {
    value = await readJsonIfExists(
      path.join(runDirFor(home, holder.repoId, holder.runId), RUN_FILE),
    );
  } catch {
    // Unreadable state cannot prove the run ended; the lock stays held.
    return { kind: "held", holder };
  }
  // The run's state is gone.
  if (value === undefined) return { kind: "stale", holder };
  const run = RunRecordSchema.safeParse(value);
  if (!run.success) return { kind: "held", holder };
  if (run.data.status !== "running") return { kind: "stale", holder };
  // A start cut short holds the lock with nothing left to release it.
  return (await abandonedStart(run.data)) ? { kind: "stale", holder } : { kind: "held", holder };
}
