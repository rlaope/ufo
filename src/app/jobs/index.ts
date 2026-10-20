import { realpath } from "node:fs/promises";
import { readRun } from "../../core/jobs/index.js";
import {
  assertTrustedDir,
  parseRunDir,
  TrustError,
  trustedHome,
  ufoHome,
} from "../../core/paths.js";
import {
  type JobHandler,
  parseWorkerArgv,
  runWorker,
  type WorkerSummary,
} from "../../worker/index.js";
import { type Machine, systemMachine } from "../workload.js";
import { handleBaseline } from "./baseline.js";
import { handleChange } from "./change.js";
import { handleFinish } from "./finish.js";
import { handleProfile } from "./profile.js";
import { JOB_KINDS } from "./shared.js";

export * from "./baseline.js";
export * from "./change.js";
export * from "./finish.js";
export * from "./profile.js";
export * from "./shared.js";

/** How long an idle worker waits for the agent's next change before it exits. */
export const WORKER_IDLE_EXIT_MS = 5 * 60_000;

/**
 * The worker's job handlers. `machine` is the hygiene and fingerprint source; `home` is the
 * worker's own trusted home.
 */
export function createJobHandlers(machine: Machine, home: string): Record<string, JobHandler> {
  const options = { machine, home };
  return {
    [JOB_KINDS.baseline]: (job, context) => handleBaseline(job, context, options),
    [JOB_KINDS.change]: (job, context) => handleChange(job, context, options),
    [JOB_KINDS.finish]: (job, context) => handleFinish(job, context, options),
    [JOB_KINDS.profile]: (job, context) => handleProfile(job, context, options),
  };
}

/**
 * The run directory `ufo worker --run-dir` may work on: its real path must be exactly
 * `$UFO_HOME/private/runs/<repo-id>/<run-id>` under this process's own trusted home, every
 * component a real directory, with a `run.json` naming that run and repository.
 */
export async function trustedRunDir(home: string, given: string): Promise<string> {
  const runDir = await realpath(given).catch(() => given);
  const ids = parseRunDir(home, runDir);
  if (ids === undefined) {
    throw new TrustError("unsafe_state", `--run-dir ${given} is not a run directory under ${home}`);
  }
  await assertTrustedDir(home, runDir);
  const run = await readRun(runDir);
  if (run.runId !== ids.runId || run.repoId !== ids.repoId) {
    throw new TrustError("unsafe_state", `the run record in ${runDir} names another run`);
  }
  return runDir;
}

/** `ufo worker --run-dir <dir>`: the detached worker's main loop with the app's handlers. */
export async function runAppWorker(
  argv: readonly string[],
  machine: Machine = systemMachine,
  options: { idleExitMs?: number } = {},
): Promise<WorkerSummary> {
  const home = await trustedHome(ufoHome());
  const runDir = await trustedRunDir(home, parseWorkerArgv(argv).runDir);
  return runWorker({
    runDir,
    handlers: createJobHandlers(machine, home),
    idleExitMs: options.idleExitMs ?? WORKER_IDLE_EXIT_MS,
  });
}
