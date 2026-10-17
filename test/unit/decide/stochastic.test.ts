import { describe, expect, it } from "vitest";
import {
  decideStochastic,
  type StochasticInput,
  type StochasticResult,
} from "../../../src/core/decide/index.js";
import {
  checkHygiene,
  describeHygiene,
  type SystemReaders,
} from "../../../src/core/measure/index.js";
import {
  type Decision,
  DecisionSchema,
  MAX_NOTE_LENGTH,
  type Pair,
} from "../../../src/domain/index.js";
import { CHANGE_ID, expectDecideError, pairsAt100, QUIET } from "./fixtures.js";

function input(overrides: Partial<StochasticInput> = {}): StochasticInput {
  return {
    changeId: CHANGE_ID,
    direction: "lower_is_better",
    minEffect: 0.03,
    noiseSamples: QUIET,
    pairs: pairsAt100(90, 91, 89, 92, 90),
    ...overrides,
  };
}

/** Asserts the result is decided, its Decision parses, and returns it. */
function decided(result: StochasticResult): Decision {
  if (result.kind !== "decided") throw new Error(`expected a decision, got ${result.kind}`);
  expect(DecisionSchema.parse(result.decision)).toEqual(result.decision);
  return result.decision;
}

describe("decideStochastic: five pairs", () => {
  it("keeps a median improvement ≥ T with ≥ 4 of 5 pairs improving", () => {
    const result = decideStochastic(input());
    expect(decided(result)).toEqual({
      changeId: CHANGE_ID,
      outcome: "keep",
      effect: 0.1,
      pairs: pairsAt100(90, 91, 89, 92, 90),
    });
    expect(result.stats).toEqual({
      medianImprovement: 0.1,
      improvedPairs: 5,
      pairCount: 5,
      noiseFloor: 0,
      threshold: 0.03,
    });
  });

  it("keeps a median improvement exactly at T", () => {
    expect(
      decided(decideStochastic(input({ pairs: pairsAt100(97, 97, 97, 97, 97) }))).outcome,
    ).toBe("keep");
  });

  it("raises T to twice the noise floor", () => {
    // Noise floor 2.5% → T = 5%: a 4% median that would pass minEffect is only borderline.
    const result = decideStochastic(
      input({ noiseSamples: [95, 97.5, 100, 102.5, 105], pairs: pairsAt100(96, 96, 96, 96, 96) }),
    );
    expect(result.kind).toBe("needs_escalation");
    expect(result.stats.threshold).toBeCloseTo(0.05, 12);
  });

  it("does not keep a large median with only 3 of 5 pairs improving", () => {
    const result = decideStochastic(input({ pairs: pairsAt100(90, 90, 90, 101, 102) }));
    expect(result.kind).toBe("needs_escalation");
  });

  it("drops a median below T/2 as no_effect", () => {
    const decision = decided(decideStochastic(input({ pairs: pairsAt100(99, 100, 98, 99, 101) })));
    expect(decision).toMatchObject({ outcome: "drop", reason: "no_effect", effect: 0.01 });
  });

  it("drops a median worse by at least T as regressed", () => {
    const decision = decided(
      decideStochastic(input({ pairs: pairsAt100(103, 103, 103, 103, 103) })),
    );
    expect(decision).toMatchObject({ outcome: "drop", reason: "regressed", effect: -0.03 });
  });

  it("drops a median worse by less than T as no_effect", () => {
    const decision = decided(
      decideStochastic(input({ pairs: pairsAt100(102, 102, 102, 102, 102) })),
    );
    expect(decision).toMatchObject({ outcome: "drop", reason: "no_effect", effect: -0.02 });
  });

  it("orients improvement for a higher-is-better metric", () => {
    const faster = pairsAt100(110, 109, 111, 108, 110);
    const higher = decided(
      decideStochastic(input({ direction: "higher_is_better", pairs: faster })),
    );
    expect(higher).toMatchObject({ outcome: "keep", effect: 0.1 });
    const lower = decided(decideStochastic(input({ direction: "lower_is_better", pairs: faster })));
    expect(lower).toMatchObject({ outcome: "drop", reason: "regressed", effect: -0.1 });
  });
});

