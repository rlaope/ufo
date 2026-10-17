import { execFile } from "node:child_process";
import { MAX_NOTE_LENGTH } from "../../domain/index.js";

/**
 * Variables that would point git at another repository, index, or identity than the one the
 * command runs in. A UFO invoked from a git hook or alias inherits them; left in place, a reset
 * meant for arm B would hit the user's working tree.
 */
const SCRUBBED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
];

// Hooks and fsmonitor run commands from the target repository, which are outside the approved
// command set. Every other setting (author identity, signing) stays the repository's own.
const BASE_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type GitErrorCode =
  | "git_failed"
  | "not_a_repo"
  | "no_commits"
  | "invalid_run_id"
  | "branch_exists"
  | "run_exists"
  | "arms_diverged"
  | "duplicate_change"
  | "invalid_trailer";

export class GitError extends Error {
  readonly code: GitErrorCode;
  /** Raw stderr of the failing git command, when there was one. */
  readonly stderr: string;

  constructor(code: GitErrorCode, message: string, stderr = "") {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One line of git's stderr, fit for a decision detail: no control characters, bounded length. */
export function summarizeStderr(stderr: string): string {
  const text = stderr
    .split("\n")
    .map((line) => line.replace(/\p{Cc}/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("; ");
  return text.length > MAX_NOTE_LENGTH ? `${text.slice(0, MAX_NOTE_LENGTH - 3)}...` : text;
}

/** Runs git without a shell. Resolves with the exit code; rejects only when git could not run. */
export function runGit(args: readonly string[], cwd: string, input?: string): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of SCRUBBED_ENV) delete env[key];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...BASE_ARGS, ...args],
      { cwd, env, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(
            new GitError("git_failed", `git ${args[0]} did not run: ${error.message}`, stderr),
          );
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
    // git may exit before reading all of stdin (for example on a malformed patch); its exit code
    // reports that, so the resulting EPIPE is not an error of its own.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

/** Runs git and returns stdout; a non-zero exit becomes a `git_failed` error. */
export async function git(args: readonly string[], cwd: string, input?: string): Promise<string> {
  const result = await runGit(args, cwd, input);
  if (result.code !== 0) {
    throw new GitError(
      "git_failed",
      `git ${args[0]} failed: ${summarizeStderr(result.stderr) || `exit code ${result.code}`}`,
      result.stderr,
    );
  }
  return result.stdout;
}
