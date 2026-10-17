import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RERUNS,
  MeasurementError,
  planInterleaved,
  type RunSample,
  runInterleaved,
  type SampleOutcome,
} from "../../../src/core/measure/index.js";
import type { Arm } from "../../../src/domain/index.js";

/** A runSample that logs each call and answers from `script` (keyed `a0`, `b3`, ...) or a value. */
function recorder(script: Record<string, SampleOutcome[]> = {}) {
  const calls: string[] = [];
  const runSample: RunSample = async (arm: Arm, index: number) => {
    const slot = `${arm}${index}`;
    calls.push(slot);
    const next = script[slot]?.shift();
    return next ?? { valid: true, value: arm === "a" ? 100 + index : 90 + index };
  };
  return { calls, runSample };
}

async function caught(promise: Promise<unknown>): Promise<MeasurementError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(MeasurementError);
  return error as MeasurementError;
}

describe("planInterleaved", () => {
  it("alternates A and B, one index per pair", () => {
    expect(planInterleaved(3)).toEqual([
      { arm: "a", index: 0 },
      { arm: "b", index: 0 },
      { arm: "a", index: 1 },
      { arm: "b", index: 1 },
      { arm: "a", index: 2 },
      { arm: "b", index: 2 },
    ]);
  });

  it("continues numbering from firstIndex for escalation pairs", () => {
    expect(planInterleaved(2, 5).map(({ arm, index }) => `${arm}${index}`)).toEqual([
      "a5",
      "b5",
      "a6",
      "b6",
    ]);
  });

  it.each([
    [0, 0],
    [1.5, 0],
    [2, -1],
    [2, 0.5],
  ])("rejects pairCount %s with firstIndex %s", (pairCount, firstIndex) => {
    expect(() => planInterleaved(pairCount, firstIndex)).toThrow(RangeError);
  });
});

describe("runInterleaved", () => {
  it("runs samples one at a time in A B A B order and returns the pairs", async () => {
    const { calls, runSample } = recorder();
    const pairs = await runInterleaved(3, runSample);
    expect(calls).toEqual(["a0", "b0", "a1", "b1", "a2", "b2"]);
    expect(pairs).toEqual([
      { a: 100, b: 90 },
      { a: 101, b: 91 },
      { a: 102, b: 92 },
    ]);
  });

  it("does not start a sample before the previous one finished", async () => {
    let running = 0;
    let overlapped = false;
    const runSample: RunSample = async () => {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return { valid: true, value: 1 };
    };
    await runInterleaved(2, runSample);
    expect(overlapped).toBe(false);
  });

  it("starts at firstIndex", async () => {
    const { calls, runSample } = recorder();
    await runInterleaved(1, runSample, { firstIndex: 5 });
    expect(calls).toEqual(["a5", "b5"]);
  });

  it("re-runs an invalid sample at once and uses the valid re-run", async () => {
    const { calls, runSample } = recorder({
      b0: [{ valid: false, reason: "dropped_iterations 3" }],
    });
    const pairs = await runInterleaved(2, runSample);
    expect(calls).toEqual(["a0", "b0", "b0", "a1", "b1"]);
    expect(pairs).toEqual([
      { a: 100, b: 90 },
      { a: 101, b: 91 },
    ]);
  });

  it(`fails after ${DEFAULT_MAX_RERUNS} re-runs by default`, async () => {
    const invalid = (reason: string): SampleOutcome => ({ valid: false, reason });
    const { calls, runSample } = recorder({
      a1: [
        invalid("sleep/wake"),
        invalid("load"),
        invalid("battery"),
        invalid("load"),
        invalid("x"),
      ],
    });
    const error = await caught(runInterleaved(3, runSample));
    expect(error.code).toBe("too_many_invalid_samples");
    expect(error.arm).toBe("a");
    expect(error.index).toBe(1);
    expect(error.reasons).toEqual(["sleep/wake", "load", "battery", "load"]);
    expect(error.message).toContain("sleep/wake; load; battery; load");
    expect(calls).toEqual(["a0", "b0", "a1", "a1", "a1", "a1"]);
  });

  it("honors a custom re-run bound", async () => {
    const { calls, runSample } = recorder({ a0: [{ valid: false, reason: "battery" }] });
    const error = await caught(runInterleaved(1, runSample, { maxReruns: 0 }));
    expect(error.reasons).toEqual(["battery"]);
    expect(calls).toEqual(["a0"]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("fails on a %s value", async (_label, value) => {
    const { runSample } = recorder({ b0: [{ valid: true, value }] });
    const error = await caught(runInterleaved(1, runSample));
    expect(error.code).toBe("invalid_value");
    expect(error.arm).toBe("b");
  });

  it("propagates a callback failure", async () => {
    const boom = new Error("workload crashed");
    const runSample: RunSample = async () => {
      throw boom;
    };
    await expect(runInterleaved(1, runSample)).rejects.toBe(boom);
  });

  it("rejects a negative or fractional re-run bound", async () => {
    const { runSample } = recorder();
    await expect(runInterleaved(1, runSample, { maxReruns: -1 })).rejects.toThrow(RangeError);
    await expect(runInterleaved(1, runSample, { maxReruns: 1.5 })).rejects.toThrow(RangeError);
  });
});