describe("decideStochastic: guardrails and oracles", () => {
  it("drops a keep-worthy change whose guardrail failed", () => {
    const decision = decided(
      decideStochastic(
        input({
          guardrails: [
            { kind: "memory", passed: true },
            { kind: "error_rate", passed: false, detail: "error rate 12.0% vs baseline 0.0%" },
          ],
        }),
      ),
    );
    expect(decision).toMatchObject({
      outcome: "drop",
      reason: "guardrail:error_rate",
      detail: "error rate 12.0% vs baseline 0.0%",
      effect: 0.1,
    });
    expect(decision.pairs).toHaveLength(5);
  });

  it("drops a keep-worthy change whose oracle failed", () => {
    const decision = decided(
      decideStochastic(input({ oracles: [{ oracle: "unit-tests", passed: false }] })),
    );
    expect(decision).toMatchObject({ outcome: "drop", reason: "oracle:unit-tests" });
    expect(decision.detail).toBeUndefined();
  });

  it("reports a failing oracle before a failing guardrail", () => {
    const decision = decided(
      decideStochastic(
        input({
          guardrails: [{ kind: "error_rate", passed: false }],
          oracles: [
            { oracle: "smoke", passed: true },
            { oracle: "http-golden", passed: false, summary: "2 responses differ" },
          ],
        }),
      ),
    );
    expect(decision).toMatchObject({ reason: "oracle:http-golden", detail: "2 responses differ" });
  });

  it("drops on a failed guardrail even when the noise floor is too high", () => {
    const decision = decided(
      decideStochastic(
        input({
          noiseSamples: [100, 80, 120, 70, 130],
          guardrails: [{ kind: "quality", passed: false }],
        }),
      ),
    );
    expect(decision).toMatchObject({ outcome: "drop", reason: "guardrail:quality" });
  });

  it("keeps a change when every gate passed", () => {
    const decision = decided(
      decideStochastic(
        input({
          guardrails: [{ kind: "error_rate", passed: true }],
          oracles: [{ oracle: "unit-tests", passed: true }],
        }),
      ),
    );
    expect(decision.outcome).toBe("keep");
  });

  it("collapses control characters and truncates a long detail", () => {
    const long = decided(
      decideStochastic(
        input({
          guardrails: [{ kind: "memory", passed: false, detail: `rss\n+40%\t${"x".repeat(2000)}` }],
        }),
      ),
    );
    expect(long.detail?.startsWith("rss +40% x")).toBe(true);
    expect(long.detail).toHaveLength(MAX_NOTE_LENGTH);
    const blank = decided(
      decideStochastic(input({ guardrails: [{ kind: "memory", passed: false, detail: "\n\t " }] })),
    );
    expect(blank.detail).toBeUndefined();
  });
});

describe("AC 17: noise floor above 10%", () => {
  const noisy = [100, 80, 120, 70, 130]; // median 100, MAD 20 → noise floor 20%

  it("refuses to decide with policy:noise_floor, naming the cause from the hygiene report", async () => {
    const readers: SystemReaders = {
      platform: "darwin",
      pmsetBatt: async () => "Now drawing from 'Battery Power'\n",
      powerSupplies: async () => [],
      loadAverage: () => 9.5,
      cores: () => 14,
    };
    const cause = describeHygiene(await checkHygiene(readers));
    const result = decideStochastic(input({ noiseSamples: noisy, noiseCause: cause }));
    const decision = decided(result);
    expect(decision).toMatchObject({ outcome: "inconclusive", reason: "policy:noise_floor" });
    expect(decision.detail).toBe(
      "noise floor 20.0% exceeds 10.0%; likely cause: running on battery power; 1-minute load average 9.50 is at or above 7.00 (0.5 x 14 cores)",
    );
    expect(result.stats.noiseFloor).toBeCloseTo(0.2, 12);
  });

  it("names the usual suspects when no cause is supplied", () => {
    const decision = decided(decideStochastic(input({ noiseSamples: noisy })));
    expect(decision.reason).toBe("policy:noise_floor");
    expect(decision.detail).toContain("background apps");
    expect(decision.detail).toContain("deterministic proxy");
  });

  it("still decides at a noise floor of exactly 10%", () => {
    // median 100, MAD 10 → noise floor 10%, T = 20%.
    const result = decideStochastic(
      input({ noiseSamples: [80, 90, 100, 110, 120], pairs: pairsAt100(75, 75, 75, 75, 75) }),
    );
    expect(decided(result).outcome).toBe("keep");
    expect(result.stats.threshold).toBeCloseTo(0.2, 12);
  });
});

