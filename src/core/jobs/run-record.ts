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
import { isPidAlive, PgidSchema, readProcessStartTime, StartTimeSchema } from "./process.js";

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
  /**
   * The real top level of the work tree whose start created the run: linked worktrees share the
   * repository id, and each acts only on its own runs.
   */
  repoRoot: z.string().min(1).max(4096).optional(),
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
  /** The process that is creating the run, until `started`: a start cut short has no worker. */
  starter: z.strictObject({ pid: PgidSchema, startTime: StartTimeSchema }).optional(),
  /** Set once the run's app state is written and its worker can be launched. */
  started: z.boolean().default(false),
  ports: z.array(PortSchema).max(1000).default([]),
  containerLabels: z.array(ContainerLabelSchema).max(1000).default([]),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export type RunInit = Pick<z.input<typeof RunRecordSchema>, "runId" | "repoId"> &
  Partial<Pick<z.input<typeof RunRecordSchema>, "shas" | "repoRoot">>;

/**
 * Creates `$UFO_HOME/private/runs/<repoId>/<runId>/` (mode 0700) with its `run.json` and empty
 * `jobs/`, `samples/`, `artifacts/`, and `logs/` directories. `home` is the trusted home's real
 * path. Fails if the run directory already exists.
 */
export async function createRunState(
  home: string,
  init: RunInit,
  now: Date = new Date(),
  startTimeOf: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<{ runDir: string; run: RunRecord }> {
  const at = now.toISOString();
  const startTime = await startTimeOf(process.pid);
  if (startTime === undefined) {
    // Without it, a start in progress could not be told from one cut short (`abandonedStart`),
    // and another start or a cancel would end it while it creates the arms.
    throw new Error("could not read this process's start time (ps); no run was created");
  }
  const run = RunRecordSchema.parse({
    ...init,
    status: "running",
    createdAt: at,
    updatedAt: at,
    starter: { pid: process.pid, startTime },
  });
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

/**
 * Moves a run out of `running` to `status`, and only out of `running`: a cancel and a finish that
 * race cannot overwrite each other's result. Returns whether this call ended the run.
 */
export async function endRun(
  runDir: string,
  status: Exclude<RunStatus, "running">,
): Promise<boolean> {
  let ended = false;
  await updateRun(runDir, (run) => {
    if (run.status !== "running") return run;
    ended = true;
    return { ...run, status };
  });
  return ended;
}

/**
 * A start that was cut short (the process died between creating the run state and finishing
 * the start): still `running`, never `started`, and its starter is gone. Nothing will finish it.
 */
export async function abandonedStart(run: RunRecord): Promise<boolean> {
  if (run.status !== "running" || run.started) return false;
  const { starter } = run;
  if (starter === undefined || !isPidAlive(starter.pid)) return true;
  const current = await readProcessStartTime(starter.pid);
  return current !== undefined && current !== starter.startTime;
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
 * calls that queue work take turns, so two of them never act on one run at once. Waits at most
 * `waitMs` for another holder (`LockTimeoutError`). Never taken inside `withRunLock`.
 */
export function withControlLock<T>(
  runDir: string,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withLockFile(path.join(runDir, CONTROL_LOCK_FILE), { timeoutMs: waitMs, retryMs: 25 }, fn);
}
