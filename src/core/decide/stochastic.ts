import { type Decision, MAX_PAIRS, type MetricDirection, type Pair } from "../../domain/index.js";
import { buildDecision, failedGate, type GuardrailCheck, type OracleCheck } from "./gates.js";
import {
  assertMinEffect,
  DecideInputError,
  decisionThreshold,
  MAX_NOISE_FLOOR,
  noiseFloor,
  type PairSummary,
  summarizePairs,
} from "./stats.js";

/** Pairs measured for every stochastic decision. */
export const INITIAL_PAIRS = 5;
/** Pairs after the one allowed escalation: the first five plus five more. */
export const ESCALATED_PAIRS = MAX_PAIRS;

const KEEP_IMPROVED_OF_5 = 4;
const BORDERLINE_IMPROVED_OF_5 = 3;
const KEEP_IMPROVED_OF_10 = 8;

export interface StochasticInput {
  /** The `Ufo-Change-Id` of the change under test. */
  readonly changeId: string;
  readonly direction: MetricDirection;
  /** `Objective.minEffect`, e.g. 0.03. */
  readonly minEffect: number;
  /**
   * The latest ≥ 5 primary-metric values at the current A (baseline runs, or the kept
   * candidate's B samples after a keep). Pass the same values to the escalated call.
   */
  readonly noiseSamples: readonly number[];
  /** `INITIAL_PAIRS` interleaved pairs, or `ESCALATED_PAIRS` after `needs_escalation`. */
  readonly pairs: readonly Pair[];
  readonly oracles?: readonly OracleCheck[];
  readonly guardrails?: readonly GuardrailCheck[];
  /** Likely cause of noise, e.g. `describeHygiene(report)`; used in a `policy:noise_floor` detail. */
  readonly noiseCause?: string;
}

export interface StochasticStats extends PairSummary {
  readonly noiseFloor: number;
  /** `T = max(minEffect, 2 × noiseFloor)`. */
  readonly threshold: number;
}

export type StochasticResult =
  | { readonly kind: "decided"; readonly decision: Decision; readonly stats: StochasticStats }
  | {
      readonly kind: "needs_escalation";
      /** Measure this many more pairs, append them, and call again with all of them. */
      readonly additionalPairs: number;
      readonly stats: StochasticStats;
    };

/**
 * Decides a stochastic metric (measurement policy §4.3).
 *
 * Each pair's improvement is `pairImprovement` (positive is better); the effect is their
 * median, and a pair "improves" when its improvement is > 0. With `T = max(minEffect,
 * 2 × noiseFloor)`, the checks run in this order:
 *
 * 1. A failing oracle, then a failing guardrail → drop `oracle:<name>` / `guardrail:<kind>`.
 * 2. Noise floor > `MAX_NOISE_FLOOR` → inconclusive `policy:noise_floor`, detail naming the cause.
 * 3. Five pairs: keep iff median ≥ T and ≥ 4 improve. Otherwise, if median ≥ T/2 and ≥ 3
 *    improve, return `needs_escalation`. Otherwise drop: `regressed` iff median ≤ −T (worse by
 *    at least T), else `no_effect`.
 * 4. Ten pairs (only after an escalation): keep iff median ≥ T and ≥ 8 improve, else
 *    inconclusive. A ten-pair call never escalates again, and throws unless its first five pairs
 *    were borderline under the same inputs.
 */
export function decideStochastic(input: StochasticInput): StochasticResult {
  const { pairs, direction } = input;
  if (pairs.length !== INITIAL_PAIRS && pairs.length !== ESCALATED_PAIRS) {
    throw new DecideInputError(
      "invalid_pair_count",
      `a stochastic decision needs ${INITIAL_PAIRS} or ${ESCALATED_PAIRS} pairs, got ${pairs.length}`,
    );
  }
  assertMinEffect(input.minEffect);
  const floor = noiseFloor(input.noiseSamples);
  const threshold = decisionThreshold(input.minEffect, floor);
  const stats: StochasticStats = {
    ...summarizePairs(pairs, direction),
    noiseFloor: floor,
    threshold,
  };
  const measured = { changeId: input.changeId, pairs, effect: stats.medianImprovement };
  const decided = (decision: Decision): StochasticResult => ({ kind: "decided", decision, stats });

  const gate = failedGate(input.oracles ?? [], input.guardrails ?? []);
  if (gate !== undefined) {
    return decided(buildDecision(measured, "drop", gate.reason, gate.detail));
  }
  if (floor > MAX_NOISE_FLOOR) {
    const cause =
      input.noiseCause ??
      "unknown; check power source, load average, and background apps, or use a deterministic proxy metric";
    const detail = `noise floor ${percent(floor)} exceeds ${percent(MAX_NOISE_FLOOR)}; likely cause: ${cause}`;
    return decided(buildDecision(measured, "inconclusive", "policy:noise_floor", detail));
  }

  if (pairs.length === INITIAL_PAIRS) {
    if (isKeep(stats, KEEP_IMPROVED_OF_5)) return decided(buildDecision(measured, "keep"));
    if (isBorderline(stats)) {
      return { kind: "needs_escalation", additionalPairs: ESCALATED_PAIRS - INITIAL_PAIRS, stats };
    }
    const reason = stats.medianImprovement <= -threshold ? "regressed" : "no_effect";
    return decided(buildDecision(measured, "drop", reason));
  }

  const first = summarizePairs(pairs.slice(0, INITIAL_PAIRS), direction);
  const firstStats = { ...first, noiseFloor: floor, threshold };
  if (isKeep(firstStats, KEEP_IMPROVED_OF_5) || !isBorderline(firstStats)) {
    throw new DecideInputError(
      "escalation_not_warranted",
      "ten pairs are allowed only after the first five were borderline",
    );
  }
  if (isKeep(stats, KEEP_IMPROVED_OF_10)) return decided(buildDecision(measured, "keep"));
  return decided(buildDecision(measured, "inconclusive", "inconclusive"));
}

function isKeep(stats: StochasticStats, minImproved: number): boolean {
  return stats.medianImprovement >= stats.threshold && stats.improvedPairs >= minImproved;
}

/** Call only for a five-pair result that is not a keep. */
function isBorderline(stats: StochasticStats): boolean {
  return (
    stats.medianImprovement >= stats.threshold / 2 &&
    stats.improvedPairs >= BORDERLINE_IMPROVED_OF_5
  );
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
