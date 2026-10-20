// The run an app call acts on: located and opened from trusted inputs, and still `running`.
import { ZodError } from "zod";
import {
  abandonedStart,
  listJobs,
  type RunRecord,
  readRun,
  TERMINAL_JOB_STATUSES,
} from "../core/jobs/index.js";
import { TrustError } from "../core/paths.js";
import { type AppContext, locateRun, type Repo } from "./context.js";
import { AppError } from "./errors.js";
import { JOB_KINDS } from "./jobs/index.js";
import { type AppState, type OpenRun, openRun } from "./state.js";

export function rethrowAsUsage(error: unknown): never {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    throw new AppError(
      "usage",
      `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`,
    );
  }
  throw error;
}

export interface ActiveRun {
  readonly runId: string;
  readonly runDir: string;
  /** The calling process's own trusted home. */
  readonly home: string;
  readonly open: OpenRun;
}

/**
 * Refuses a run that never finished starting, which has no app state yet: `run_starting` while
 * its start is still in progress, `run_in_progress` when its start was cut short (it still holds
 * the machine lock until a cancel ends it), and `run_not_active` once it ended.
 */
export async function refuseUnstarted(runId: string, run: RunRecord): Promise<void> {
  if (run.started) return;
  if (run.status !== "running") {
    throw new AppError(
      "run_not_active",
      `run ${runId} never finished starting and has ended (${run.status})`,
    );
  }
  if (await abandonedStart(run)) {
    throw new AppError(
      "run_in_progress",
      `run ${runId} did not finish starting; cancel it to end it`,
    );
  }
  throw new AppError("run_starting", `run ${runId} is still starting`);
}

/**
 * Refuses a run that another work tree started (security N1). Runs are found by the repository
 * id, which comes from the git directory that `.git` names; a work tree whose `.git` was pointed
 * at another repository's would otherwise reach that repository's runs.
 */
export function refuseOtherWorkTree(
  runId: string,
  state: Pick<AppState, "repoRoot">,
  repo: Pick<Repo, "root">,
): void {
  if (state.repoRoot === repo.root) return;
  throw new TrustError(
    "unsafe_state",
    `run ${runId} was started in the work tree at ${state.repoRoot}, not ${repo.root}; UFO acts on a run only from the work tree that started it`,
  );
}

/** The run, which must still be `running`, opened from trusted inputs. */
export async function activeRun(context: AppContext, runId?: string): Promise<ActiveRun> {
  const located = await locateRun(context, runId);
  const run = await readRun(located.runDir);
  if (run.status !== "running") {
    throw new AppError("run_not_active", `run ${located.runId} is ${run.status}`);
  }
  await refuseUnstarted(located.runId, run);
  const open = await openRun(located.home, located.runDir);
  refuseOtherWorkTree(located.runId, open.state, located.repo);
  return { runId: located.runId, runDir: located.runDir, home: located.home, open };
}

/**
 * Once `finishRun` queued the finish job, the run takes no more work: the worker removes the
 * arms and exits after it, and cancels whatever is still queued.
 */
export async function refuseIfFinishing(active: ActiveRun): Promise<void> {
  // Called inside the run's control lock: a cancel or finish that held it may have ended the run
  // while this call waited.
  const { status } = await readRun(active.runDir);
  if (status !== "running") {
    throw new AppError("run_not_active", `run ${active.runId} is ${status}`);
  }
  const finishing = (await listJobs(active.runDir)).some(
    (job) => job.kind === JOB_KINDS.finish && !TERMINAL_JOB_STATUSES.has(job.status),
  );
  if (finishing) {
    throw new AppError("run_finishing", `run ${active.runId} is finishing; it takes no more work`);
  }
}
