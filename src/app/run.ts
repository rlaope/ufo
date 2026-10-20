// A run's lifecycle: start, finish, resume, cancel, `ufo measure`, and `ufo run` to the end.

import { lstat, rm } from "node:fs/promises";
import { redact } from "../core/evidence/index.js";
import {
  type CreatedRun,
  createRunArms,
  listChangeIds,
  publishBranch,
  removeRun,
  resetArms,
  runGit,
  runLayout,
} from "../core/git/index.js";
import {
  abandonedStart,
  acquireMachineLock,
  appendLedger,
  cancelJob,
  createRunState,
  endRun,
  enqueueJob,
  type JobRecord,
  JobRecordSchema,
  listJobs,
  readLedger,
  readRun,
  reconcileLedger,
  releaseMachineLock,
  runDirFor,
  TERMINAL_JOB_STATUSES,
  updateRun,
  withControlLock,
  writeJob,
} from "../core/jobs/index.js";
import { newRunId } from "../core/paths.js";
import {
  checkApproval,
  PolicyError,
  resolveAndCheckTarget,
  violation,
} from "../core/policy/index.js";
import { BundleIdSchema, IdSchema, labelSchema } from "../domain/index.js";
import {
  isCancelRequested,
  isWorkerAlive,
  type KillReport,
  killRunProcesses,
  requestCancel,
} from "../worker/index.js";
import { type ActiveRun, activeRun, refuseIfFinishing, rethrowAsUsage } from "./active.js";
import { approvalSubject, loadCards } from "./cards.js";
import { ensureWorkerFor, runRecipes } from "./changes.js";
import { loadConfig } from "./config.js";
import {
  type AppContext,
  controlLockWaitMs,
  homeFor,
  listRunIds,
  locateRun,
  type Repo,
  resolveRepo,
} from "./context.js";
import { captureEnv, captureGitEnv } from "./env.js";
import { AppError } from "./errors.js";
import { committedChangeIds, decisionFor, EVENTS } from "./events.js";
import { type BaselineResult, JOB_KINDS } from "./jobs/index.js";
import { ensureWorker, runInProgress } from "./launch.js";
import { type FinishedReport, redactExceptArms, report, waitForJobDone } from "./queries.js";
import { type AppState, jsonData, openRun, toJson, writeAppState } from "./state.js";

export interface StartRunOptions {
  /** The host agent driving the run, e.g. `claude-code`; `none` for `ufo run`. */
  readonly hostAgent?: string;
  /** The model id the agent reports for itself; recorded as self-reported. */
  readonly modelId?: string;
}

export interface StartRunResult {
  runId: string;
  branch: string;
  baseSha: string;
  arms: { a: string; b: string };
  baselineJobId: string;
  /** Uncommitted changes in the user's tree are not part of the run. */
  userTreeDirty: boolean;
  warnings: string[];
}

/** The network part of a target, which is what gets resolved and checked. */
function targetHost(target: string): string {
  const slash = target.indexOf("/");
  return slash === -1 ? target : target.slice(0, slash);
}

/** `killRunProcesses` options for this context: its injected `docker` runner, if any. */
function killOptions(context: AppContext): { exec?: NonNullable<AppContext["exec"]> } {
  return context.exec ? { exec: context.exec } : {};
}

/**
 * A new run never silently replaces one: a `running` run of this repository refuses the start
 * with `run_in_progress`, saying how to end it: a start still in progress (it becomes a running
 * run, so trying again later is refused as well), a start cut short that the cleanup could not
 * end, and a run with or without a live worker. The cleanup's warnings go with the refusal.
 */
async function refuseActiveRuns(
  home: string,
  repo: Repo,
  warnings: readonly string[],
): Promise<void> {
  for (const id of await listRunIds(home, repo)) {
    const run = await readRun(runDirFor(home, repo.repoId, id));
    if (run.status !== "running") continue;
    const cleanup = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
    if (!run.started && !(await abandonedStart(run))) {
      throw new AppError(
        "run_in_progress",
        `run ${id} of this repository is still starting${cleanup}`,
      );
    }
    const how = !run.started
      ? "did not finish starting; end it with"
      : (await isWorkerAlive(run))
        ? "is still running; finish it, or stop it with"
        : `is still running and its worker stopped; continue it with \`ufo resume --run ${id}\` or stop it with`;
    throw new AppError(
      "run_in_progress",
      `run ${id} of this repository ${how} \`ufo cancel --run ${id}\`${cleanup}`,
    );
  }
}

