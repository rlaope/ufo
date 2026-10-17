import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// Layout of one run state directory, `<git-common-dir>/ufo/runs/<run-id>/`.
export const RUN_FILE = "run.json";
export const RUN_LOCK_FILE = "run.lock";
export const LEDGER_FILE = "ledger.jsonl";
export const HEARTBEAT_FILE = "heartbeat.json";
/** Present once a cancel was requested; the worker stops claiming jobs when it sees it. */
export const CANCEL_FILE = "cancel.json";
export const JOBS_DIR = "jobs";
export const SAMPLES_DIR = "samples";
export const ARTIFACTS_DIR = "artifacts";
export const LOGS_DIR = "logs";
export const BUNDLES_DIR = "bundles";

/** Machine lock file name inside `$UFO_HOME`. */
export const MACHINE_LOCK_FILE = "lock";

/** Run ids name directories and labels, so they are restricted to a path- and label-safe set. */
export const RunIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase run id");
export type RunId = z.infer<typeof RunIdSchema>;

/** `$UFO_HOME`, or `~/.ufo` when unset. Holds the machine lock, approvals, and worktrees. */
export function ufoHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.UFO_HOME;
  return home !== undefined && home !== "" ? path.resolve(home) : path.join(os.homedir(), ".ufo");
}

/** The `.git` directory shared by every worktree of the repository that contains `cwd`. */
export async function resolveGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
  // Relative to `cwd` from the main worktree, absolute from a linked one.
  return path.resolve(cwd, stdout.trim());
}

export function runsRoot(commonDir: string): string {
  return path.join(commonDir, "ufo", "runs");
}

export function runDirFor(commonDir: string, runId: string): string {
  return path.join(runsRoot(commonDir), RunIdSchema.parse(runId));
}

/** e.g. `20261017-153000-a1b2c3`: UTC time, then random hex so two runs in one second differ. */
export function newRunId(now: Date = new Date()): RunId {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
