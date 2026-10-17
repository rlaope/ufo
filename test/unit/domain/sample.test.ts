import { describe, expect, it } from "vitest";
import {
  MAX_RECORD_ENTRIES,
  MAX_SAMPLE_DURATION_MS,
  SampleSchema,
} from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, SHA_A, sample } from "./fixtures.js";

describe("SampleSchema", () => {
  it("accepts a valid change sample", () => {
    expect(expectAccepts(SampleSchema, sample())).toEqual(sample());
  });

  it("accepts a baseline sample without a change id and an invalid sample with a reason", () => {
    const { changeId: _, ...rest } = sample();
    const parsed = expectAccepts(SampleSchema, {
      ...rest,
      phase: "baseline",
      arm: "a",
      sha: SHA_A,
      secondary: undefined,
      valid: false,
      invalidReason: "k6 reported dropped_iterations > 0",
      startedAt: "2026-10-17T18:30:00+09:00",
    });
    expect(parsed.secondary).toEqual({});
  });

  it("rejects an empty object", () => {
    expectRejects(SampleSchema, {});
  });

  it.each([
    "phase",
    "arm",
    "sha",
    "index",
    "metric",
    "value",
    "startedAt",
    "durationMs",
    "valid",
  ] as const)("rejects a sample missing %s", (field) => {
    const value: Record<string, unknown> = sample();
    delete value[field];
    expectRejects(SampleSchema, value);
  });

  it.each([
    ["bad arm", { arm: "c" }],
    ["bad phase", { phase: "warmup" }],
    ["negative value", { value: -1 }],
    ["NaN value", { value: Number.NaN }],
    ["fractional index", { index: 1.5 }],
    ["overlong index", { index: 1000 }],
    ["overlong duration", { durationMs: MAX_SAMPLE_DURATION_MS + 1 }],
    ["date without time", { startedAt: "2026-10-17" }],
    ["bad SHA", { sha: "HEAD" }],
    [
      "too many secondary values",
      {
        secondary: Object.fromEntries(
          Array.from({ length: MAX_RECORD_ENTRIES + 1 }, (_, i) => [`m${i}`, i]),
        ),
      },
    ],
    ["non-numeric secondary value", { secondary: { rss_bytes: "300MB" } }],
    ["change sample without change id", { changeId: undefined }],
    ["valid sample with an invalid reason", { invalidReason: "slept" }],
    ["invalid sample without a reason", { valid: false }],
    ["unknown field", { pid: 123 }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(SampleSchema, { ...sample(), ...patch });
  });

  it("rejects a baseline sample that names a change", () => {
    expectRejects(SampleSchema, { ...sample(), phase: "baseline" });
  });
});