async function exists(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => undefined)) !== undefined;
}

/**
 * Ends a start that was cut short (see `abandonedStart`): removes the arms it may have created
 * and the run branch if it got that far, records the run as failed, and releases the machine
 * lock. Its run state has no app state, so it is handled from the run id and the repository.
 * Under the run's control lock, so two starts' cleanups or a cancel and a start end it once;
 * returns whether this call did.
 */
async function endAbandonedStart(
  home: string,
  repo: Repo,
  runId: string,
  waitMs: number,
): Promise<boolean> {
  const runDir = runDirFor(home, repo.repoId, runId);
  return withControlLock(runDir, waitMs, async () => {
    if (!(await abandonedStart(await readRun(runDir)))) return false;
    const layout = runLayout(home, repo.repoId, runId);
    const branchHead = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${layout.branch}^{commit}`],
      repo.root,
    );
    const branchSha = branchHead.code === 0 ? branchHead.stdout.trim() : undefined;
    await removeRun(
      { runId, repoId: repo.repoId, repoRoot: repo.root, baseSha: branchSha ?? "", ...layout },
      { deleteBranch: branchSha !== undefined },
    );
    if (!(await endRun(runDir, "failed"))) return false;
    await appendLedger(runDir, { type: EVENTS.startAbandoned, data: { runId } });
    await releaseMachineLock({ runId, home });
    return true;
  });
}

/**
 * Before a start: ends this repository's starts that were cut short, and removes the arms of its
 * ended runs (a run writes its final status before it removes its arms, so a crash in between
 * leaves arms on disk that nothing else would remove). Cleanup that fails is reported as a
 * warning and never blocks the start.
 */
async function cleanUpRuns(home: string, repo: Repo, waitMs: number): Promise<string[]> {
  const warnings: string[] = [];
  for (const id of await listRunIds(home, repo)) {
    try {
      const runDir = runDirFor(home, repo.repoId, id);
      const run = await readRun(runDir);
      if (await abandonedStart(run)) {
        await endAbandonedStart(home, repo, id, waitMs);
        continue;
      }
      if (run.status === "running") continue;
      if (!(await exists(runLayout(home, repo.repoId, id).dir))) continue;
      const open = await openRun(home, runDir);
      await removeRun(open.git, { deleteBranch: open.state.purpose === "measure" });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      warnings.push(`could not clean up run ${id}: ${why}`);
    }
  }
  return warnings;
}

async function startRunFor(
  context: AppContext,
  options: StartRunOptions,
  purpose: AppState["purpose"],
): Promise<StartRunResult & { runDir: string; home: string }> {
  const repo = await resolveRepo(context.cwd);
  const home = await homeFor(context, repo);
  const loaded = await loadConfig(repo.root);
  // The cards as they are now, checked against the approval and captured for the run's jobs.
  const cards = await loadCards(repo.root, context, loaded.config);
  const subject = approvalSubject(loaded.hash, loaded.config, cards);
  const refused = await checkApproval(repo.repoId, subject, { home });
  if (refused !== undefined) throw new PolicyError(refused);
  const targetAddrs: string[] = [];
  for (const target of loaded.config.targets) {
    const pinned = await resolveAndCheckTarget(
      targetHost(target),
      loaded.config.targets,
      context.resolver,
    );
    targetAddrs.push(`${pinned.host}=${pinned.address}`);
  }
  for (const id of loaded.config.cards) {
    if (!cards.has(id)) {
      throw new PolicyError(violation("unknown_card", `ufo.yaml enables unknown card ${id}`, [id]));
    }
  }
  let hostAgent: string;
  let modelId: string | undefined;
  try {
    hostAgent = IdSchema.parse(options.hostAgent ?? "none");
    modelId = options.modelId === undefined ? undefined : labelSchema().parse(options.modelId);
  } catch (error) {
    rethrowAsUsage(error);
  }
  const cleanupWarnings = await cleanUpRuns(home, repo, controlLockWaitMs(context));
  await refuseActiveRuns(home, repo, cleanupWarnings);

  const runId = newRunId();
  // The run's state exists before it takes the machine lock, so another start that finds the
  // lock never mistakes this run for one whose state is gone.
  const { runDir } = await createRunState(home, { runId, repoId: repo.repoId });
  const lock = await acquireMachineLock({ home, runId, repoId: repo.repoId });
  if (!lock.acquired) {
    await rm(runDir, { recursive: true, force: true });
    throw runInProgress(lock.holder);
  }
  let created: CreatedRun | undefined;
  try {
    created = await createRunArms(repo.root, runId, { home });
    const { run } = created;
    await updateRun(runDir, (record) => ({
      ...record,
      shas: { baseline: run.baseSha, a: run.baseSha, b: run.baseSha },
    }));
    const launcherEnv = context.workerEnv ?? process.env;
    const state: AppState = {
      version: 2,
      purpose,
      runId,
      repoId: repo.repoId,
      repoRoot: repo.root,
      baseSha: run.baseSha,
      ...(run.identity === undefined ? {} : { identity: run.identity }),
      cards: [...cards.values()].map(({ source, card }) => ({ source, card })),
      configText: loaded.text,
      configHash: loaded.hash,
      env: captureEnv(launcherEnv, loaded.config.env, [
        repo.root,
        repo.gitDir,
        repo.commonDir,
        home,
      ]),
      gitEnv: captureGitEnv(launcherEnv),
      targetAddrs,
      hostAgent,
      ...(modelId === undefined ? {} : { modelId }),
      bundleId: BundleIdSchema.parse(`ufo-${runId}`),
    };
    await writeAppState(runDir, state);
    await appendLedger(runDir, {
      type: "run_started",
      data: { configHash: loaded.hash, baseSha: run.baseSha, purpose },
    });
    const job = await enqueueJob(runDir, { kind: JOB_KINDS.baseline, input: {} });
    // Started once there is something to resume: a crash before this is a start cut short.
    await updateRun(runDir, (record) => ({ ...record, started: true }));
    await withControlLock(runDir, controlLockWaitMs(context), () =>
      ensureWorker(context, runDir, home, state),
    );
    const warnings = [
      ...cleanupWarnings,
      ...(created.userTreeDirty
        ? ["the working tree has uncommitted changes; they are not part of the run"]
        : []),
    ];
    return {
      runId,
      runDir,
      home,
      branch: run.branch,
      baseSha: run.baseSha,
      arms: { a: run.armA, b: run.armB },
      baselineJobId: job.jobId,
      userTreeDirty: created.userTreeDirty,
      warnings,
    };
  } catch (error) {
    await killRunProcesses(runDir, killOptions(context)).catch(() => undefined);
    // The arms and the branch first: without the run state, nothing would find them again.
    const left = created === undefined ? undefined : await removeCreated(created.run, repo.root);
    await rm(runDir, { recursive: true, force: true });
    await releaseMachineLock({ runId, home });
    // So the error names the branch that nothing else will: its class and code still say why
    // the start failed.
    if (left !== undefined && error instanceof Error) error.message = `${error.message}; ${left}`;
    throw error;
  }
}

/**
 * Removes the arms and branch of a start that failed. Returns what to tell the user when the run
 * branch is left behind.
 */
async function removeCreated(run: CreatedRun["run"], root: string): Promise<string | undefined> {
  try {
    await removeRun(run, { deleteBranch: true });
    return undefined;
  } catch (error) {
    const branch = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`],
      root,
    ).catch(() => undefined);
    if (branch?.code === 1) return undefined;
    const why = error instanceof Error ? error.message : String(error);
    return `could not remove the run branch ${run.branch} (${why}); delete it with \`git branch -D ${run.branch}\``;
  }
}

