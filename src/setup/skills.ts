import type { Dirent } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isErrno } from "../core/jobs/index.js";
import { sha256 } from "./files.js";
import { SKILL_NAME } from "./hosts.js";

// The skill directory setup installs into each host (Claude Code: ~/.claude/skills; Codex and
// Cursor: ~/.agents/skills). A directory is compared by the sha256 of each regular file in it,
// by its path relative to the directory; anything else in it (a link, a socket) never matches.

export type FileHashes = Record<string, string>;

/** The skill's files as the package ships them, by relative POSIX path. */
export async function readSkillSource(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, file).split(path.sep).join("/"), await readFile(file));
  }
  if (!files.has("SKILL.md")) throw new Error(`${dir} has no SKILL.md`);
  return files;
}

export function hashFiles(files: ReadonlyMap<string, Buffer>): FileHashes {
  return Object.fromEntries([...files].map(([name, content]) => [name, sha256(content)]));
}

/** The hashes of what is in `dir` now, or `undefined` when it does not exist. */
export async function readSkillHashes(dir: string): Promise<FileHashes | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const hashes: FileHashes = {};
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const name = path.relative(dir, file).split(path.sep).join("/");
    hashes[name] = entry.isFile() ? sha256(await readFile(file)) : "not a regular file";
  }
  return hashes;
}

export function sameFiles(a: FileHashes, b: FileHashes): boolean {
  return isDeepStrictEqual(a, b);
}

/**
 * Writes the skill into a new directory next to `dir` and renames it into place, so a host never
 * sees half a skill. With `replace`, the directory there now (checked by the caller) goes first.
 */
export async function installSkill(
  dir: string,
  files: ReadonlyMap<string, Buffer>,
  replace: boolean,
): Promise<void> {
  const parent = path.dirname(dir);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(path.join(parent, `.${SKILL_NAME}-`));
  try {
    for (const [name, content] of files) {
      const file = path.join(temp, ...name.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await chmod(temp, 0o755);
    if (replace) await rm(dir, { recursive: true, force: true });
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function removeSkill(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
