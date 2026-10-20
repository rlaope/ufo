import type { Dirent } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isErrno, sha256 } from "./files.js";
import { SKILL_NAME } from "./hosts.js";

// The skill directory setup installs into each host (Claude Code: ~/.claude/skills; Codex and
// Cursor: ~/.agents/skills). A directory is compared by the sha256 of each regular file in it,
// by its path relative to the directory; anything else in it (a link, a socket) never matches.
// Finder's `.DS_Store` files are not part of a skill and are ignored.

export type FileHashes = Record<string, string>;

const IGNORED = new Set([".DS_Store"]);

async function entriesOf(dir: string): Promise<Dirent[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => !entry.isDirectory() && !IGNORED.has(entry.name));
}

const relativeName = (dir: string, entry: Dirent) =>
  path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");

/** The skill's files in `dir`, by relative POSIX path; it must hold a SKILL.md. */
export async function readSkillSource(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await entriesOf(dir)) {
    if (!entry.isFile()) continue;
    files.set(relativeName(dir, entry), await readFile(path.join(entry.parentPath, entry.name)));
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
    entries = await entriesOf(dir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const hashes: FileHashes = {};
  for (const entry of entries) {
    hashes[relativeName(dir, entry)] = entry.isFile()
      ? sha256(await readFile(path.join(entry.parentPath, entry.name)))
      : "not a regular file";
  }
  return hashes;
}

export function sameFiles(a: FileHashes, b: FileHashes): boolean {
  return isDeepStrictEqual(a, b);
}

/** The first file that tells `current` from `expected`, e.g. `notes.md was added`. */
export function firstDifference(current: FileHashes, expected: FileHashes): string | undefined {
  for (const name of [...new Set([...Object.keys(current), ...Object.keys(expected)])].sort()) {
    if (!(name in expected)) return `${name} was added`;
    if (!(name in current)) return `${name} is missing`;
    if (current[name] !== expected[name]) return `${name} differs`;
  }
  return undefined;
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
