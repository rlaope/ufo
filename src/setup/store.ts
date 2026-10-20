import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  readJsonIfExists,
  readTextNoFollow,
  withLockFile,
  writeFileAtomic,
  writeJsonAtomic,
} from "../core/jobs/index.js";
import { ensureTrustedDir, PRIVATE_DIR, trustedHome } from "../core/paths.js";
import { Sha256HexSchema } from "../domain/index.js";
import { SetupError } from "./errors.js";
import { sha256 } from "./files.js";
import { HOST_IDS, type HostId } from "./hosts.js";

// What setup wrote, kept in UFO's trusted home: `$UFO_HOME/private/setup/setup.json`, and
// `backups/<host>-<file name>`, each edited file as it was before setup's first write to it.
// Uninstall acts only on what this record names.

const SETUP_DIR = "setup";
const RECORD_FILE = "setup.json";
const BACKUPS_DIR = "backups";
const LOCK_FILE = "setup.lock";

const HostIdSchema = z.enum(HOST_IDS);

const FileStateSchema = z.strictObject({
  /** sha256 of the file before setup's first write; `null` when setup created it. */
  before: Sha256HexSchema.nullable(),
  /** sha256 of the file as setup last wrote it. */
  after: Sha256HexSchema,
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
  /** The `ufo` entry as setup last wrote it. */
  entry: z.record(z.string(), z.unknown()),
  /** Present for the config files setup edits itself (Codex, Cursor). */
  file: FileStateSchema.optional(),
});

const SkillRecordSchema = z.strictObject({
  /** sha256 of each installed file, by path relative to the skill directory. */
  files: z.record(z.string(), Sha256HexSchema),
  /** The hosts set up with this skill directory (Codex and Cursor share one). */
  hosts: z.array(HostIdSchema),
});

const SetupRecordSchema = z.strictObject({
  version: z.literal(1),
  hosts: z.partialRecord(HostIdSchema, HostRecordSchema),
  skills: z.record(z.string(), SkillRecordSchema),
});

export type FileState = z.infer<typeof FileStateSchema>;
export type SetupRecord = z.infer<typeof SetupRecordSchema>;

/** `$UFO_HOME/private/setup`, created (0700) under a checked home. */
export async function openStore(ufoHome: string): Promise<string> {
  const home = await trustedHome(ufoHome);
  const dir = path.join(home, PRIVATE_DIR, SETUP_DIR);
  await ensureTrustedDir(home, backupsDir(dir));
  return dir;
}

/** Runs `fn` while no other setup, uninstall, or update runs. */
export function withSetupLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withLockFile(path.join(dir, LOCK_FILE), { timeoutMs: 10_000, retryMs: 100 }, fn);
}

export async function readRecord(dir: string): Promise<SetupRecord> {
  const raw = await readJsonIfExists(path.join(dir, RECORD_FILE));
  if (raw === undefined) return { version: 1, hosts: {}, skills: {} };
  const parsed = SetupRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SetupError(
      "unsafe_state",
      `${path.join(dir, RECORD_FILE)} does not validate; UFO cannot tell what setup wrote`,
    );
  }
  return parsed.data;
}

/** Saves the record; an empty one is removed. */
export async function writeRecord(dir: string, record: SetupRecord): Promise<void> {
  const file = path.join(dir, RECORD_FILE);
  if (Object.keys(record.hosts).length === 0 && Object.keys(record.skills).length === 0) {
    await rm(file, { force: true });
    return;
  }
  await writeJsonAtomic(file, record);
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
  await writeFileAtomic(backupPath(dir, host, file), text);
}

/** The backup's text; refuses (`unsafe_state`) one whose hash is not `expected`. */
export async function readBackup(
  dir: string,
  host: HostId,
  file: string,
  expected: string,
): Promise<string> {
  const backup = backupPath(dir, host, file);
  const text = await readTextNoFollow(backup);
  if (sha256(text) !== expected) {
    throw new SetupError("unsafe_state", `${backup} is not the file setup backed up`);
  }
  return text;
}

export async function removeBackup(dir: string, host: HostId, file: string): Promise<void> {
  await rm(backupPath(dir, host, file), { force: true });
}
