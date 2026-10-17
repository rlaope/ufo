import { describe, expect, it } from "vitest";
import {
  type DeterministicInput,
  type DeterministicResult,
  decideDeterministic,
} from "../../../src/core/decide/index.js";
import { type Decision, DecisionSchema } from "../../../src/domain/index.js";
import { CHANGE_ID, expectDecideError } from "./fixtures.js";

const BUNDLE_BYTES = 500_000;

function input(overrides: Partial<DeterministicInput> = {}): DeterministicInput {
  return {
    changeId: CHANGE_ID,
    direction: "lower_is_better",
    minEffect: 0.03,
    a: [BUNDLE_BYTES, BUNDLE_BYTES],
    b: [480_000, 480_000],
    ...overrides,
  };
}

function decided(result: DeterministicResult): Decision {
  if (result.kind !== "decided") throw new Error(`expected a decision, got ${result.kind}`);
  expect(DecisionSchema.parse(result.decision)).toEqual(result.decision);
  return result.decision;
}

describe("AC 19: deterministic metrics", () => {
  it("keeps a reduction ≥ minEffect from one run per arm plus one repeat", () => {
    expect(decided(decideDeterministic(input()))).toEqual({
      changeId: CHANGE_ID,
      outcome: "keep",
      effect: 0.04,
      pairs: [
        { a: BUNDLE_BYTES, b: 480_000 },
        { a: BUNDLE_BYTES, b: 480_000 },
      ],
    });
  });

  it("keeps a reduction of exactly minEffect", () => {
    const decision = decided(decideDeterministic(input({ b: [485_000, 485_000] })));
    expect(decision).toMatchObject({ outcome: "keep", effect: 0.03 });
  });

  it("drops a 1-byte reduction as no_effect", () => {
    const decision = decided(decideDeterministic(input({ b: [499_999, 499_999] })));
    expect(decision).toMatchObject({ outcome: "drop", reason: "no_effect" });
    expect(decision.effect).toBeCloseTo(1 / BUNDLE_BYTES, 15);
  });

  it("drops any increase as regressed", () => {
    const decision = decided(decideDeterministic(input({ b: [500_001, 500_001] })));
    expect(decision).toMatchObject({ outcome: "drop", reason: "regressed" });
  });

  it("drops an unchanged value as no_effect", () => {
    const decision = decided(decideDeterministic(input({ b: [BUNDLE_BYTES, BUNDLE_BYTES] })));
    expect(decision).toMatchObject({ outcome: "drop", reason: "no_effect", effect: 0 });
  });

  it("flags a non-repeating B value for reclassification as stochastic", () => {
    expect(decideDeterministic(input({ b: [480_000, 480_100] }))).toEqual({
      kind: "reclassify_stochastic",
      arms: ["b"],
    });
  });

  it("flags both arms when neither repeats", () => {
    expect(decideDeterministic(input({ a: [500_000, 500_010], b: [480_000, 480_100] }))).toEqual({
      kind: "reclassify_stochastic",
      arms: ["a", "b"],
    });
  });

  it("orients improvement for a higher-is-better metric", () => {
    const decision = decided(
      decideDeterministic(input({ direction: "higher_is_better", a: [200, 200], b: [220, 220] })),
    );
    expect(decision).toMatchObject({ outcome: "keep" });
    expect(decision.effect).toBeCloseTo(0.1, 12);
  });

  it("drops a reduction whose oracle failed, before checking repeatability", () => {
    const decision = decided(
      decideDeterministic(
        input({
          b: [480_000, 480_100],
          oracles: [{ oracle: "smoke", passed: false, summary: "page renders blank" }],
          guardrails: [{ kind: "test_pass_set", passed: false }],
        }),
      ),
    );
    expect(decision).toMatchObject({
      outcome: "drop",
      reason: "oracle:smoke",
      detail: "page renders blank",
    });
  });

  it("drops a reduction whose guardrail failed", () => {
    const decision = decided(
      decideDeterministic(input({ guardrails: [{ kind: "test_pass_set", passed: false }] })),
    );
    expect(decision).toMatchObject({ outcome: "drop", reason: "guardrail:test_pass_set" });
  });

  it("rejects invalid values", () => {
    expectDecideError(() => decideDeterministic(input({ a: [0, 0] })), "non_positive_baseline");
    expectDecideError(() => decideDeterministic(input({ b: [-1, -1] })), "invalid_value");
    expectDecideError(() => decideDeterministic(input({ minEffect: 0 })), "invalid_value");
  });
});
