import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ensureTrustedDir,
  LockTimeoutError,
  PRIVATE_DIR,
  trustedHome,
  withLockFile,
} from "../app/api-cli.js";
import { SetupError } from "./errors.js";
import { readPrivate, sha256, writePrivate } from "./files.js";
import { HOST_IDS, type HostId } from "./hosts.js";
import { isExactVersion } from "./package.js";

// What setup wrote, kept in UFO's trusted home: `$UFO_HOME/private/setup/setup.json`, and
// `backups/<host>-<file name>`, each edited file as it was before setup's first write to it.
// The packages hosts start live in `$UFO_HOME/pkg/<version>`. Uninstall acts only on what the
// record names. Each change is recorded before the write it describes (`pending`), so a crash in
// between leaves an entry UFO still recognizes as its own.

const SETUP_DIR = "setup";
const PKG_DIR = "pkg";
const RECORD_FILE = "setup.json";
const BACKUPS_DIR = "backups";
const LOCK_FILE = "setup.lock";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
/** An exact `ufo-agents` version: it names a directory under `$UFO_HOME/pkg`. */
const VersionSchema = z.string().refine(isExactVersion, "must be an exact version");
const HostIdSchema = z.enum(HOST_IDS);
const EntrySchema = z.record(z.string(), z.unknown());

const FileStateSchema = z.strictObject({
  /** sha256 of the file before setup's first write; `null` when setup created it. */
  before: Sha256Schema.nullable(),
  /** sha256 of the file as setup last wrote it. */
  after: Sha256Schema,
  /** Nothing but setup wrote the file since the backup: uninstall may restore the backup. */
  untouched: z.boolean(),
  /** Setup's own edit, reversed exactly at uninstall when the host left those bytes alone. */
  edit: z.strictObject({ replaced: z.string(), inserted: z.string() }).nullable(),
  /** Setup added the servers object itself (Cursor's `mcpServers`). */
  parentCreated: z.boolean(),
});

const HostRecordSchema = z.strictObject({
  /** The host config file the entry is in. */
  path: z.string(),
  /** The `ufo-agents` version the entry starts. */
  version: VersionSchema,
  /** The `ufo` entry as setup last wrote it. */
  entry: EntrySchema,
  /** An entry being written: until the write is confirmed, either one is UFO's. */
  pending: z.strictObject({ version: VersionSchema, entry: EntrySchema }).optional(),
  /** Present for the config files setup edits itself (Codex, Cursor). */
  file: FileStateSchema.optional(),
});

const SkillRecordSchema = z.strictObject({
  /** sha256 of each installed file, by path relative to the skill directory. */
  files: z.record(z.string(), Sha256Schema),
  /** Files being installed: until the install is confirmed, either set is UFO's. */
  pending: z.record(z.string(), Sha256Schema).optional(),
  /** The hosts set up with this skill directory (Codex and Cursor share one). */
  hosts: z.array(HostIdSchema),
  /** The `ufo-agents` version the files are from. */
  version: VersionSchema,
});

const PackageRecordSchema = z.strictObject({
  source: z.enum(["registry", "tarball"]),
  /** sha512 of the package tarball, in npm's form. */
  integrity: z.string(),
  /** `--package`: the tarball installed. */
  tarball: z.string().optional(),
});

const SetupRecordSchema = z.strictObject({
  version: z.literal(1),
  hosts: z.partialRecord(HostIdSchema, HostRecordSchema),
  skills: z.record(z.string(), SkillRecordSchema),
  /** Installed copies, by version. */
  packages: z.record(VersionSchema, PackageRecordSchema),
});

export type FileState = z.infer<typeof FileStateSchema>;
export type HostRecord = z.infer<typeof HostRecordSchema>;
export type SetupRecord = z.infer<typeof SetupRecordSchema>;

export interface Store {
  /** UFO's home, checked and real. */
  readonly home: string;
  /** `$UFO_HOME/private/setup`. */
  readonly dir: string;
  /** `$UFO_HOME/pkg`. */
  readonly pkgRoot: string;
}

/**
 * Checks `$UFO_HOME` and creates (0700) `private/setup/backups` and `pkg` under it. A home inside
 * any of `outside` (the working directory's project, as the PATH filter finds it) is refused
 * (`unsafe_home`): what hosts start would live in a repository.
 */
export async function openStore(ufoHome: string, outside: readonly string[]): Promise<Store> {
  const home = await trustedHome(ufoHome, { outside });
  const dir = path.join(home, PRIVATE_DIR, SETUP_DIR);
  const pkgRoot = path.join(home, PKG_DIR);
  await ensureTrustedDir(home, backupsDir(dir));
  await ensureTrustedDir(home, pkgRoot);
  return { home, dir, pkgRoot };
}

/** Runs `fn` while no other setup, uninstall, or update runs; `busy` after `waitMs`. */
export async function withSetupLock<T>(
  dir: string,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = path.join(dir, LOCK_FILE);
  try {
    return await withLockFile(lock, { timeoutMs: waitMs, retryMs: 100 }, fn);
  } catch (error) {
    if (!(error instanceof LockTimeoutError) || error.file !== lock) throw error;
    throw new SetupError(
      "busy",
      "another ufo setup, uninstall, or update is running",
      "wait for it to finish, then run this command again",
    );
  }
}

export function emptyRecord(): SetupRecord {
  return { version: 1, hosts: {}, skills: {}, packages: {} };
}

export async function readRecord(dir: string): Promise<SetupRecord> {
  const file = path.join(dir, RECORD_FILE);
  const text = await readPrivate(file);
  if (text === undefined) return emptyRecord();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = SetupRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SetupError(
      "unsafe_state",
      `${file} does not validate; UFO cannot tell what setup wrote`,
    );
  }
  return parsed.data;
}

/** Saves the record (durably); an empty one is removed. */
export async function writeRecord(dir: string, record: SetupRecord): Promise<void> {
  const file = path.join(dir, RECORD_FILE);
  const empty =
    Object.keys(record.hosts).length === 0 &&
    Object.keys(record.skills).length === 0 &&
    Object.keys(record.packages).length === 0;
  if (empty) {
    await rm(file, { force: true });
    return;
  }
  await writePrivate(file, `${JSON.stringify(record, null, 2)}\n`);
}

export function backupsDir(dir: string): string {
  return path.join(dir, BACKUPS_DIR);
}

export function backupPath(dir: string, host: HostId, file: string): string {
  return path.join(backupsDir(dir), `${host}-${path.basename(file)}`);
}

export async function writeBackup(
  dir: string,
  host: HostId,
  file: string,
  text: string,
): Promise<void> {
  await writePrivate(backupPath(dir, host, file), text);
}

/** The backup's text; refuses (`unsafe_state`) one whose hash is not `expected`. */
export async function readBackup(
  dir: string,
  host: HostId,
  file: string,
  expected: string,
): Promise<string> {
  const backup = backupPath(dir, host, file);
  const text = await readPrivate(backup);
  if (text === undefined || sha256(text) !== expected) {
    throw new SetupError("unsafe_state", `${backup} is not the file setup backed up`);
  }
  return text;
}

export async function removeBackup(dir: string, host: HostId, file: string): Promise<void> {
  await rm(backupPath(dir, host, file), { force: true });
}
