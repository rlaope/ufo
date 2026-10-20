import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isErrno } from "../core/jobs/index.js";
import { SetupError } from "./errors.js";

// Reading and writing a host's config file. The file belongs to the user: a symbolic link to it
// (a dotfiles checkout) is followed and stays a link, and the file keeps its mode. Text is
// decoded strictly, so writing it back reproduces every byte setup did not edit.

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
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

/**
 * Replaces the file's content atomically (a temp file renamed over it) at its real path, keeping
 * its mode. A new file gets mode 0600, and missing directories are created 0700.
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
  const temp = `${target}.ufo-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode });
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Removes a file setup created. */
export async function removeConfig(file: string): Promise<void> {
  await rm(file, { force: true });
}