/**
 * `start_run` (plan §2.3 steps 3–4): refuses an unapproved or changed `ufo.yaml`, targets
 * outside the allowlist, and a start while another run is active; creates the run state, takes
 * the machine lock for the run's whole life, creates the run branch and both arms, captures the
 * command environment, queues the baseline, and launches the detached worker.
 */
export async function startRun(
  context: AppContext,
  options: StartRunOptions = {},
): Promise<StartRunResult> {
  const { runDir: _runDir, home: _home, ...result } = await startRunFor(context, options, "run");
  // Like every view (security F13): paths name your home as `~`, so the result is the same
  // whether a person or an agent's model provider reads it. The arm paths stay absolute.
  return redactExceptArms(result);
}

/**
 * `finish_run`: queues the final check, report, and bundle. The worker releases the machine lock
 * and exits when it is done.
 */
export async function finishRun(
  context: AppContext,
  options: { readonly runId?: string; readonly modelId?: string } = {},
): Promise<{ runId: string; jobId: string }> {
  const active = await activeRun(context, options.runId);
  let modelId: string | undefined;
  try {
    modelId = options.modelId === undefined ? undefined : labelSchema().parse(options.modelId);
  } catch (error) {
    rethrowAsUsage(error);
  }
  return withControlLock(active.runDir, controlLockWaitMs(context), async () => {
    await refuseIfFinishing(active);
    const state = { ...active.open.state, ...(modelId === undefined ? {} : { modelId }) };
    if (modelId !== undefined) await writeAppState(active.runDir, state);
    const job = await enqueueJob(active.runDir, { kind: JOB_KINDS.finish, input: {} });
    await ensureWorkerFor(context, { ...active, open: { ...active.open, state } }, [job]);
    return { runId: active.runId, jobId: job.jobId };
  });
}

