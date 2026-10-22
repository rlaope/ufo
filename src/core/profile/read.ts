import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProfileFormat } from "../../domain/index.js";
import { createTextRedactor } from "../evidence/index.js";
import { assertRealDir, isErrno } from "../jobs/index.js";
import { parseCollapsed } from "./collapsed.js";
import { parseCpuprofile } from "./cpuprofile.js";
import { parsePprof } from "./pprof.js";
import { parseSpeedscope } from "./speedscope.js";
import {
  type FileHotspots,
  heaviestFiles,
  invalid,
  type NameRedactor,
  type Parsed,
  summarize,
} from "./summary.js";

/** Bytes read of one profile file; a larger file is refused unread. */
export const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
/** Files read of one profile directory, the largest first; the others are counted unread. */
export const MAX_PROFILE_FILES_READ = 16;

const PARSERS: Record<Exclude<ProfileFormat, "pprof">, (text: string) => Parsed> = {
  collapsed: parseCollapsed,
  cpuprofile: parseCpuprofile,
  speedscope: parseSpeedscope,
};

/**
 * The hot spots of one file in `format`, from its bytes or its text; never throws for what the
 * file holds. `pprof` is binary; the other formats are UTF-8 text.
 */
export function summarizeProfile(
  file: string,
  content: string | Buffer,
  format: ProfileFormat,
  prefixes: readonly string[] = [],
  redact?: NameRedactor,
): FileHotspots {
  if (format === "pprof") {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return summarize(file, parsePprof(bytes), prefixes, redact);
  }
  const text = typeof content === "string" ? content : content.toString("utf8");
  // Without a byte order mark.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return summarize(file, PARSERS[format](body), prefixes, redact);
}

async function readCapped(file: string): Promise<Buffer | Parsed> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Non-blocking, so a FIFO that took the file's place since its lstat never blocks the open;
    // the stat below refuses it.
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isErrno(error, "ELOOP")) return invalid("a symbolic link; UFO does not follow it");
    return invalid(`cannot be read: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return invalid("not a regular file");
    if (info.size > MAX_PROFILE_BYTES) {
      return invalid(`larger than ${MAX_PROFILE_BYTES / 1024 / 1024} MiB`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * The hot spots of the files a profiler wrote into `dir` (a real directory, never followed
 * through a symlink): at most `MAX_PROFILE_FILES_READ` regular files read, the largest first,
 * each at most `MAX_PROFILE_BYTES`, then the heaviest kept as `heaviestFiles` keeps them. A
 * file that is not a profile in `format` is reported with its reason; no file fails the read.
 * A directory the workload removed holds no files.
 */
export async function readProfileDir(
  dir: string,
  format: ProfileFormat,
  prefixes: readonly string[] = [],
  redact: NameRedactor = createTextRedactor({}),
): Promise<{ files: FileHotspots[]; omitted: number }> {
  let names: string[];
  try {
    await assertRealDir(dir);
    names = await readdir(dir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { files: [], omitted: 0 };
    throw error;
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const info = await lstat(path.join(dir, name)).catch(() => undefined);
      return { name, info, size: info?.isFile() === true ? info.size : -1 };
    }),
  );
  entries.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: FileHotspots[] = [];
  for (const { name, info } of entries.slice(0, MAX_PROFILE_FILES_READ)) {
    // Only a regular file is opened: opening a FIFO with no writer would wait forever.
    const read =
      info === undefined
        ? invalid("gone before it was read")
        : info.isSymbolicLink()
          ? invalid("a symbolic link; UFO does not follow it")
          : !info.isFile()
            ? invalid("not a regular file")
            : await readCapped(path.join(dir, name));
    files.push(
      Buffer.isBuffer(read)
        ? summarizeProfile(name, read, format, prefixes, redact)
        : summarize(name, read, prefixes, redact),
    );
  }
  return heaviestFiles(files, Math.max(0, entries.length - MAX_PROFILE_FILES_READ));
}
