import { MAX_NOTE_LENGTH } from "../../domain/index.js";

/** Every policy rule UFO enforces. A refusal is reported as the decision reason `policy:<rule>`. */
export const POLICY_RULES = [
  /** The patch touches a protected path (tests, benchmarks, `ufo.yaml`, CI, secrets). */
  "protected_path",
  /** The patch touches a path outside the configured monorepo scope. */
  "out_of_scope",
  /** A baseline-passing test is missing or failing, or fewer tests ran. */
  "test_set_shrunk",
  /** `ufo.yaml` has never been approved for this repository. */
  "unapproved_config",
  /** `ufo.yaml` changed since it was approved. */
  "config_changed",
  /** The card's risk class needs an opt-in the human did not approve. */
  "opt_in_required",
  /** A load target is not loopback, the Docker bridge, or an approved target. */
  "target_not_allowed",
  /** `ufo approve` was run without an interactive terminal. */
  "non_tty_approval",
  /** The technique cap or the wall-clock budget is used up. */
  "budget_exceeded",
  /** Measurement noise is above the refusal threshold. */
  "noise_floor",
  /** The change names a technique card no catalog has. */
  "unknown_card",
  /** The card exists but the approved `ufo.yaml` does not enable it. */
  "card_not_enabled",
  /** The repository's git config would make git run a program the repository chose. */
  "unsafe_repo_config",
  /** The diff was written against an older arm A; an earlier change was kept since. */
  "stale_base",
] as const;
export type PolicyRuleName = (typeof POLICY_RULES)[number];

export interface PolicyViolation {
  readonly rule: PolicyRuleName;
  /** One line, at most `MAX_NOTE_LENGTH` characters: fits a decision's `detail`. */
  readonly detail: string;
  /** What the rule caught: paths, test ids, addresses. */
  readonly subjects: readonly string[];
}

export class PolicyError extends Error {
  readonly violation: PolicyViolation;

  constructor(violation: PolicyViolation) {
    super(`policy:${violation.rule}: ${violation.detail}`);
    this.name = "PolicyError";
    this.violation = violation;
  }
}

export function violation(
  rule: PolicyRuleName,
  detail: string,
  subjects: readonly string[] = [],
): PolicyViolation {
  const line = detail.replace(/\p{Cc}/gu, " ").trim() || rule;
  return {
    rule,
    detail: line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 3)}...` : line,
    subjects,
  };
}

/**
 * How a message names a human-only step (`ufo approve`, `ufo extend-budget`), so an agent that
 * reads it asks for it instead of running the command itself (security M3).
 */
export function personMustRun(command: string): string {
  return `a person must run \`${command}\` in their own terminal; an agent must not run it`;
}

/** `a, b, c and 7 more`: a bounded preview of a list for a violation detail. */
export function preview(items: readonly string[], limit = 10): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}