function killSummary(report: KillReport) {
  return {
    terminated: report.terminated,
    killed: report.killed,
    survivors: report.survivors,
    containers: report.containers,
  };
}

/**
 * Requeues jobs an interrupted worker left running; a job interrupted twice fails instead,
 * unless it is a change whose decision is already recorded: re-run, it only finishes what the
 * decision says (a keep's commit) and measures nothing.
 */
async function settleInterrupted(
  runDir: string,
  status: "queued" | "cancelled",
): Promise<{ requeued: string[]; failed: string[]; cancelled: string[] }> {
  const events = await readLedger(runDir);
  const requeuedBefore = new Set(
    events
      .filter((e) => e.type === EVENTS.jobRequeued)
      .map((e) => (e.data as { jobId?: string } | undefined)?.jobId),
  );
  const result = { requeued: [] as string[], failed: [] as string[], cancelled: [] as string[] };
  const now = new Date().toISOString();
  for (const job of await listJobs(runDir)) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
    if (status === "cancelled") {
      await cancelJob(runDir, job, "cancelled");
      result.cancelled.push(job.jobId);
    } else if (job.status === "running") {
      const changeId = (job.input as { changeId?: unknown } | null)?.changeId;
      const decided =
        job.kind === JOB_KINDS.change &&
        typeof changeId === "string" &&
        decisionFor(events, changeId) !== undefined;
      if (requeuedBefore.has(job.jobId) && !decided) {
        await writeJob(runDir, {
          ...job,
          status: "failed",
          error: { message: "interrupted twice; not retried again" },
          updatedAt: now,
          finishedAt: now,
        });
        result.failed.push(job.jobId);
        continue;
      }
      const { startedAt: _s, workerPid: _w, progress: _p, ...rest } = job;
      await writeJob(runDir, JobRecordSchema.parse({ ...rest, status: "queued", updatedAt: now }));
      await appendLedger(runDir, { type: EVENTS.jobRequeued, data: { jobId: job.jobId } });
      result.requeued.push(job.jobId);
    }
  }
  return result;
}

export interface ResumeResult {
  runId: string;
  requeued: string[];
  failed: string[];
  /** Change ids committed on the run branch whose ledger event was missing, now recorded. */
  reconciled: string[];
  armSha: string;
  /** Absolute, like a start's: the agent goes on reading arm A. */
  arms: { a: string; b: string };
  workerPid?: number | undefined;
  processes: ReturnType<typeof killSummary>;
}

