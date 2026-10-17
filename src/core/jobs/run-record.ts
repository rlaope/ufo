import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { GitShaSchema } from "../../domain/index.js";
import { isErrno, readJsonIfExists, writeJsonAtomic } from "./atomic-file.js";
import {
  ARTIFACTS_DIR,
  JOBS_DIR,
  LOGS_DIR,
  RUN_FILE,
  RUN_LOCK_FILE,
  RunIdSchema,
  runDirFor,
  runsRoot,
  SAMPLES_DIR,
} from "./paths.js";
import { isPidAlive, PgidSchema, StartTimeSchema } from "./process.js";

const IsoSchema = z.iso.datetime({ offset: true });
const AbsolutePathSchema = z
  .string()
  .max(4096)
  .refine((p) => path.isAbsolute(p), "must be an absolute path");

export const RunStatusSchema = z.enum(["running", "finished", "cancelled", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** The detached worker. It leads its own process group, so its PID is also its group id. */
export const WorkerRecordSchema = z.strictObject({
  pid: PgidSchema,
  startTime: StartTimeSchema.optional(),
  launchedAt: IsoSchema,
  /** Set by the worker when it exits normally (no jobs left, or cancelled). */
  exitedAt: IsoSchema.optional(),
});
export type WorkerRecord = z.infer<typeof WorkerRecordSchema>;

/** A child process group the worker started (a server, a load generator, a build). */
export const ChildGroupSchema = z.strictObject({
  pgid: PgidSchema,
  /** Start time of the group leader when it was tracked; guards against PID reuse on kill. */
  startTime: StartTimeSchema.optional(),
});
export type ChildGroup = z.infer<typeof ChildGroupSchema>;

export const PortSchema = z.number().int().min(1).max(65_535);

/** A Docker label `key=value`. UFO only ever removes containers carrying its own run label. */
export const ContainerLabelSchema = z
  .string()
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._-]*=[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a key=value label");

export const RunRecordSchema = z.strictObject({
  runId: RunIdSchema,
  /** Identifies the target repository; also names its worktree directory under `$UFO_HOME`. */
  repoId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a path-safe repository id"),
  status: RunStatusSchema,
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
  /** The run branch, `ufo/run-<ts>`. */
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\p{Cc}\s]+$/u)
    .optional(),
  /** Recorded SHAs: resume resets each worktree to its arm's SHA. */
  shas: z
    .strictObject({
      baseline: GitShaSchema.optional(),
      a: GitShaSchema.optional(),
      b: GitShaSchema.optional(),
    })
    .default({}),
  arms: z.strictObject({ a: AbsolutePathSchema, b: AbsolutePathSchema }).optional(),
  worker: WorkerRecordSchema.optional(),
  childGroups: z.array(ChildGroupSchema).max(10_000).default([]),
  ports: z.array(PortSchema).max(1000).default([]),
  containerLabels: z.array(ContainerLabelSchema).max(1000).default([]),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export type RunInit = Pick<z.input<typeof RunRecordSchema>, "runId" | "repoId"> &
  Partial<Pick<z.input<typeof RunRecordSchema>, "branch" | "shas" | "arms">>;

/**
 * Creates `<commonDir>/ufo/runs/<runId>/` with its `run.json` and empty `jobs/`, `samples/`,
 * `artifacts/`, and `logs/` directories. Fails if the run directory already exists.
 */
export async function createRun(
  commonDir: string,
  init: RunInit,
  now: Date = new Date(),
): Promise<{ runDir: string; run: RunRecord }> {
  const at = now.toISOString();
  const run = RunRecordSchema.parse({ ...init, status: "running", createdAt: at, updatedAt: at });
  const runDir = runDirFor(commonDir, run.runId);
  await mkdir(runsRoot(commonDir), { recursive: true });
  await mkdir(runDir);
  for (const dir of [JOBS_DIR, SAMPLES_DIR, ARTIFACTS_DIR, LOGS_DIR]) {
    await mkdir(path.join(runDir, dir));
  }
  await writeJsonAtomic(path.join(runDir, RUN_FILE), run);
  return { runDir, run };
}

export async function readRun(runDir: string): Promise<RunRecord> {
  const value = await readJsonIfExists(path.join(runDir, RUN_FILE));
  if (value === undefined) throw new Error(`no ${RUN_FILE} in ${runDir}`);
  return RunRecordSchema.parse(value);
}

/** Writes `run` as-is. The caller must hold the run lock (see `withRunLock`). */
export async function replaceRun(runDir: string, run: RunRecord): Promise<RunRecord> {
  const parsed = RunRecordSchema.parse({ ...run, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(runDir, RUN_FILE), parsed);
  return parsed;
}

/** Read-modify-write of `run.json` under the run lock, so concurrent updates are not lost. */
export function updateRun(
  runDir: string,
  mutate: (run: RunRecord) => RunRecord,
): Promise<RunRecord> {
  return withRunLock(runDir, async () => replaceRun(runDir, mutate(await readRun(runDir))));
}

const RUN_LOCK_TIMEOUT_MS = 10_000;
const RUN_LOCK_RETRY_MS = 10;
/** A lock file whose holder never wrote its PID (crash right after create) is stale after this. */
const RUN_LOCK_UNREADABLE_STALE_MS = 2000;

/**
 * Runs `fn` while holding `run.lock`, a file created with `wx` that holds the holder's PID.
 * The worker, the CLI, and the MCP server all mutate one run directory, and critical sections
 * are a few file operations long. A lock whose holder PID is dead is taken over.
 *
 * Limitation: two processes that both find the same stale lock at the same instant can both
 * take it over. A stale run lock only exists after a process died inside a critical section.
 */
export async function withRunLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = path.join(runDir, RUN_LOCK_FILE);
  const deadline = Date.now() + RUN_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    if (await isRunLockStale(lockFile)) {
      await rm(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockFile}`);
    await delay(RUN_LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}

async function isRunLockStale(lockFile: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(lockFile, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) return !isPidAlive(pid);
    const { mtimeMs } = await stat(lockFile);
    return Date.now() - mtimeMs > RUN_LOCK_UNREADABLE_STALE_MS;
  } catch (error) {
    // Released between our create attempt and this read: try again.
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
