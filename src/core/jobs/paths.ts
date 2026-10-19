import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export {
  MACHINE_LOCK_FILE,
  machineLockPath,
  newRunId,
  parseRunDir,
  runDirFor,
  runsRoot,
  ufoHome,
} from "../paths.js";

const execFileAsync = promisify(execFile);

// Layout of one run state directory, `$UFO_HOME/private/runs/<repo-id>/<run-id>/`.
export const RUN_FILE = "run.json";
export const RUN_LOCK_FILE = "run.lock";
/** Serializes the run's control operations: launch, resume, cancel, finish. */
export const CONTROL_LOCK_FILE = "control.lock";
export const LEDGER_FILE = "ledger.jsonl";
export const HEARTBEAT_FILE = "heartbeat.json";
/** Present once a cancel was requested; the worker stops claiming jobs when it sees it. */
export const CANCEL_FILE = "cancel.json";
export const JOBS_DIR = "jobs";
export const SAMPLES_DIR = "samples";
export const ARTIFACTS_DIR = "artifacts";
export const LOGS_DIR = "logs";
export const BUNDLES_DIR = "bundles";

/** Run ids name directories and labels, so they are restricted to a path- and label-safe set. */
export const RunIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase run id");
export type RunId = z.infer<typeof RunIdSchema>;

/** The `.git` directory shared by every worktree of the repository that contains `cwd`. */
export async function resolveGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
  // Relative to `cwd` from the main worktree, absolute from a linked one.
  return path.resolve(cwd, stdout.trim());
}
