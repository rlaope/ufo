import type { MetricDirection, Pair } from "../../domain/index.js";

/** The noise floor needs at least this many samples at the current A. */
export const MIN_NOISE_SAMPLES = 5;

/** Above this noise floor UFO refuses to decide (`policy:noise_floor`). */
export const MAX_NOISE_FLOOR = 0.1;

export type DecideInputErrorCode =
  | "too_few_samples"
  | "invalid_value"
  | "non_positive_baseline"
  | "invalid_pair_count"
  | "escalation_not_warranted";

/**
 * Input that no decision can be computed from. This is a caller bug (wrong sample count, a
 * negative or non-finite value), never a measurement outcome: those become a Decision.
 */
export class DecideInputError extends Error {
  override name = "DecideInputError";
  readonly code: DecideInputErrorCode;

  constructor(code: DecideInputErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Throws unless every value is a finite number ≥ 0, the range of a sample value. */
export function assertSampleValues(values: readonly number[], what: string): void {
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) {
      throw new DecideInputError("invalid_value", `${what} must be finite and >= 0, got ${value}`);
    }
  }
}

/** Throws unless `minEffect` is in (0, 1), the range `Objective.minEffect` allows. */
export function assertMinEffect(minEffect: number): void {
  if (!Number.isFinite(minEffect) || minEffect <= 0 || minEffect >= 1) {
    throw new DecideInputError("invalid_value", `minEffect must be in (0, 1), got ${minEffect}`);
  }
}

/** Median; for an even count, the mean of the two middle values. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted.length % 2 === 0 ? sorted[middle - 1] : upper;
  if (upper === undefined || lower === undefined) {
    throw new DecideInputError("too_few_samples", "the median of no values is undefined");
  }
  return (lower + upper) / 2;
}

/**
 * Noise floor of a metric: `MAD / median`, where MAD is the raw (unscaled) median absolute
 * deviation from the median. Pass the latest samples at the current A (baseline runs, or the
 * kept candidate's B samples after a keep); at least `MIN_NOISE_SAMPLES` of them.
 */
export function noiseFloor(values: readonly number[]): number {
  if (values.length < MIN_NOISE_SAMPLES) {
    throw new DecideInputError(
      "too_few_samples",
      `the noise floor needs at least ${MIN_NOISE_SAMPLES} samples, got ${values.length}`,
    );
  }
  assertSampleValues(values, "noise samples");
  const center = median(values);
  if (center <= 0) {
    throw new DecideInputError("non_positive_baseline", "the noise floor needs a positive median");
  }
  return median(values.map((value) => Math.abs(value - center))) / center;
}

/** `T = max(minEffect, 2 × noiseFloor)`: the smallest median improvement that can be kept. */
export function decisionThreshold(minEffect: number, floor: number): number {
  return Math.max(minEffect, 2 * floor);
}

/**
 * Relative improvement of B over A in one pair, oriented so that positive is always better:
 * `(a - b) / a` when lower is better, `(b - a) / a` when higher is better. 0.1 means B is 10%
 * better than A, relative to A. A must be positive.
 */
export function pairImprovement(pair: Pair, direction: MetricDirection): number {
  assertSampleValues([pair.a, pair.b], "pair values");
  if (pair.a <= 0) {
    throw new DecideInputError("non_positive_baseline", "a pair ratio needs a positive A value");
  }
  const delta = direction === "lower_is_better" ? pair.a - pair.b : pair.b - pair.a;
  return delta / pair.a;
}

export interface PairSummary {
  /** Median of the per-pair improvements; this is the Decision's `effect`. */
  readonly medianImprovement: number;
  /** Pairs whose improvement is strictly positive. */
  readonly improvedPairs: number;
  readonly pairCount: number;
}

export function summarizePairs(pairs: readonly Pair[], direction: MetricDirection): PairSummary {
  const improvements = pairs.map((pair) => pairImprovement(pair, direction));
  return {
    medianImprovement: median(improvements),
    improvedPairs: improvements.filter((improvement) => improvement > 0).length,
    pairCount: pairs.length,
  };
}