/**
 * `resume_run` (plan §2.3): stops whatever the run left running, requeues interrupted jobs,
 * resets both arms to the run branch HEAD, reconciles the ledger with the commits (commit
 * first, ledger second: a commit without its event gets the event; anything else stops), and
 * starts a worker for the queued jobs.
 */
export async function resumeRun(
  context: AppContext,
  options: { readonly runId?: string } = {},
): Promise<ResumeResult> {
  const active = await activeRun(context, options.runId);
  return withControlLock(active.runDir, controlLockWaitMs(context), () =>
    resumeLocked(context, active),
  );
}

async function resumeLocked(context: AppContext, active: ActiveRun): Promise<ResumeResult> {
  const { runDir } = active;
  // The run may have ended while this call waited for the control lock.
  const current = await readRun(runDir);
  if (current.status !== "running") {
    throw new AppError("run_not_active", `run ${active.runId} is ${current.status}`);
  }
  // A worker started now would see the cancel flag and cancel every job at once.
  if (await isCancelRequested(runDir)) {
    throw new AppError(
      "cancel_pending",
      `a cancel of run ${active.runId} did not complete; cancel it again to end the run`,
    );
  }
  const { git } = active.open;
  if (!(await exists(git.armA)) || !(await exists(git.armB))) {
    throw new AppError(
      "arms_missing",
      `the arms of run ${active.runId} are gone, so it cannot continue; cancel it to end the run`,
    );
  }
  const kill = await killRunProcesses(runDir, killOptions(context));
  const armSha = await resetArms(git);
  // Reconciled before any job is requeued, so a refused resume changes no job.
  const events = await readLedger(runDir);
  const commits = await listChangeIds(git);
  const reconciliation = reconcileLedger(
    events,
    commits.map((c) => c.changeId),
  );
  if (reconciliation.recordedUncommitted.length > 0 || reconciliation.duplicateCommits.length > 0) {
    throw new AppError(
      "ledger_mismatch",
      `the run branch and the ledger disagree (recorded but not committed: ${reconciliation.recordedUncommitted.join(", ") || "none"}; committed twice: ${reconciliation.duplicateCommits.join(", ") || "none"}); not resuming`,
    );
  }
  const settled = await settleInterrupted(runDir, "queued");
  const known = committedChangeIds(events);
  for (const changeId of reconciliation.committedUnrecorded) {
    if (known.has(changeId)) continue;
    const sha = commits.find((c) => c.changeId === changeId)?.sha;
    await appendLedger(runDir, { type: EVENTS.committed, changeId, data: { sha: sha ?? null } });
  }
  // A keep committed in arm A just before a crash may not have reached the user's branch yet.
  if (armSha !== git.baseSha) await publishBranch(git);
  await updateRun(runDir, (run) => ({ ...run, shas: { ...run.shas, a: armSha, b: armSha } }));
  await appendLedger(runDir, {
    type: EVENTS.runResumed,
    data: jsonData({ ...settled, reconciled: reconciliation.committedUnrecorded, armSha }),
  });
  const queued = (await listJobs(runDir)).some((job) => job.status === "queued");
  const worker = queued
    ? await ensureWorker(context, runDir, active.home, active.open.state)
    : undefined;
  return redactExceptArms(
    toJson({
      runId: active.runId,
      requeued: settled.requeued,
      failed: settled.failed,
      reconciled: reconciliation.committedUnrecorded,
      armSha,
      arms: { a: git.armA, b: git.armB },
      workerPid: worker?.pid,
      processes: killSummary(kill),
    }),
  );
}

export interface CancelResult {
  runId: string;
  cancelledJobs: string[];
  processes: ReturnType<typeof killSummary>;
  /** Ledger events kept: completed observations survive a cancel. */
  observationsKept: number;
}

/**
 * `cancel_run`: stops the worker and everything the run started (process groups, containers
 * labeled `ufo.run=<id>`; a missing Docker is reported, not fatal), cancels unfinished jobs,
 * records the run as cancelled, then removes both arms (the run branch stays) and releases the
 * machine lock, and keeps the ledger. The status comes before the cleanup, so a cancel cut short
 * leaves an ended run, never a `running` one without arms; a later start removes the leftovers.
 */
