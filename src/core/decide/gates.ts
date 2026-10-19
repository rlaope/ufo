import {
  type Decision,
  type DecisionOutcome,
  type DecisionReason,
  DecisionSchema,
  type GuardrailKind,
  MAX_NOTE_LENGTH,
  type OracleResult,
  type Pair,
} from "../../domain/index.js";
import { oneLine } from "../text.js";

/** Whether the candidate stayed within one guardrail, as computed by the caller. */
export interface GuardrailCheck {
  readonly kind: GuardrailKind;
  readonly passed: boolean;
  /** Human-readable evidence, e.g. `error rate 2.4% vs baseline 0.0%`. */
  readonly detail?: string;
}

/** The parts of an oracle result the decision reads; an `OracleResult` fits. */
export type OracleCheck = Pick<OracleResult, "oracle" | "passed" | "summary">;

export interface FailedGate {
  readonly reason: DecisionReason;
  readonly detail?: string;
}

/**
 * The gate that drops a change regardless of its metric: the first failing oracle, else the
 * first failing guardrail, in input order. Oracles come first because they run before
 * measurement.
 */
export function failedGate(
  oracles: readonly OracleCheck[],
  guardrails: readonly GuardrailCheck[],
): FailedGate | undefined {
  const oracle = oracles.find((check) => !check.passed);
  if (oracle !== undefined) {
    return withDetail(`oracle:${oracle.oracle}`, oracle.summary);
  }
  const guardrail = guardrails.find((check) => !check.passed);
  if (guardrail !== undefined) {
    return withDetail(`guardrail:${guardrail.kind}`, guardrail.detail);
  }
  return undefined;
}

function withDetail(reason: DecisionReason, detail: string | undefined): FailedGate {
  return detail === undefined ? { reason } : { reason, detail };
}

/** Collapses control characters, trims, and truncates text to fit `Decision.detail`. */
function toDetail(text: string): string | undefined {
  return oneLine(text, MAX_NOTE_LENGTH) || undefined;
}

export interface MeasuredChange {
  readonly changeId: string;
  readonly pairs: readonly Pair[];
  readonly effect: number;
}

/** Builds a Decision and parses it, so every returned Decision satisfies `DecisionSchema`. */
export function buildDecision(
  measured: MeasuredChange,
  outcome: DecisionOutcome,
  reason?: DecisionReason,
  detail?: string,
): Decision {
  const note = detail === undefined ? undefined : toDetail(detail);
  return DecisionSchema.parse({
    changeId: measured.changeId,
    outcome,
    effect: measured.effect,
    pairs: measured.pairs.map(({ a, b }) => ({ a, b })),
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { detail: note }),
  });
}
