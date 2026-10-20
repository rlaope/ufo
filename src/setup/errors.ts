import {
  EXIT_INTERNAL,
  EXIT_REFUSED,
  EXIT_USAGE,
  type ExitCode,
  type Failure,
  redact,
} from "../app/api.js";

export type SetupErrorCode =
  | "usage"
  | "host_not_found"
  | "not_set_up"
  | "host_config_invalid"
  | "package_unavailable"
  | "entry_conflict"
  | "changed_during_setup"
  | "integrity_mismatch"
  | "approval_declined"
  | "busy"
  | "unsafe_state"
  | "no_terminal"
  | "host_cli_failed"
  | "install_failed";

const EXIT_BY_CODE: Record<SetupErrorCode, ExitCode> = {
  usage: EXIT_USAGE,
  host_not_found: EXIT_USAGE,
  not_set_up: EXIT_USAGE,
  host_config_invalid: EXIT_USAGE,
  package_unavailable: EXIT_USAGE,
  no_terminal: EXIT_USAGE,
  entry_conflict: EXIT_REFUSED,
  changed_during_setup: EXIT_REFUSED,
  integrity_mismatch: EXIT_REFUSED,
  approval_declined: EXIT_REFUSED,
  busy: EXIT_REFUSED,
  unsafe_state: EXIT_REFUSED,
  host_cli_failed: EXIT_INTERNAL,
  install_failed: EXIT_INTERNAL,
};

/** An expected failure of `ufo setup`, `uninstall`, or `update`. */
export class SetupError extends Error {
  override name = "SetupError";
  readonly code: SetupErrorCode;
  /** What to do next, when the message does not say it. */
  readonly hint: string | undefined;

  constructor(code: SetupErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }

  /**
   * The failure as the CLI reports it (docs/cli.md), redacted like every other failure: a parse
   * error can quote a host config's text. Only `busy` is worth retrying unchanged.
   */
  get failure(): Failure {
    return {
      exitCode: EXIT_BY_CODE[this.code],
      code: this.code,
      message: redact(this.message),
      retryable: this.code === "busy",
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }
}
