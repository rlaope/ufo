import { link, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isErrno, OPEN_CREATE_EXCLUSIVE, OPEN_READ, openNoFollow } from "./atomic-file.js";
import { isPidAlive, PidSchema, readProcessStartTime, StartTimeSchema } from "./process.js";

/** A lock file whose holder never wrote its record (crash right after create) is stale after this. */
const UNREADABLE_STALE_MS = 2000;

/** A takeover claim lasts a few file operations; one this old was left by a taker that died. */
const ABANDONED_CLAIM_MS = 2000;

/** What a lock file holds: its holder, and that process's start time when `ps` can tell. */
const LockHolderSchema = z.strictObject({ pid: PidSchema, startTime: StartTimeSchema.optional() });

/** A lock file's holder did not let go within the wait; the same call may succeed later. */
export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
  readonly file: string;

  constructor(file: string) {
    super(`timed out waiting for ${file}`);
    this.file = file;
  }
}

export interface LockFileOptions {
  /** How long to wait for the holder before giving up. */
  readonly timeoutMs: number;
  readonly retryMs: number;
}

let ownRecord: Promise<string> | undefined;

/** This process's lock record. Its start time is read once. */
function lockRecord(): Promise<string> {
  ownRecord ??= readProcessStartTime(process.pid).then((startTime) =>
    JSON.stringify({ pid: process.pid, ...(startTime === undefined ? {} : { startTime }) }),
  );
  return ownRecord;
}

/**
 * Runs `fn` while holding `file`, created exclusively (never through a symlink) and holding the
 * holder's PID and start time. A lock whose holder is dead, or whose PID now belongs to a process
 * that started at another time, is taken over; a lock of the old shape (a bare PID) is judged by
 * the PID alone. Throws `LockTimeoutError` when the holder keeps it past `timeoutMs`.
 *
 * A takeover first claims the stale lock by hard-linking it to a name made from its inode. The
 * link is exclusive, so of the processes that judged one lock stale only one removes it, and that
 * one judges the linked file again (it may be a newer lock) first.
 *
 * Limitation: a taker that died holding a claim leaves it behind; it is cleared after
 * `ABANDONED_CLAIM_MS`, and two processes that clear the same abandoned claim at the same instant
 * can both take the lock over.
 */
export async function withLockFile<T>(
  file: string,
  options: LockFileOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  // Records whose holder this call found alive with its recorded start time: `ps` runs once per
  // holder, not on every retry.
  const verified = new Set<string>();
  for (;;) {
    try {
      const handle = await openNoFollow(file, OPEN_CREATE_EXCLUSIVE);
      try {
        await handle.writeFile(await lockRecord());
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const seen = await inspect(file, verified);
    // Released between our create attempt and the read: try again.
    if (seen === undefined) continue;
    if (seen.stale && (await takeOver(file, seen.ino, verified))) continue;
    if (Date.now() > deadline) throw new LockTimeoutError(file);
    await delay(options.retryMs);
  }
  try {
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Removes the stale lock `file` if it still is inode `ino` and this call wins the claim on it.
 * Returns whether to try again at once (`false`: another taker holds the claim).
 */
async function takeOver(file: string, ino: number, verified: Set<string>): Promise<boolean> {
  const claim = `${file}.${ino}.takeover`;
  try {
    await link(file, claim);
  } catch (error) {
    // The lock is gone.
    if (isErrno(error, "ENOENT")) return true;
    if (!isErrno(error, "EEXIST")) throw error;
    let ctimeMs: number;
    try {
      ({ ctimeMs } = await stat(claim));
    } catch (statError) {
      if (isErrno(statError, "ENOENT")) return true;
      throw statError;
    }
    if (Date.now() - ctimeMs <= ABANDONED_CLAIM_MS) return false;
    await rm(claim, { force: true });
    return true;
  }
  try {
    const linked = await inspect(claim, verified);
    // Only the holder of this claim removes inode `ino`, so `file` is still it at the `rm`.
    if (linked?.ino === ino && linked.stale) await rm(file, { force: true });
  } finally {
    await rm(claim, { force: true });
  }
  return true;
}

async function inspect(
  file: string,
  verified: Set<string>,
): Promise<{ ino: number; stale: boolean } | undefined> {
  let ino: number;
  let mtimeMs: number;
  let text: string;
  try {
    const handle = await openNoFollow(file, OPEN_READ);
    try {
      ({ ino, mtimeMs } = await handle.stat());
      text = (await handle.readFile("utf8")).trim();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return { ino, stale: await isStale(text, mtimeMs, verified) };
}

async function isStale(text: string, mtimeMs: number, verified: Set<string>): Promise<boolean> {
  // The old shape, a bare PID.
  const bare = /^\d+$/.test(text) ? PidSchema.safeParse(Number(text)) : undefined;
  if (bare?.success) return !isPidAlive(bare.data);
  let holder: z.infer<typeof LockHolderSchema>;
  try {
    holder = LockHolderSchema.parse(JSON.parse(text));
  } catch {
    // Empty or partial: its holder may be writing it right now.
    return Date.now() - mtimeMs > UNREADABLE_STALE_MS;
  }
  if (!isPidAlive(holder.pid)) return true;
  if (holder.startTime === undefined || verified.has(text)) return false;
  const current = await readProcessStartTime(holder.pid);
  // Unknown (it just exited, or `ps` failed): a later retry decides.
  if (current === undefined) return false;
  if (current !== holder.startTime) return true;
  verified.add(text);
  return false;
}