export async function cancelRun(
  context: AppContext,
  options: { readonly runId?: string } = {},
): Promise<CancelResult> {
  const located = await locateRun(context, options.runId);
  const record = await readRun(located.runDir);
  if (record.status === "running" && !record.started) {
    // A start that never finished has no app state and no worker: end it from its ids.
    if (!(await abandonedStart(record))) {
      throw new AppError("run_starting", `run ${located.runId} is still starting`);
    }
    const kill = await killRunProcesses(located.runDir, killOptions(context));
    const ended = await endAbandonedStart(
      located.home,
      located.repo,
      located.runId,
      controlLockWaitMs(context),
    );
    if (!ended) {
      throw new AppError(
        "run_not_active",
        `run ${located.runId} ended before the cancel took effect`,
      );
    }
    return {
      runId: located.runId,
      cancelledJobs: [],
      processes: killSummary(kill),
      observationsKept: (await readLedger(located.runDir)).length,
    };
  }
  const active = await activeRun(context, options.runId);
  return withControlLock(active.runDir, controlLockWaitMs(context), () =>
    cancelLocked(context, active),
  );
}

async function cancelLocked(context: AppContext, active: ActiveRun): Promise<CancelResult> {
  const { runDir, open } = active;
  const current = await readRun(runDir);
  if (current.status !== "running") {
    throw new AppError("run_not_active", `run ${active.runId} is ${current.status}`);
  }
  // The unfinished jobs before the cancel: the worker may cancel some itself once it sees the
  // flag, before it is stopped, so what this call settles below is not the whole list.
  const unfinished = new Set(
    (await listJobs(runDir))
      .filter((job) => !TERMINAL_JOB_STATUSES.has(job.status))
      .map((job) => job.jobId),
  );
  await requestCancel(runDir);
  const kill = await killRunProcesses(runDir, killOptions(context));
  await settleInterrupted(runDir, "cancelled");
  const cancelledJobs = (await listJobs(runDir))
    .filter((job) => unfinished.has(job.jobId) && job.status === "cancelled")
    .map((job) => job.jobId);
  if (!(await endRun(runDir, "cancelled"))) {
    // A finish that ran meanwhile ended the run first; its result stands.
    throw new AppError("run_not_active", `run ${active.runId} ended before the cancel took effect`);
  }
  await appendLedger(runDir, {
    type: EVENTS.runCancelled,
    data: jsonData({ cancelledJobs, processes: killSummary(kill) }),
  });
  // The arms are deleted whole, so whatever a job left in them needs no reset first, and an arm
  // that is already gone is not an error. The run is cancelled either way: arms that cannot be
  // removed now are left for the next start's cleanup.
  await removeRun(open.git, { deleteBranch: open.state.purpose === "measure" }).catch(
    async (error: unknown) => {
      await appendLedger(runDir, {
        type: EVENTS.cleanupFailed,
        data: { message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) },
      });
    },
  );
  await releaseMachineLock({ runId: active.runId, home: active.home });
  return {
    runId: active.runId,
    cancelledJobs,
    processes: killSummary(kill),
    observationsKept: (await readLedger(runDir)).length,
  };
}

/**
 * `work`, or `interrupted` as soon as `signal` aborts (Ctrl-C on the CLI). The work itself goes
 * on until the caller has ended the run; what it does after that is not reported.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError("interrupted", "interrupted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const isInterrupted = (error: unknown) => error instanceof AppError && error.code === "interrupted";

/** Refuses to go on once `signal` aborted: no more work is queued for an interrupted run. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AppError("interrupted", "interrupted");
}

/**
 * A start that failed after `signal` aborted (Ctrl-C also reaches the git and ps processes the
 * start runs) fails `interrupted`, with what went wrong; the start cleaned up after itself.
 */
async function startUnlessAborted<T>(
  start: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  try {
    return await start;
  } catch (error) {
    if (signal?.aborted !== true) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new AppError("interrupted", `interrupted; the run did not start (${why})`, {
      cause: error,
    });
  }
}