describe("AC 20: a borderline change escalates exactly once", () => {
  // T = 3%. Improvements 2%, 2.5%, 2%, -1%, -1%: median 2% ≥ T/2, 3 of 5 improve → borderline.
  const borderline = pairsAt100(98, 97.5, 98, 101, 101);

  /** What the worker does: measure five pairs, then five more at most once. */
  function run(first: Pair[], more: Pair[]) {
    let escalations = 0;
    let pairs = first;
    let result = decideStochastic(input({ pairs }));
    while (result.kind === "needs_escalation") {
      escalations++;
      expect(result.additionalPairs).toBe(5);
      pairs = [...pairs, ...more];
      result = decideStochastic(input({ pairs }));
    }
    return { escalations, decision: decided(result) };
  }

  it("keeps when the ten-pair median ≥ T and 8 of 10 improve", () => {
    // Ten-pair median (2.5% + 5%) / 2 = 3.75%, 8 of 10 improve.
    const { escalations, decision } = run(borderline, pairsAt100(95, 95, 95, 95, 95));
    expect(escalations).toBe(1);
    expect(decision.outcome).toBe("keep");
    expect(decision.effect).toBeCloseTo(0.0375, 12);
    expect(decision.pairs).toHaveLength(10);
  });

  it("is inconclusive when the ten-pair median stays below T", () => {
    const { escalations, decision } = run(borderline, pairsAt100(99, 99, 99, 99, 99));
    expect(escalations).toBe(1);
    expect(decision).toMatchObject({ outcome: "inconclusive", reason: "inconclusive" });
    expect(decision.effect).toBeCloseTo(0.01, 12);
  });

  it("is inconclusive when the ten-pair median ≥ T but only 7 of 10 improve", () => {
    // First five: -1%, 2%, 2.9%, 10%, 10% (median 2.9%, borderline). With -1%, -1%, 10%, 10%,
    // 10% more, the ten-pair median is (2.9% + 10%) / 2 = 6.45%, but 3 of 10 pairs got worse.
    const first = pairsAt100(101, 98, 97.1, 90, 90);
    const { escalations, decision } = run(first, pairsAt100(101, 101, 90, 90, 90));
    expect(escalations).toBe(1);
    expect(decision).toMatchObject({ outcome: "inconclusive", reason: "inconclusive" });
    expect(decision.effect).toBeCloseTo(0.0645, 12);
  });

  it("is inconclusive, not regressed, when the extra pairs are worse", () => {
    const { decision } = run(borderline, pairsAt100(110, 110, 110, 110, 110));
    expect(decision).toMatchObject({ outcome: "inconclusive", reason: "inconclusive" });
  });

  it("refuses ten pairs whose first five were not borderline", () => {
    const keep = pairsAt100(90, 90, 90, 90, 90);
    const drop = pairsAt100(100, 100, 100, 100, 100);
    const more = pairsAt100(95, 95, 95, 95, 95);
    expectDecideError(
      () => decideStochastic(input({ pairs: [...keep, ...more] })),
      "escalation_not_warranted",
    );
    expectDecideError(
      () => decideStochastic(input({ pairs: [...drop, ...more] })),
      "escalation_not_warranted",
    );
  });
});

describe("decideStochastic: input errors", () => {
  it.each([0, 4, 6, 9, 11])("rejects %i pairs", (count) => {
    const pairs = pairsAt100(...Array.from({ length: count }, () => 90));
    expectDecideError(() => decideStochastic(input({ pairs })), "invalid_pair_count");
  });

  it("rejects fewer than five noise samples", () => {
    expectDecideError(
      () => decideStochastic(input({ noiseSamples: [100, 100, 100, 100] })),
      "too_few_samples",
    );
  });

  it.each([0, 1, -0.1, Number.NaN])("rejects minEffect %s", (minEffect) => {
    expectDecideError(() => decideStochastic(input({ minEffect })), "invalid_value");
  });

  it("rejects a pair with A = 0", () => {
    expectDecideError(
      () => decideStochastic(input({ pairs: [{ a: 0, b: 1 }, ...pairsAt100(90, 90, 90, 90)] })),
      "non_positive_baseline",
    );
  });
});
