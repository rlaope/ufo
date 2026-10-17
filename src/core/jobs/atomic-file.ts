import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Suffix of in-flight temp files. Directory listings skip them. */
export const TEMP_SUFFIX = ".tmp";

/**
 * Replaces `file` with `text` so that a reader sees the old content or the new content, never a
 * mix: the text goes to a temp file next to it, is fsynced, and is renamed over `file`. A crash
 * before the rename leaves the old file intact plus a stray temp file.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`;
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
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

/** Parsed JSON content of `file`, or `undefined` when it does not exist. */
export async function readJsonIfExists(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return JSON.parse(text);
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
