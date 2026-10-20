import {
  EXIT_INTERNAL,
  EXIT_REFUSED,
  EXIT_USAGE,
  type ExitCode,
  type Failure,
} from "../app/errors.js";

export type SetupErrorCode =
  | "usage"
  | "host_not_found"
  | "not_set_up"
  | "host_config_invalid"
  | "entry_conflict"
  | "changed_during_setup"
  | "host_cli_failed"
  | "no_terminal"
  | "approval_declined"
  | "unsafe_state";

const EXIT_BY_CODE: Record<SetupErrorCode, ExitCode> = {
  usage: EXIT_USAGE,
  host_not_found: EXIT_USAGE,
  not_set_up: EXIT_USAGE,
  host_config_invalid: EXIT_USAGE,
  entry_conflict: EXIT_REFUSED,
  changed_during_setup: EXIT_REFUSED,
  host_cli_failed: EXIT_INTERNAL,
  no_terminal: EXIT_USAGE,
  approval_declined: EXIT_REFUSED,
  unsafe_state: EXIT_REFUSED,
};

/** An expected failure of `ufo setup`, `uninstall`, or `update`; nothing was written for it. */
export class SetupError extends Error {
  override name = "SetupError";
  readonly code: SetupErrorCode;

  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.code = code;
  }

  /**
   * The failure as the CLI reports it (docs/cli.md). Never retryable as is; each message says
   * what to change first, so there is no separate hint.
   */
  get failure(): Failure & { retryable: false } {
    return {
      exitCode: EXIT_BY_CODE[this.code],
      code: this.code,
      message: this.message,
      retryable: false,
    };
  }
}
