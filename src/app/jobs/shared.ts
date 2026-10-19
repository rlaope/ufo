import { type GuardrailCheck, median } from "../../core/decide/index.js";
import type { PolicyViolation } from "../../core/policy/index.js";
import {
  type Decision,
  type DecisionOutcome,
  type DecisionReason,
  DecisionSchema,
  MAX_NOTE_LENGTH,
  type Metric,
  type Objective,
  type Sample,
  type TechniqueCard,
} from "../../domain/index.js";
import type { JobContext } from "../../worker/index.js";
import { ERROR_RATE_KEY, RSS_KEY } from "../config.js";
import type { OpenRun } from "../state.js";
import { type Machine, WorkloadSession } from "../workload.js";

/** Job kinds the app enqueues; the worker's handlers are keyed by them. */
export const JOB_KINDS = {
  baseline: "baseline",
  change: "change",
  finish: "finish",
} as const;

/** Samples per arm at baseline and pairs in the final check (plan §2.3, §4.6). */
export const BASELINE_SAMPLES = 5;
export const FINAL_CHECK_PAIRS = 5;

export const DEFAULT_ERROR_RATE_DELTA_PP = 0.1;
export const DEFAULT_MEMORY_RATIO = 1.2;

export interface HandlerOptions {
  readonly machine: Machine;
  /** The worker's own trusted home: where it reads approvals and derives the arms from. */
  readonly home: string;
}

/** A workload session whose commands get exactly the run's captured environment. */
export function newSession(open: OpenRun, context: JobContext, machine: Machine): WorkloadSession {
  return new WorkloadSession({
    runDir: open.runDir,
    runId: open.state.runId,
    workload: open.config.workload,
    objective: open.config.objective,
    machine,
    signal: context.signal,
    env: open.state.env,
  });
}

function note(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 3)}...` : line;
}

/** A decision made before anything was measured: no pairs, no effect. */
export function unmeasured(
  changeId: string,
  outcome: Exclude<DecisionOutcome, "keep">,
  reason: DecisionReason,
  detail?: string,
): Decision {
  const text = detail === undefined ? "" : note(detail);
  return DecisionSchema.parse({
    changeId,
    outcome,
    reason,
    ...(text === "" ? {} : { detail: text }),
  });
}

export function refusal(changeId: string, violation: PolicyViolation): Decision {
  return unmeasured(changeId, "drop", `policy:${violation.rule}`, violation.detail);
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function secondaryValues(samples: readonly Sample[], key: string): number[] {
  return samples.flatMap((s) => (s.secondary[key] === undefined ? [] : [s.secondary[key]]));
}

/**
 * Guardrails of plan §4.4 from the samples' secondary values, B against A in the same pairs:
 * error rate at most `maxDeltaPp` above A's, memory at most `maxRatio` × A's (a card's approved
 * memory budget wins). A guardrail the workload reports but `ufo.yaml` does not configure runs
 * with its defaults.
 */
export function guardrailChecks(
  samples: readonly Sample[],
  objective: Objective,
  card?: Pick<TechniqueCard, "memoryBudget">,
): GuardrailCheck[] {
  const valid = samples.filter((s) => s.valid);
  const a = valid.filter((s) => s.arm === "a");
  const b = valid.filter((s) => s.arm === "b");
  const checks: GuardrailCheck[] = [];
  const errorA = secondaryValues(a, ERROR_RATE_KEY);
  const errorB = secondaryValues(b, ERROR_RATE_KEY);
  if (errorA.length > 0 && errorB.length > 0) {
    const configured = objective.guardrails.find((g) => g.kind === "error_rate");
    const maxDeltaPp =
      configured?.kind === "error_rate" ? configured.maxDeltaPp : DEFAULT_ERROR_RATE_DELTA_PP;
    const [ma, mb] = [median(errorA), median(errorB)];
    checks.push({
      kind: "error_rate",
      passed: mb <= ma + maxDeltaPp / 100 + 1e-12,
      detail: `median error rate ${pct(mb)} vs ${pct(ma)} at A; allowed +${maxDeltaPp} pp`,
    });
  }
  const rssA = secondaryValues(a, RSS_KEY);
  const rssB = secondaryValues(b, RSS_KEY);
  if (rssA.length > 0 && rssB.length > 0) {
    const configured = objective.guardrails.find((g) => g.kind === "memory");
    const maxRatio =
      card?.memoryBudget?.maxRatio ??
      (configured?.kind === "memory" ? configured.maxRatio : DEFAULT_MEMORY_RATIO);
    const [ma, mb] = [median(rssA), median(rssB)];
    checks.push({
      kind: "memory",
      passed: mb <= ma * maxRatio,
      detail: `median RSS ${Math.round(mb)} bytes vs ${Math.round(ma)} at A; allowed x${maxRatio}`,
    });
  }
  return checks;
}

export function formatValue(value: number): string {
  if (value === 0) return "0";
  const digits = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 1 ? 2 : 4;
  return Number(value.toFixed(digits)).toString();
}

/** `Ufo-Metric` trailer, e.g. `latency_ms 8.83 -> 3.71 (-58.0%)`, from the medians of the pairs. */
export function metricTrailer(metric: Metric, pairs: readonly { a: number; b: number }[]): string {
  const ma = median(pairs.map((p) => p.a));
  const mb = median(pairs.map((p) => p.b));
  const change = ma === 0 ? 0 : ((mb - ma) / ma) * 100;
  const sign = change > 0 ? "+" : "";
  return `${metric.name} ${formatValue(ma)} -> ${formatValue(mb)} (${sign}${change.toFixed(1)}%)`;
}
