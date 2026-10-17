import { describe, expect, it } from "vitest";
import {
  decisionThreshold,
  median,
  noiseFloor,
  pairImprovement,
  summarizePairs,
} from "../../../src/core/decide/index.js";
import { expectDecideError, pairsAt100 } from "./fixtures.js";

describe("median", () => {
  it("takes the middle value of an odd count", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the two middle values of an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("does not reorder its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it("rejects an empty list", () => {
    expectDecideError(() => median([]), "too_few_samples");
  });
});

describe("noiseFloor", () => {
  it("is the raw MAD over the median", () => {
    // median 11; absolute deviations 1, 1, 2, 0, 19 → MAD 1.
    expect(noiseFloor([10, 12, 9, 11, 30])).toBeCloseTo(1 / 11, 12);
  });

  it("uses every value it is given", () => {
    // median 100; absolute deviations 0, 10, 10, 20, 20, 30, 30 → MAD 20.
    expect(noiseFloor([100, 90, 110, 80, 120, 70, 130])).toBeCloseTo(0.2, 12);
  });

  it("is 0 when the samples repeat", () => {
    expect(noiseFloor([7, 7, 7, 7, 7])).toBe(0);
  });

  it("needs at least five samples", () => {
    expectDecideError(() => noiseFloor([100, 101, 99, 100]), "too_few_samples");
  });

  it("needs a positive median", () => {
    expectDecideError(() => noiseFloor([0, 0, 0, 1, 2]), "non_positive_baseline");
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a %s sample", (_label, bad) => {
    expectDecideError(() => noiseFloor([100, 100, 100, 100, bad]), "invalid_value");
  });
});

describe("decisionThreshold", () => {
  it("is minEffect while the noise floor is below half of it", () => {
    expect(decisionThreshold(0.03, 0.01)).toBe(0.03);
  });

  it("is twice the noise floor above that", () => {
    expect(decisionThreshold(0.03, 0.025)).toBe(0.05);
  });
});

describe("pairImprovement", () => {
  it("is positive when B is lower and lower is better", () => {
    expect(pairImprovement({ a: 200, b: 180 }, "lower_is_better")).toBeCloseTo(0.1, 12);
  });

  it("is negative when B is lower and higher is better", () => {
    expect(pairImprovement({ a: 200, b: 180 }, "higher_is_better")).toBeCloseTo(-0.1, 12);
  });

  it("is positive when B is higher and higher is better", () => {
    expect(pairImprovement({ a: 50, b: 60 }, "higher_is_better")).toBeCloseTo(0.2, 12);
  });

  it("is relative to A", () => {
    // Halving latency is a 50% improvement; doubling throughput is a 100% improvement.
    expect(pairImprovement({ a: 100, b: 50 }, "lower_is_better")).toBe(0.5);
    expect(pairImprovement({ a: 100, b: 200 }, "higher_is_better")).toBe(1);
  });

  it("needs a positive A", () => {
    expectDecideError(
      () => pairImprovement({ a: 0, b: 1 }, "lower_is_better"),
      "non_positive_baseline",
    );
  });

  it("rejects a negative B", () => {
    expectDecideError(() => pairImprovement({ a: 1, b: -1 }, "lower_is_better"), "invalid_value");
  });
});

describe("summarizePairs", () => {
  it("counts only strictly positive improvements", () => {
    const summary = summarizePairs(pairsAt100(90, 100, 110, 95, 99), "lower_is_better");
    expect(summary).toEqual({ medianImprovement: 0.01, improvedPairs: 3, pairCount: 5 });
  });
});
