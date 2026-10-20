import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SetupError } from "./errors.js";

// Reading and writing files for setup. A host's config belongs to the user: a symbolic link to it
// (a dotfiles checkout) is followed and stays a link, and the file keeps its mode. UFO's own
// record and backups are opened without following a link. Text is decoded strictly, so writing
// it back reproduces every byte setup did not edit. Every write goes to a temp file that is
// fsynced and renamed into place, and the directory is fsynced after.

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The npm form of a sha512 digest (`sha512-<base64>`), as lockfiles and the registry give it. */
export function integrityOf(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

/** The file's text, or `undefined` when it does not exist. Refuses one that is not UTF-8. */
export async function readConfig(file: string, label: string): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new SetupError("host_config_invalid", `${label} is not UTF-8 text`);
  }
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms cannot fsync a directory; the rename is still atomic.
  }
}

/** Writes `text` to a new temp file next to `target`, fsynced, and renames it over `target`. */
async function replaceFile(target: string, text: string, mode: number): Promise<void> {
  const temp = `${target}.ufo-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(text);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDir(path.dirname(target));
}

/**
 * Replaces a host config at its real path, keeping its mode. A new file gets mode 0600, and
 * missing directories are created 0700.
 */
export async function writeConfig(file: string, text: string): Promise<void> {
  let target = file;
  let mode = 0o600;
  try {
    target = await realpath(file);
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  await replaceFile(target, text, mode);
}

/** Removes a host config setup created. */
export async function removeConfig(file: string): Promise<void> {
  await rm(file, { force: true });
  await syncDir(path.dirname(file));
}

/** One of UFO's own files (0600), written without following a link at its path. */
export async function writePrivate(file: string, text: string): Promise<void> {
  await replaceFile(file, text, 0o600);
}

/** One of UFO's own files, opened without following a link; `undefined` when missing. */
export async function readPrivate(file: string): Promise<string | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    if (isErrno(error, "ELOOP")) {
      throw new SetupError("unsafe_state", `${file} is a symbolic link; UFO does not follow it`);
    }
    throw error;
  }
}

/** Whether `file` exists, without following a link at its path. */
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
