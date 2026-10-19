import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { TrustError } from "../paths.js";

/** Suffix of in-flight temp files. Directory listings skip them. */
export const TEMP_SUFFIX = ".tmp";

// Run state is opened without following a symlink in the last path component, and every
// directory that holds it is checked with `lstat` first: a planted symlink is refused, never
// followed out of the trusted root. Files are created 0600.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export const OPEN_READ = constants.O_RDONLY | NOFOLLOW;
export const OPEN_CREATE_EXCLUSIVE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
export const OPEN_APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;
export const OPEN_READ_APPEND =
  constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;
export const FILE_MODE = 0o600;

/** Throws `unsafe_state` unless `dir` is a real directory (not a symlink to one). */
export async function assertRealDir(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TrustError("unsafe_state", `${dir} is not a real directory`);
  }
}

/**
 * Opens `file` without following a symlink, after checking its directory. A symlink in place of
 * the file is refused as `unsafe_state`.
 */
export async function openNoFollow(
  file: string,
  flags: number,
  mode = FILE_MODE,
): Promise<FileHandle> {
  await assertRealDir(path.dirname(file));
  try {
    return await open(file, flags, mode);
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw new TrustError("unsafe_state", `${file} is a symbolic link; UFO does not follow it`);
    }
    throw error;
  }
}

/** UTF-8 content of `file`, opened without following a symlink. */
export async function readTextNoFollow(file: string): Promise<string> {
  const handle = await openNoFollow(file, OPEN_READ);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Appends `text` to `file` (created 0600), without following a symlink. */
export async function appendNoFollow(file: string, text: string): Promise<void> {
  const handle = await openNoFollow(file, OPEN_APPEND);
  try {
    await handle.write(text);
  } finally {
    await handle.close();
  }
}

/**
 * Replaces `file` with `text` so that a reader sees the old content or the new content, never a
 * mix: the text goes to a new temp file next to it (exclusive create, never through a symlink),
 * is fsynced, and is renamed over `file`. A crash before the rename leaves the old file intact
 * plus a stray temp file.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`;
  try {
    const handle = await openNoFollow(temp, OPEN_CREATE_EXCLUSIVE);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // rename replaces a symlink at `file` itself; it never writes through it.
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDir(path.dirname(file));
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parsed JSON content of `file`, or `undefined` when it (or its directory) does not exist. */
export async function readJsonIfExists(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readTextNoFollow(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return JSON.parse(text);
}

/** Whether `file` exists. A symlink in its place is refused as `unsafe_state`. */
export async function existsNoFollow(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      throw new TrustError("unsafe_state", `${file} is a symbolic link; UFO does not follow it`);
    }
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

/** Makes a rename durable. Some platforms cannot open or fsync a directory; that is not fatal. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability of the rename is best effort; atomicity does not depend on it.
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
