import { GitError } from "../core/git/index.js";
import { TrustError } from "../core/paths.js";
import { PolicyError } from "../core/policy/index.js";
import { CardLoadError } from "../techniques/index.js";

/** Exit codes of every `ufo` command (docs/cli.md). */
export const EXIT_OK = 0;
/** A policy refused the request, the human declined, or the run needs `ufo resume` first. */
export const EXIT_REFUSED = 1;
/** Bad arguments, a missing or invalid `ufo.yaml`, or nothing to act on. */
export const EXIT_USAGE = 2;
/** UFO itself failed. */
export const EXIT_INTERNAL = 3;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_REFUSED
  | typeof EXIT_USAGE
  | typeof EXIT_INTERNAL;

export type AppErrorCode =
  | "usage"
  | "not_a_repo"
  | "config_missing"
  | "config_invalid"
  | "config_exists"
  | "no_run"
  | "run_not_active"
  | "run_in_progress"
  | "worker_not_running"
  | "approval_declined"
  | "opt_in_mismatch"
  | "measurement_failed"
  | "ledger_mismatch"
  | "cancel_pending"
  | "arms_missing";

const EXIT_BY_CODE: Record<AppErrorCode, ExitCode> = {
  usage: EXIT_USAGE,
  not_a_repo: EXIT_USAGE,
  config_missing: EXIT_USAGE,
  config_invalid: EXIT_USAGE,
  config_exists: EXIT_REFUSED,
  no_run: EXIT_USAGE,
  run_not_active: EXIT_REFUSED,
  run_in_progress: EXIT_REFUSED,
  worker_not_running: EXIT_REFUSED,
  approval_declined: EXIT_REFUSED,
  opt_in_mismatch: EXIT_REFUSED,
  measurement_failed: EXIT_REFUSED,
  ledger_mismatch: EXIT_REFUSED,
  cancel_pending: EXIT_REFUSED,
  arms_missing: EXIT_REFUSED,
};

/** An expected failure of an app workflow, with the exit code the CLI reports for it. */
export class AppError extends Error {
  override name = "AppError";
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }

  get exitCode(): ExitCode {
    return EXIT_BY_CODE[this.code];
  }
}

/** A failure as `--json` reports it. `code` is `policy:<rule>` for policy refusals. */
export interface Failure {
  exitCode: ExitCode;
  code: string;
  message: string;
}

export function describeFailure(error: unknown): Failure {
  if (error instanceof PolicyError) {
    return {
      exitCode: EXIT_REFUSED,
      code: `policy:${error.violation.rule}`,
      message: error.violation.detail,
    };
  }
  if (error instanceof AppError) {
    return { exitCode: error.exitCode, code: error.code, message: error.message };
  }
  if (error instanceof CardLoadError) {
    return { exitCode: EXIT_USAGE, code: "cards_invalid", message: error.message };
  }
  if (error instanceof GitError && error.code === "not_a_repo") {
    return { exitCode: EXIT_USAGE, code: "not_a_repo", message: error.message };
  }
  // `UFO_HOME` itself is unusable: an environment to fix, like a bad argument.
  if (error instanceof TrustError && error.code === "unsafe_home") {
    return { exitCode: EXIT_USAGE, code: error.code, message: error.message };
  }
  // Something under the trusted home or an arm is not what UFO created: refused, not followed.
  if (error instanceof TrustError || (error instanceof GitError && error.code === "unsafe_arm")) {
    return { exitCode: EXIT_REFUSED, code: "unsafe_state", message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode: EXIT_INTERNAL, code: "internal", message };
}
