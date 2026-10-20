// Read-only views of a run: jobs (with long-poll waits), the run, the status, and the report.

import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redact } from "../core/evidence/index.js";
import {
  clampWaitS,
  isPidAlive,
  type JobRecord,
  listJobs,
  MAX_WAIT_S,
  readJob,
  readJsonIfExists,
  readLedger,
  readMachineLock,
  readRun,
  readTextNoFollow,
  runDirFor,
  TERMINAL_JOB_STATUSES,
  waitForJob,
} from "../core/jobs/index.js";
import { isWorkerAlive } from "../worker/index.js";
import { refuseUnstarted } from "./active.js";
import {
  type AppContext,
  homeFor,
  listRunIds,
  locateRun,
  refuseOtherWorkTree,
  repoOf,
} from "./context.js";
import { AppError } from "./errors.js";
import { budgetStatus, latestBaseline } from "./events.js";
import { type DecisionSummary, type RunReport, summarizeDecisions } from "./jobs/index.js";
import { openRun, REPORT_FILE, readAppState, toJson } from "./state.js";

/** How often a wait checks that a worker is still there to finish the job. */
const WORKER_CHECK_S = 1;

/**
 * Between these, a wait checks the worker with a signal-0 probe only; every this many checks
 * it also compares the process start time (`ps`), which costs a process spawn while samples
 * are being timed.
 */
const FULL_WORKER_CHECK_EVERY = 10;

/** A worker found missing is looked for once more after this, in case it is being launched. */
const WORKER_RECHECK_MS = 500;

function workerProcessExists(run: Awaited<ReturnType<typeof readRun>>): boolean {
  const { worker } = run;
  return worker !== undefined && worker.exitedAt === undefined && isPidAlive(worker.pid);
}

/**
 * Throws once no worker is left to finish `job`: the worker crashed or was killed, before or
 * while running it. `worker_not_running` asks for `ufo resume`; a run that is no longer
 * running has nothing to resume (`run_not_active`).
 */
async function requireWorker(
  runDir: string,
  runId: string,
  job: JobRecord,
  full: boolean,
): Promise<JobRecord> {
  const current = await readRun(runDir);
  if (full ? await isWorkerAlive(current) : workerProcessExists(current)) return job;
  await delay(WORKER_RECHECK_MS);
  const latest = await readJob(runDir, job.jobId);
  const run = await readRun(runDir);
  if (TERMINAL_JOB_STATUSES.has(latest.status) || (await isWorkerAlive(run))) return latest;
  if (run.status !== "running") {
    throw new AppError(
      "run_not_active",
      `run ${runId} is ${run.status}; ${job.jobId} will not run`,
    );
  }
  throw new AppError(
    "worker_not_running",
    `the worker of run ${runId} stopped and ${job.jobId} is still ${latest.status}; run ufo resume`,
  );
}

/**
 * Every view below goes through the evidence redactor (security F13): views reach people and, in
 * M2, the agent and its model provider. Raw values stay in the run's trusted ledger and jobs.
 */
function redactView<T>(view: T): T {
  return redact(view);
}

/**
 * `value` redacted except its arm paths, which stay absolute: the agent reads arm A to write its
 * diffs (safety.md R4).
 */
export function redactExceptArms<T extends { arms: { a: string; b: string } }>(value: T): T {
  return { ...redact(value), arms: value.arms };
}

export interface GetJobOptions {
  readonly runId?: string;
  readonly jobId: string;
  readonly waitS?: number;
  /** Ends the wait early with `interrupted`: an MCP client cancelled the call. */
  readonly signal?: AbortSignal;
  /**
   * A change job's `input.diff` replaced by its length (`diffChars`), counted before redaction:
   * the agent wrote it, and it can be large.
   */
  readonly omitDiff?: boolean;
}

function withoutDiff(job: JobRecord): JobRecord {
  const input = job.input as { diff?: unknown } | null;
  if (input === null || typeof input !== "object" || typeof input.diff !== "string") return job;
  const { diff, ...rest } = input;
  return { ...job, input: { ...rest, diffChars: diff.length } as JobRecord["input"] };
}

/**
 * `get_job`: the job once it is terminal, or its current state after `waitS` (≤ 25 s). Ends
 * early with `worker_not_running` when the job is unfinished and no worker is left to run it.
 */
