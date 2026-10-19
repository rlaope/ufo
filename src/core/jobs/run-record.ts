import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitShaSchema } from "../../domain/index.js";
import { ensureTrustedDir } from "../paths.js";
import { readJsonIfExists, writeJsonAtomic } from "./atomic-file.js";
import { withLockFile } from "./lock-file.js";
import {
  ARTIFACTS_DIR,
  CONTROL_LOCK_FILE,
  JOBS_DIR,
  LOGS_DIR,
  RUN_FILE,
  RUN_LOCK_FILE,
  RunIdSchema,
  runDirFor,
  runsRoot,
  SAMPLES_DIR,
} from "./paths.js";
import { PgidSchema, StartTimeSchema } from "./process.js";

const IsoSchema = z.iso.datetime({ offset: true });

export const RunStatusSchema = z.enum(["running", "finished", "cancelled", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * The detached worker. It leads its own process group, so its PID is also its group id. The
 * start time identifies the process before anything signals it (PID reuse).
 */
export const WorkerRecordSchema = z.strictObject({
  pid: PgidSchema,
  startTime: StartTimeSchema,
  launchedAt: IsoSchema,
  /** Set by the worker when it exits normally (no jobs left, or cancelled). */
  exitedAt: IsoSchema.optional(),
});
export type WorkerRecord = z.infer<typeof WorkerRecordSchema>;

/** A child process group the worker started (a server, a load generator, a build). */
export const ChildGroupSchema = z.strictObject({
  pgid: PgidSchema,
  /** Start time of the group leader when it was tracked; guards against PID reuse on kill. */
  startTime: StartTimeSchema,
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
  /** Identifies the target repository; also names its state and arms directories. */
  repoId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a path-safe repository id"),
  status: RunStatusSchema,
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
  /** Recorded SHAs of the arms, for status views. Resume resets A to its own HEAD. */
  shas: z
    .strictObject({
      baseline: GitShaSchema.optional(),
      a: GitShaSchema.optional(),
      b: GitShaSchema.optional(),
    })
    .default({}),
  worker: WorkerRecordSchema.optional(),
  ports: z.array(PortSchema).max(1000).default([]),
  containerLabels: z.array(ContainerLabelSchema).max(1000).default([]),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export type RunInit = Pick<z.input<typeof RunRecordSchema>, "runId" | "repoId"> &
  Partial<Pick<z.input<typeof RunRecordSchema>, "shas">>;

/**
 * Creates `$UFO_HOME/private/runs/<repoId>/<runId>/` (mode 0700) with its `run.json` and empty
 * `jobs/`, `samples/`, `artifacts/`, and `logs/` directories. `home` is the trusted home's real
 * path. Fails if the run directory already exists.
 */
export async function createRunState(
  home: string,
  init: RunInit,
  now: Date = new Date(),
): Promise<{ runDir: string; run: RunRecord }> {
  const at = now.toISOString();
  const run = RunRecordSchema.parse({ ...init, status: "running", createdAt: at, updatedAt: at });
  const runDir = runDirFor(home, run.repoId, run.runId);
  await ensureTrustedDir(home, runsRoot(home, run.repoId));
  // Not recursive, so an existing run directory is refused rather than reused.
  await mkdir(runDir, { mode: 0o700 });
  for (const dir of [JOBS_DIR, SAMPLES_DIR, ARTIFACTS_DIR, LOGS_DIR]) {
    await mkdir(path.join(runDir, dir), { mode: 0o700 });
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
export async function replaceRun(
  runDir: string,
  run: RunRecord,
  options: { durable?: boolean } = {},
): Promise<RunRecord> {
  const parsed = RunRecordSchema.parse({ ...run, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(runDir, RUN_FILE), parsed, options);
  return parsed;
}

/**
 * Read-modify-write of `run.json` under the run lock, so concurrent updates are not lost.
 * `durable: false` skips the fsyncs (see `writeFileAtomic`).
 */
export function updateRun(
  runDir: string,
  mutate: (run: RunRecord) => RunRecord,
  options: { durable?: boolean } = {},
): Promise<RunRecord> {
  return withRunLock(runDir, async () =>
    replaceRun(runDir, mutate(await readRun(runDir)), options),
  );
}

/**
 * Runs `fn` while holding `run.lock`. The worker, the CLI, and the MCP server all mutate one run
 * directory, and these critical sections are a few file operations long.
 */
export function withRunLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  return withLockFile(path.join(runDir, RUN_LOCK_FILE), { timeoutMs: 10_000, retryMs: 10 }, fn);
}

/**
 * Runs `fn` while holding `control.lock`: launching a worker, resume, cancel, finish, and the
 * calls that queue work take turns, so two of them never act on one run at once. Never taken
 * inside `withRunLock`.
 */
export function withControlLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  return withLockFile(
    path.join(runDir, CONTROL_LOCK_FILE),
    { timeoutMs: 120_000, retryMs: 25 },
    fn,
  );
}
