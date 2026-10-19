// Work queued on a running run: agent changes (`submit_change`) and recipe changes (`ufo run`),
// each refused up front once the budget is used up or the run is finishing.
import { randomUUID } from "node:crypto";
import {
  cancelJob,
  enqueueJob,
  type JobRecord,
  listJobs,
  readJob,
  readLedger,
  readRun,
  TERMINAL_JOB_STATUSES,
  withControlLock,
  withRunLock,
} from "../core/jobs/index.js";
import { PolicyError } from "../core/policy/index.js";
import { type ActiveRun, activeRun, refuseIfFinishing, rethrowAsUsage } from "./active.js";
import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import { budgetStatus } from "./events.js";
import { ChangeJobInputSchema, JOB_KINDS } from "./jobs/index.js";
import { ensureWorker } from "./launch.js";
import { jsonData } from "./state.js";

/**
 * Starts a worker for jobs just queued. When none can start (another run holds the machine
 * lock), the jobs are cancelled before the refusal is thrown: a queued job no worker will ever
 * claim would count against the budget and, for a finish job, refuse all later work.
 */
export async function ensureWorkerFor(
  context: AppContext,
  active: ActiveRun,
  jobs: readonly JobRecord[],
): Promise<void> {
  try {
    await ensureWorker(context, active.runDir, active.home, active.open.state);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Only jobs still queued, read again under the run lock: a worker that did start may have
    // claimed one already.
    await withRunLock(active.runDir, async () => {
      for (const job of jobs) {
        const current = await readJob(active.runDir, job.jobId);
        if (current.status !== "queued") continue;
        await cancelJob(active.runDir, current, `no worker could start: ${reason}`.slice(0, 4000));
      }
    });
    throw error;
  }
}

async function pendingChanges(runDir: string): Promise<number> {
  return (await listJobs(runDir)).filter(
    (job) => job.kind === JOB_KINDS.change && !TERMINAL_JOB_STATUSES.has(job.status),
  ).length;
}

export async function checkBudgetOpen(active: ActiveRun, extra = 0): Promise<void> {
  const { open } = active;
  const run = await readRun(active.runDir);
  const status = budgetStatus(
    await readLedger(active.runDir),
    open.config.objective.budget,
    run.createdAt,
    { pending: (await pendingChanges(active.runDir)) + extra },
  );
  if (status.violation !== undefined) throw new PolicyError(status.violation);
}

export interface SubmitChangeOptions {
  readonly runId?: string;
  /** The technique card the change implements; its risk class decides the opt-in check. */
  readonly cardId: string;
  /** Unified diff against arm A's HEAD. */
  readonly diff: string;
  readonly hypothesis: string;
  readonly evidenceRefs?: readonly string[];
  /** Arm A's SHA the diff was written against; defaults to A's current HEAD. */
  readonly baseSha?: string;
}

export interface QueuedChange {
  runId: string;
  changeId: string;
  jobId: string;
}

/**
 * `submit_change`: the only code-mutating entry point. Queues the change for the worker, which
 * decides it; poll `getJob` for the decision. Refused right away once the technique cap is
 * reached (`policy:budget_exceeded`) until `extendBudget` raises it.
 */
export async function submitChange(
  context: AppContext,
  options: SubmitChangeOptions,
): Promise<QueuedChange> {
  const active = await activeRun(context, options.runId);
  if (active.open.state.purpose !== "run") {
    throw new AppError("run_not_active", `run ${active.runId} only measures; it takes no changes`);
  }
  const changeId = randomUUID();
  let input: ReturnType<typeof ChangeJobInputSchema.parse>;
  try {
    input = ChangeJobInputSchema.parse({
      changeId,
      cardId: options.cardId,
      hypothesis: options.hypothesis,
      evidenceRefs: [...(options.evidenceRefs ?? [])],
      source: "agent",
      diff: options.diff,
      ...(options.baseSha === undefined ? {} : { baseSha: options.baseSha }),
    });
  } catch (error) {
    rethrowAsUsage(error);
  }
  return withControlLock(active.runDir, async () => {
    await refuseIfFinishing(active);
    await checkBudgetOpen(active);
    const job = await enqueueJob(active.runDir, {
      kind: JOB_KINDS.change,
      input: jsonData(input),
    });
    await ensureWorkerFor(context, active, [job]);
    return { runId: active.runId, changeId, jobId: job.jobId };
  });
}

export interface RecipeJobs {
  runId: string;
  jobs: { cardId: string; changeId: string; jobId: string }[];
  /** Recipe cards not queued because the technique cap would be exceeded. */
  skipped: string[];
}

/**
 * `ufo run` without an agent: each enabled recipe card with edits, once, with default
 * parameters, in the order `ufo.yaml` lists the cards. UFO computes each diff in the worker
 * against A as it is when the job runs, so earlier keeps are included.
 */
export async function runRecipes(
  context: AppContext,
  options: { readonly runId?: string } = {},
): Promise<RecipeJobs> {
  const active = await activeRun(context, options.runId);
  return withControlLock(active.runDir, () => queueRecipes(context, active));
}

async function queueRecipes(context: AppContext, active: ActiveRun): Promise<RecipeJobs> {
  await refuseIfFinishing(active);
  const { open } = active;
  const recipes = open.config.cards
    .map((id) => open.catalog.cards.get(id))
    .filter((card) => card !== undefined && card.kind === "recipe" && card.edits.length > 0);
  const jobs: RecipeJobs["jobs"] = [];
  const queued: JobRecord[] = [];
  const skipped: string[] = [];
  for (const card of recipes) {
    if (card === undefined) continue;
    try {
      await checkBudgetOpen(active);
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      skipped.push(card.id);
      continue;
    }
    const changeId = randomUUID();
    const input = ChangeJobInputSchema.parse({
      changeId,
      cardId: card.id,
      hypothesis: `Recipe ${card.id}: ${card.title}`,
      source: "recipe",
    });
    const job = await enqueueJob(active.runDir, { kind: JOB_KINDS.change, input: jsonData(input) });
    queued.push(job);
    jobs.push({ cardId: card.id, changeId, jobId: job.jobId });
  }
  if (queued.length > 0) await ensureWorkerFor(context, active, queued);
  return { runId: active.runId, jobs, skipped };
}