export async function getJob(context: AppContext, options: GetJobOptions): Promise<JobRecord> {
  const job = await pollJob(context, options);
  return redactView(options.omitDiff === true ? withoutDiff(job) : job);
}

async function pollJob(context: AppContext, options: GetJobOptions): Promise<JobRecord> {
  const located = await locateRun(context, options.runId);
  refuseOtherWorkTree(located.runId, (await readAppState(located.runDir)).repoRoot, located.repo);
  const deadline = Date.now() + clampWaitS(options.waitS ?? 0) * 1000;
  let checks = 0;
  try {
    for (;;) {
      const remainingS = Math.max(0, deadline - Date.now()) / 1000;
      const polled = await waitForJob(
        located.runDir,
        options.jobId,
        Math.min(remainingS, WORKER_CHECK_S),
      );
      if (TERMINAL_JOB_STATUSES.has(polled.status)) return polled;
      if (options.signal?.aborted) throw new AppError("interrupted", "the wait was cancelled");
      const full = checks++ % FULL_WORKER_CHECK_EVERY === 0;
      const job = await requireWorker(located.runDir, located.runId, polled, full);
      if (TERMINAL_JOB_STATUSES.has(job.status) || Date.now() >= deadline) return job;
    }
  } catch (error) {
    if (error instanceof Error && /unknown job|must be a job id/.test(error.message)) {
      throw new AppError("usage", `no job ${options.jobId} in run ${located.runId}`);
    }
    throw error;
  }
}

/** Waits for a job to reach a terminal status, one long-poll at a time. */
export async function waitForJobDone(
  context: AppContext,
  runId: string,
  jobId: string,
  onProgress?: (job: JobRecord) => void,
): Promise<JobRecord> {
  for (;;) {
    const job = await getJob(context, { runId, jobId, waitS: MAX_WAIT_S });
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    onProgress?.(job);
  }
}

export interface RunView {
  runId: string;
  status: string;
  purpose: string;
  branch: string;
  createdAt: string;
  arms: { a: string; b: string };
  shas: { baseline: string; a?: string | undefined };
  worker: { pid?: number | undefined; alive: boolean };
  jobs: {
    jobId: string;
    kind: string;
    status: string;
    changeId?: string | undefined;
    progress?: string | undefined;
    error?: string | undefined;
  }[];
  baseline?:
    | { sha: string; median: number; noiseFloor?: number | undefined; refusal?: unknown }
    | undefined;
  /**
   * False once the baseline was refused (noise floor): every change would be refused the same
   * way, so the run can only be finished. `unusableReason` says why.
   */
  usable: boolean;
  unusableReason?: string | undefined;
  decisions: DecisionSummary[];
  budget: {
    maxTechniques: number;
    techniquesTried: number;
    wallClockMinutes: number;
    elapsedMinutes: number;
    exhausted: boolean;
    detail?: string | undefined;
  };
  headline?: string | undefined;
  bundleDir?: string | undefined;
}

/** `get_run`: arm paths, SHAs, jobs, the baseline, decisions, and the budget. */
export async function getRun(
  context: AppContext,
  options: { readonly runId?: string } = {},
): Promise<RunView> {
  const located = await locateRun(context, options.runId);
  const { runDir } = located;
  await refuseUnstarted(located.runId, await readRun(runDir));
  const [run, open, events, jobs] = await Promise.all([
    readRun(runDir),
    openRun(located.home, runDir),
    readLedger(runDir),
    listJobs(runDir),
  ]);
  refuseOtherWorkTree(located.runId, open.state.repoRoot, located.repo);
  const budget = budgetStatus(events, open.config.objective.budget, run.createdAt);
  const baseline = latestBaseline(events);
  const refusal = baseline?.refusal;
  const report = (await readJsonIfExists(path.join(runDir, REPORT_FILE))) as RunReport | undefined;
  return redactExceptArms(
    toJson({
      runId: located.runId,
      status: run.status,
      purpose: open.state.purpose,
      branch: open.git.branch,
      createdAt: run.createdAt,
      arms: { a: open.git.armA, b: open.git.armB },
      shas: { baseline: open.git.baseSha, a: run.shas.a },
      worker: { pid: run.worker?.pid, alive: await isWorkerAlive(run) },
      jobs: jobs.map((job) => ({
        jobId: job.jobId,
        kind: job.kind,
        status: job.status,
        changeId: (job.input as { changeId?: string } | null)?.changeId,
        progress: job.progress?.message,
        error: job.error?.message,
      })),
      baseline:
        baseline === undefined
          ? undefined
          : {
              sha: baseline.sha,
              median: baseline.median,
              noiseFloor: baseline.noiseFloor,
              refusal: baseline.refusal,
            },
      usable: refusal === undefined,
      unusableReason:
        refusal === undefined
          ? undefined
          : `the baseline was refused (${refusal.reason}: ${refusal.detail}); no change can be decided, so finish the run`,
      decisions: summarizeDecisions(events),
      budget: {
        maxTechniques: budget.limits.maxTechniques,
        techniquesTried: budget.counter.techniques,
        wallClockMinutes: budget.limits.wallClockMinutes,
        elapsedMinutes: Math.floor(budget.counter.wallClockMs / 60_000),
        exhausted: budget.violation !== undefined,
        detail: budget.violation?.detail,
      },
      headline: report?.headline,
      bundleDir: report?.bundleDir,
    }),
  );
}