/** Cancels the run after `ufo run` or `ufo measure` cannot go on, and says what that did. */
async function cancelAndSay(
  context: AppContext,
  runId: string,
  what: string,
): Promise<{ cancelled: boolean; how: string }> {
  return cancelRun(context, { runId }).then(
    () => ({ cancelled: true, how: `${what} ${runId} was cancelled` }),
    (cancelError: unknown) => ({
      cancelled: false,
      how:
        cancelError instanceof AppError && cancelError.code === "run_not_active"
          ? `${what} ${runId} had already ended`
          : `${what} ${runId} could not be cancelled (${cancelError instanceof Error ? cancelError.message : String(cancelError)})`,
    }),
  );
}

export interface MeasureResult {
  runId: string;
  baseline: BaselineResult;
  /** The start's warnings: uncommitted changes left out, earlier runs that could not be cleaned up. */
  warnings: string[];
}

/**
 * `ufo measure`: the baseline alone (oracle snapshot, five samples, noise floor) at the current
 * HEAD, through a short-lived run whose branch and arms are removed afterwards. Once `signal`
 * aborts, the run is cancelled like `ufo cancel` does (its jobs too), and the call fails
 * `interrupted`.
 */
export async function measure(
  context: AppContext,
  options: StartRunOptions & {
    readonly onProgress?: (job: JobRecord) => void;
    readonly signal?: AbortSignal;
  } = {},
): Promise<MeasureResult> {
  const started = await startUnlessAborted(
    startRunFor(context, options, "measure"),
    options.signal,
  );
  let job: JobRecord | undefined;
  let cancelled = false;
  try {
    // Nothing more is printed for the baseline once interrupted.
    const progress = (current: JobRecord) => {
      if (options.signal?.aborted !== true) options.onProgress?.(current);
    };
    job = await untilAborted(
      waitForJobDone(context, started.runId, started.baselineJobId, progress),
      options.signal,
    );
  } catch (error) {
    if (isInterrupted(error)) {
      const cancel = await cancelAndSay(context, started.runId, "measure run");
      cancelled = cancel.cancelled;
      throw new AppError("interrupted", `interrupted; ${cancel.how}`, { cause: error });
    }
    // The measure run is closed below, so there is nothing to resume.
    if (error instanceof AppError && error.code === "worker_not_running") {
      throw new AppError(
        "measurement_failed",
        "the worker stopped before the baseline finished; run ufo measure again",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!cancelled) await closeMeasureRun(context, started, job);
  }
  if (job?.status !== "succeeded") {
    throw new AppError(
      "measurement_failed",
      `the baseline ${job?.status ?? "did not finish"}: ${job?.error?.message ?? "no detail"}`,
    );
  }
  return {
    runId: started.runId,
    baseline: job.result as unknown as BaselineResult,
    warnings: redact(started.warnings),
  };
}

/**
 * Ends a measure run that was not cancelled here: its final status, then its arms and branch. A
 * run something else ended first (`ufo cancel`) was cleaned up by that, or is by the next start.
 * Under the run's control lock: a `ufo cancel` that marked the baseline cancelled finishes first,
 * instead of racing this close.
 */
function closeMeasureRun(
  context: AppContext,
  started: { runId: string; runDir: string; home: string },
  job: JobRecord | undefined,
): Promise<void> {
  return withControlLock(started.runDir, controlLockWaitMs(context), async () => {
    await killRunProcesses(started.runDir, killOptions(context));
    // The status first, as everywhere: a crash in the cleanup below leaves an ended run whose
    // arms and branch the next start removes.
    if (!(await endRun(started.runDir, job?.status === "succeeded" ? "finished" : "failed"))) {
      return;
    }
    const open = await openRun(started.home, started.runDir);
    await removeRun(open.git, { deleteBranch: true }).catch(async (error: unknown) => {
      await appendLedger(started.runDir, {
        type: EVENTS.cleanupFailed,
        data: { message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) },
      });
    });
    await releaseMachineLock({ runId: started.runId, home: started.home });
  });
}

export interface RunToEndResult {
  report: FinishedReport;
  decisions: { cardId: string; outcome: string; reason?: string | undefined }[];
  /** Recipe cards not tried because the technique cap was reached. */
  skipped: string[];
}

