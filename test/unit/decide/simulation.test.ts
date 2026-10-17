import { describe, expect, it, type TestContext } from "vitest";
import { decideStochastic, INITIAL_PAIRS } from "../../../src/core/decide/index.js";
import type { Pair } from "../../../src/domain/index.js";
import { gaussian, mulberry32 } from "./random.js";

// AC 1: seeded simulation of the stochastic rule (measurement policy §4.3), including the one
// escalation. Each sample is `truth × (1 + σ·z)`; B's truth is A's truth × (1 − effect), with a
// lower-is-better metric. The noise floor comes from five separate baseline samples at A.

const SEED = 20261017;
const TRIALS = 10_000;
const SIGMA = 0.03;
const MIN_EFFECT = 0.03;
const BASE = 100;
const CHANGE_ID = "3f2b8c1e-5d4a-4b6f-9e7d-1a2b3c4d5e6f";
/** In the outlier scenario, this share of samples is slowed down by `OUTLIER_FACTOR`. */
const OUTLIER_RATE = 0.1;
const OUTLIER_FACTOR = 1.3;

interface Scenario {
  readonly trueEffect: number;
  readonly outlierRate: number;
}

interface Rates {
  readonly keep: number;
  readonly escalated: number;
  /** Inconclusive after the escalation (reason `inconclusive`). */
  readonly inconclusive: number;
  /** Refused as too noisy (reason `policy:noise_floor`). */
  readonly refused: number;
}

function simulate({ trueEffect, outlierRate }: Scenario): Rates {
  const uniform = mulberry32(SEED);
  const normal = gaussian(uniform);
  const draw = (truth: number) => {
    const value = truth * (1 + SIGMA * normal());
    return uniform() < outlierRate ? value * OUTLIER_FACTOR : value;
  };
  const measurePairs = (count: number): Pair[] =>
    Array.from({ length: count }, () => {
      const a = draw(BASE);
      return { a, b: draw(BASE * (1 - trueEffect)) };
    });

  let keep = 0;
  let escalated = 0;
  let inconclusive = 0;
  let refused = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const noiseSamples = Array.from({ length: 5 }, () => draw(BASE));
    const input = {
      changeId: CHANGE_ID,
      direction: "lower_is_better" as const,
      minEffect: MIN_EFFECT,
      noiseSamples,
    };
    const pairs = measurePairs(INITIAL_PAIRS);
    let result = decideStochastic({ ...input, pairs });
    if (result.kind === "needs_escalation") {
      escalated++;
      const more = measurePairs(result.additionalPairs);
      result = decideStochastic({ ...input, pairs: [...pairs, ...more] });
    }
    if (result.kind !== "decided") throw new Error("a ten-pair decision must not escalate");
    if (result.decision.outcome === "keep") keep++;
    if (result.decision.reason === "inconclusive") inconclusive++;
    if (result.decision.reason === "policy:noise_floor") refused++;
  }
  return {
    keep: keep / TRIALS,
    escalated: escalated / TRIALS,
    inconclusive: inconclusive / TRIALS,
    refused: refused / TRIALS,
  };
}

/**
 * Attaches the rates as a test annotation (printed by `--reporter=verbose`) and checks that an
 * `inconclusive` reason only follows an escalation.
 */
async function report(annotate: TestContext["annotate"], label: string, rates: Rates) {
  const pct = (rate: number) => `${(rate * 100).toFixed(2)}%`;
  await annotate(
    `AC 1 ${label}: keep ${pct(rates.keep)}, escalated ${pct(rates.escalated)}, inconclusive ${pct(rates.inconclusive)}, refused as noisy ${pct(rates.refused)} (${TRIALS} trials, seed ${SEED})`,
  );
  expect(rates.inconclusive).toBeLessThanOrEqual(rates.escalated);
}

describe("AC 1: seeded simulation, σ = 3%, minEffect 3%", () => {
  it("keeps at most 5% of A/A changes", async ({ annotate }) => {
    const rates = simulate({ trueEffect: 0, outlierRate: 0 });
    await report(annotate, "A/A", rates);
    expect(rates.keep).toBeLessThanOrEqual(0.05);
  });

  it("keeps at least 90% of true 8% improvements", async ({ annotate }) => {
    const rates = simulate({ trueEffect: 0.08, outlierRate: 0 });
    await report(annotate, "true 8%", rates);
    expect(rates.keep).toBeGreaterThanOrEqual(0.9);
  });

  it("reports the keep rate of true 6% improvements", async ({ annotate }) => {
    const rates = simulate({ trueEffect: 0.06, outlierRate: 0 });
    await report(annotate, "true 6% (reported, not gated)", rates);
  });

  it("reports the A/A keep rate with 10% outlier samples", async ({ annotate }) => {
    const rates = simulate({ trueEffect: 0, outlierRate: OUTLIER_RATE });
    const label = `A/A, ${OUTLIER_RATE * 100}% outliers x${OUTLIER_FACTOR} (reported, not gated)`;
    await report(annotate, label, rates);
  });
});