export interface StatusView {
  repoRoot: string;
  /** Every run of the repository; `workTree` names the other work tree that started one. */
  runs: { runId: string; status: string; createdAt: string; workTree?: string }[];
  /** The run holding the machine lock; `thisRepository` tells whether it is one of these runs. */
  lock?: { runId: string; thisRepository: boolean } | undefined;
  current?: RunView | undefined;
  /** Why the named run has no `current`: another work tree started it (code review F5). */
  note?: string | undefined;
}

/**
 * `ufo status`: the repository's runs, those of its other work trees marked, the machine lock,
 * and this work tree's latest (or the named) run.
 */
export async function status(
  context: AppContext,
  options: { readonly runId?: string } = {},
): Promise<StatusView> {
  const repo = await repoOf(context);
  const home = await homeFor(context, repo);
  const ids = await listRunIds(home, repo);
  if (options.runId !== undefined && !ids.includes(options.runId)) {
    throw new AppError("no_run", `no run ${options.runId} in this repository`);
  }
  const runs: StatusView["runs"] = [];
  let latest: string | undefined;
  for (const id of ids) {
    const run = await readRun(runDirFor(home, repo.repoId, id));
    const other =
      run.repoRoot === undefined || run.repoRoot === repo.root ? undefined : run.repoRoot;
    runs.push({
      runId: id,
      status: run.status,
      createdAt: run.createdAt,
      ...(other === undefined ? {} : { workTree: other }),
    });
    if (other === undefined) latest = id;
  }
  const lock = await readMachineLock({ home });
  // A run that never finished starting has no view; it is still listed in `runs`.
  const shown = options.runId ?? latest;
  // A run another work tree started is listed, and only that work tree shows it.
  const elsewhere = runs.find((run) => run.runId === shown)?.workTree;
  const shownStarted =
    shown !== undefined &&
    elsewhere === undefined &&
    (await readRun(runDirFor(home, repo.repoId, shown))).started;
  const current = shownStarted ? await getRun(context, { runId: shown }) : undefined;
  return toJson({
    ...redactView({
      repoRoot: repo.root,
      runs,
      lock:
        lock === undefined
          ? undefined
          : { runId: lock.runId, thisRepository: lock.repoId === repo.repoId },
      note:
        elsewhere === undefined
          ? undefined
          : `run ${shown} was started in the work tree at ${elsewhere}; act on it from there`,
    }),
    // Redacted by getRun, except its arm paths.
    current,
  });
}

/** A finished run's report. */
export type FinishedReport = RunReport & { finished: true };

/** What `report` returns, told apart by `finished`. */
export type ReportResult = FinishedReport | (RunView & { finished: false });

/** `ufo report`: the finished run's report, or what is known so far for an unfinished run. */
export async function report(
  context: AppContext,
  options: { readonly runId?: string } = {},
): Promise<ReportResult> {
  const located = await locateRun(context, options.runId);
  const text = await readTextNoFollow(path.join(located.runDir, REPORT_FILE)).catch(
    () => undefined,
  );
  if (text !== undefined) {
    refuseOtherWorkTree(located.runId, (await readAppState(located.runDir)).repoRoot, located.repo);
    return { ...redactView(JSON.parse(text) as RunReport), finished: true };
  }
  return { ...(await getRun(context, options)), finished: false };
}
