import type { Arm, Pair } from "../../domain/index.js";

/** One slot in the interleaved schedule. An A and a B with the same index form a pair. */
export interface PlannedSample {
  readonly arm: Arm;
  readonly index: number;
}

/** A B A B …: pair `i` runs A then B, both with index `firstIndex + i`. */
export function planInterleaved(pairCount: number, firstIndex = 0): PlannedSample[] {
  assertCount(pairCount, "pairCount", 1);
  assertCount(firstIndex, "firstIndex", 0);
  return Array.from({ length: pairCount }, (_, i) => [
    { arm: "a" as const, index: firstIndex + i },
    { arm: "b" as const, index: firstIndex + i },
  ]).flat();
}

/**
 * Result of one sample. An invalid sample (dropped load iterations, sleep/wake, failed hygiene)
 * is re-run; the callback records it, the executor does not use its value.
 */
export type SampleOutcome =
  | { readonly valid: true; readonly value: number }
  | { readonly valid: false; readonly reason: string };

/** Runs one sample of `arm` at `index`, including the workload `reset` before it. */
export type RunSample = (arm: Arm, index: number) => Promise<SampleOutcome>;

/** Re-runs of one slot after an invalid sample, before the measurement fails. */
export const DEFAULT_MAX_RERUNS = 3;

export interface RunInterleavedOptions {
  /** Index of the first pair, e.g. 5 when measuring the escalation pairs. */
  readonly firstIndex?: number;
  readonly maxReruns?: number;
}

export type MeasurementErrorCode = "too_many_invalid_samples" | "invalid_value";

export class MeasurementError extends Error {
  override name = "MeasurementError";
  readonly code: MeasurementErrorCode;
  readonly arm: Arm;
  readonly index: number;
  /** Why each attempt at this slot was invalid, in order. */
  readonly reasons: readonly string[];

  constructor(
    code: MeasurementErrorCode,
    message: string,
    slot: PlannedSample,
    reasons: readonly string[],
  ) {
    super(message);
    this.code = code;
    this.arm = slot.arm;
    this.index = slot.index;
    this.reasons = reasons;
  }
}

/**
 * Runs `pairCount` pairs in the order of `planInterleaved`, one sample at a time. An invalid
 * sample is re-run at once, up to `maxReruns` times; after that the measurement fails with
 * `too_many_invalid_samples`. A valid value that is not finite and ≥ 0 fails with
 * `invalid_value`.
 */
export async function runInterleaved(
  pairCount: number,
  runSample: RunSample,
  options: RunInterleavedOptions = {},
): Promise<Pair[]> {
  const maxReruns = options.maxReruns ?? DEFAULT_MAX_RERUNS;
  assertCount(maxReruns, "maxReruns", 0);
  const pairs: Pair[] = [];
  let pendingA: number | undefined;
  for (const slot of planInterleaved(pairCount, options.firstIndex)) {
    const value = await runValidSample(slot, runSample, maxReruns);
    if (slot.arm === "a") {
      pendingA = value;
    } else if (pendingA !== undefined) {
      pairs.push({ a: pendingA, b: value });
      pendingA = undefined;
    }
  }
  return pairs;
}

async function runValidSample(
  slot: PlannedSample,
  runSample: RunSample,
  maxReruns: number,
): Promise<number> {
  const reasons: string[] = [];
  for (let attempt = 0; attempt <= maxReruns; attempt++) {
    const outcome = await runSample(slot.arm, slot.index);
    if (outcome.valid) {
      if (!Number.isFinite(outcome.value) || outcome.value < 0) {
        throw new MeasurementError(
          "invalid_value",
          `sample ${slot.arm}${slot.index} returned ${outcome.value}; values must be finite and >= 0`,
          slot,
          reasons,
        );
      }
      return outcome.value;
    }
    reasons.push(outcome.reason);
  }
  throw new MeasurementError(
    "too_many_invalid_samples",
    invalidSamplesMessage(slot, reasons),
    slot,
    reasons,
  );
}

/**
 * `sample a0 was invalid 4 times: <reason> (×4)`: each distinct reason once, in first-seen
 * order, with its count when it repeats (a busy machine gives the same reason every rerun).
 */
export function invalidSamplesMessage(slot: PlannedSample, reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const listed = [...counts].map(([reason, n]) => (n > 1 ? `${reason} (×${n})` : reason));
  return `sample ${slot.arm}${slot.index} was invalid ${reasons.length} times: ${listed.join("; ")}`;
}

function assertCount(value: number, name: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}
