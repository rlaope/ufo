import { execFile } from "node:child_process";
import path from "node:path";
import { MAX_NOTE_LENGTH } from "../../domain/index.js";
import { oneLine } from "../text.js";

/**
 * The only variables git gets from the process that runs it: where it finds programs and the
 * user's own config, the locale, the temp dir, and the user. Everything else, including
 * variables that would point git at another repository or index, inject config, or name programs
 * (`GIT_DIR`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`, ...) and every secret of the launching process,
 * stays out, so a program git runs never sees more than this.
 */
const GIT_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "TZ",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
];

export function gitProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (GIT_ENV_NAMES.includes(key) || key.startsWith("LC_")) env[key] = value;
  }
  // A relative (or empty) PATH entry would be looked up from git's working directory: the
  // repository or an arm.
  if (env.PATH !== undefined) {
    env.PATH = env.PATH.split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry))
      .join(path.delimiter);
  }
  return env;
}

// Hooks, fsmonitor, signing programs, and pagers run commands outside the approved command
// set; automatic gc and maintenance would rewrite a repository behind UFO's back. Recursion into
// submodules would run git with each submodule's own config, which nothing checks; config given
// here reaches those child processes too. Repository drivers (filters, textconv, merge drivers)
// are refused by `checkRepoConfig` before UFO runs git in the user's repository, and the arms are
// clones without the repository's config.
const BASE_ARGS = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "submodule.propagateBranches=false",
];

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
  | "invalid_trailer"
  | "unsafe_arm";

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
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return oneLine(lines.join("; "), MAX_NOTE_LENGTH);
}

/** The git subcommand of `args`, after any `--git-dir`/`--work-tree` options. */
function subcommand(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "";
}

/** Runs git without a shell. Resolves with the exit code; rejects only when git could not run. */
export function runGit(args: readonly string[], cwd: string, input?: string): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...gitProcessEnv(process.env),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    // A missing object is an error, never a fetch from a remote the repository chose.
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...BASE_ARGS, ...args],
      { cwd, env, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(
            new GitError(
              "git_failed",
              `git ${subcommand(args)} did not run: ${error.message}`,
              stderr,
            ),
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
      `git ${subcommand(args)} failed: ${summarizeStderr(result.stderr) || `exit code ${result.code}`}`,
      result.stderr,
    );
  }
  return result.stdout;
}
