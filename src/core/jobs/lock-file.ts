import { rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isErrno, OPEN_CREATE_EXCLUSIVE, openNoFollow, readTextNoFollow } from "./atomic-file.js";
import { isPidAlive } from "./process.js";

/** A lock file whose holder never wrote its PID (crash right after create) is stale after this. */
const UNREADABLE_STALE_MS = 2000;

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

/**
 * Runs `fn` while holding `file`, created exclusively (never through a symlink) and holding the
 * holder's PID. A lock whose holder PID is dead is taken over. Throws `LockTimeoutError` when the
 * holder keeps it past `timeoutMs`.
 *
 * Limitation: two processes that both find the same stale lock at the same instant can both
 * take it over. A stale lock only exists after a process died while holding it.
 */
export async function withLockFile<T>(
  file: string,
  options: LockFileOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      const handle = await openNoFollow(file, OPEN_CREATE_EXCLUSIVE);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    if (await isStale(file)) {
      await rm(file, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeoutError(file);
    await delay(options.retryMs);
  }
  try {
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}

async function isStale(file: string): Promise<boolean> {
  try {
    const pid = Number((await readTextNoFollow(file)).trim());
    if (Number.isInteger(pid) && pid > 0) return !isPidAlive(pid);
    const { mtimeMs } = await stat(file);
    return Date.now() - mtimeMs > UNREADABLE_STALE_MS;
  } catch (error) {
    // Released between our create attempt and this read: try again.
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