/**
 * `ufo run` without an agent: start, baseline, every enabled recipe once, finish. A run never
 * stays `running` behind it: when a job fails the run is cancelled, and a baseline refused for
 * noise finishes the run at once (every change would be refused the same way), with a report.
 * Once `signal` aborts, the run is cancelled and the call fails `interrupted`.
 */
export async function runToEnd(
  context: AppContext,
  options: { readonly onProgress?: (line: string) => void; readonly signal?: AbortSignal } = {},
): Promise<RunToEndResult> {
  const say = options.onProgress ?? (() => undefined);
  const { signal } = options;
  const started = await startUnlessAborted(startRun(context, { hostAgent: "none" }), signal);
  say(`run ${started.runId} on ${started.branch}`);
  for (const warning of started.warnings) say(`warning: ${warning}`);
  let ended: Awaited<ReturnType<typeof recipesToEnd>>;
  try {
    // Nothing more is printed for the jobs once interrupted.
    const quiet = (line: string) => {
      if (signal?.aborted !== true) say(line);
    };
    ended = await untilAborted(recipesToEnd(context, started, quiet, signal), signal);
  } catch (error) {
    // A worker that stopped can be resumed. Anything else ends the run, so it never stays
    // `running` behind `ufo run`.
    if (error instanceof AppError && error.code === "worker_not_running") throw error;
    const { how } = await cancelAndSay(context, started.runId, "run");
    if (error instanceof JobFailed) {
      throw new AppError("measurement_failed", `${error.message}; ${how}`, { cause: error });
    }
    if (isInterrupted(error)) throw new AppError("interrupted", `interrupted; ${how}`);
    say(how);
    throw error;
  }
  if (ended.refusal !== undefined) {
    throw new AppError(
      "measurement_failed",
      `the baseline was refused (${ended.refusal.reason}: ${ended.refusal.detail}); no recipe was tried. The report of run ${started.runId} is kept.`,
    );
  }
  return { report: ended.report, decisions: ended.decisions, skipped: ended.skipped };
}

/** A job of `ufo run` that did not succeed. */
class JobFailed extends Error {
  override name = "JobFailed";
}

async function recipesToEnd(
  context: AppContext,
  started: StartRunResult,
  say: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<RunToEndResult & { refusal?: BaselineResult["refusal"] }> {
  const { runId } = started;
  const scoped = { runId };
  const wait = async (jobId: string, what: string): Promise<JobRecord> => {
    const job = await waitForJobDone(context, runId, jobId, (j) =>
      say(`${what}: ${j.progress?.message ?? j.status}`),
    );
    if (job.status === "succeeded") return job;
    throw new JobFailed(`${what} ${job.status}: ${job.error?.message ?? "no detail"}`);
  };
  const baseline = (await wait(started.baselineJobId, "baseline")).result as unknown as
    | BaselineResult
    | undefined;
  const decisions: RunToEndResult["decisions"] = [];
  let skipped: string[] = [];
  if (baseline?.refusal === undefined) {
    throwIfAborted(signal);
    const recipes = await runRecipes(context, scoped);
    for (const queued of recipes.jobs) {
      const job = await wait(queued.jobId, queued.cardId);
      const { decision } = job.result as { decision: { outcome: string; reason?: string } };
      say(`${queued.cardId}: ${decision.outcome}${decision.reason ? ` (${decision.reason})` : ""}`);
      decisions.push({ cardId: queued.cardId, outcome: decision.outcome, reason: decision.reason });
    }
    skipped = recipes.skipped;
    for (const cardId of skipped) say(`${cardId}: skipped, budget exhausted`);
  }
  throwIfAborted(signal);
  const finish = await finishRun(context, scoped);
  await wait(finish.jobId, "finish");
  const finished = await report(context, scoped);
  if (!finished.finished) throw new JobFailed(`run ${runId} finished without a report`);
  return {
    report: finished,
    decisions,
    skipped,
    ...(baseline?.refusal === undefined ? {} : { refusal: baseline.refusal }),
  };
}
