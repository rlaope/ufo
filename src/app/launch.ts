import {
  acquireMachineLock,
  type MachineLock,
  readMachineLock,
  readRun,
  type WorkerRecord,
} from "../core/jobs/index.js";
import { isWorkerAlive, launchWorker } from "../worker/index.js";
import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import type { AppState } from "./state.js";

/**
 * The worker's whole environment: the run's captured command environment, the launcher's git
 * configuration variables (for the worker's own git calls), and `UFO_HOME`. It is the same
 * whichever process launches the worker.
 */
export function workerEnvOf(state: Pick<AppState, "env" | "gitEnv">, home: string) {
  return { ...state.env, ...state.gitEnv, UFO_HOME: home };
}

/** `run_in_progress` naming the run that holds the machine lock and how to end it. */
export function runInProgress(holder: MachineLock | undefined): AppError {
  if (holder === undefined) {
    return new AppError("run_in_progress", "another UFO run holds the machine lock");
  }
  return new AppError(
    "run_in_progress",
    `UFO run ${holder.runId} is still active and holds the machine lock; finish it, or stop it with \`ufo cancel --run ${holder.runId}\` in its repository`,
  );
}

/**
 * Makes sure a worker is running for the run, launching one when the last worker exited (it
 * does after `WORKER_IDLE_EXIT_MS` without jobs). The caller holds the run's control lock, so
 * two callers never launch two workers. The run holds the machine lock for its whole life; a
 * lock file removed by hand is taken again for this run, and another run's lock refuses
 * (`run_in_progress`).
 */
export async function ensureWorker(
  context: AppContext,
  runDir: string,
  home: string,
  state: AppState,
): Promise<WorkerRecord> {
  const run = await readRun(runDir);
  if (run.status !== "running") {
    throw new AppError("run_not_active", `run ${state.runId} is ${run.status}`);
  }
  if (run.worker !== undefined && (await isWorkerAlive(run))) return run.worker;
  const lock = await readMachineLock({ home });
  if (lock === undefined) {
    const taken = await acquireMachineLock({ home, runId: state.runId, repoId: state.repoId });
    if (!taken.acquired) throw runInProgress(taken.holder);
  } else if (lock.runId !== state.runId) {
    throw runInProgress(lock);
  }
  return launchWorker(runDir, {
    ...(context.workerEntry === undefined ? {} : { entry: context.workerEntry }),
    env: workerEnvOf(state, home),
  });
}
