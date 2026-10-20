// The run an app call acts on: located and opened from trusted inputs, and still `running`.
import { ZodError } from "zod";
import {
  abandonedStart,
  listJobs,
  type RunRecord,
  readRun,
  TERMINAL_JOB_STATUSES,
} from "../core/jobs/index.js";
import { type AppContext, locateRun } from "./context.js";
import { AppError } from "./errors.js";
import { JOB_KINDS } from "./jobs/index.js";
import { type OpenRun, openRun } from "./state.js";

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
 * its start is still in progress, `run_not_active` once it ended or its start was cut short (a
 * cancel ends that one).
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
      "run_not_active",
      `run ${runId} did not finish starting; cancel it to end it`,
    );
  }
  throw new AppError("run_starting", `run ${runId} is still starting`);
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
