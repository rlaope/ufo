import { describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH, ObjectiveSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, metric, objective } from "./fixtures.js";

describe("ObjectiveSchema", () => {
  it("accepts a valid objective and applies defaults", () => {
    const parsed = expectAccepts(ObjectiveSchema, objective());
    expect(parsed.minEffect).toBe(0.03);
    expect(parsed.targetRatio).toBeUndefined();
    expect(parsed.budget).toEqual({ wallClockMinutes: 120, maxTechniques: 10 });
    expect(parsed.guardrails).toEqual([
      { kind: "error_rate", maxDeltaPp: 0.1 },
      { kind: "memory", maxRatio: 1.5 },
    ]);
  });

  it("accepts the minimal form", () => {
    const parsed = expectAccepts(ObjectiveSchema, { primary: metric(), scenario: "startup" });
    expect(parsed.guardrails).toEqual([]);
    expect(parsed.reportedOnly).toEqual([]);
  });

  it("accepts a target ratio and a custom budget", () => {
    const parsed = expectAccepts(ObjectiveSchema, {
      ...objective(),
      targetRatio: 2,
      budget: { maxTechniques: 4 },
    });
    expect(parsed.budget).toEqual({ wallClockMinutes: 120, maxTechniques: 4 });
  });

  it("rejects an empty object", () => {
    expectRejects(ObjectiveSchema, {});
  });

  it.each(["primary", "scenario"] as const)("rejects an objective missing %s", (field) => {
    const value: Record<string, unknown> = objective();
    delete value[field];
    expectRejects(ObjectiveSchema, value);
  });

  it.each([
    ["two primary metrics", { primary: [metric(), metric()] }],
    ["overlong scenario", { scenario: "s".repeat(MAX_NOTE_LENGTH + 1) }],
    ["empty scenario", { scenario: " " }],
    ["zero min effect", { minEffect: 0 }],
    ["min effect of 100%", { minEffect: 1 }],
    ["target ratio of 1", { targetRatio: 1 }],
    ["overlong target ratio", { targetRatio: 1001 }],
    ["duplicate guardrail kinds", { guardrails: [{ kind: "memory" }, { kind: "memory" }] }],
    [
      "too many guardrails",
      {
        guardrails: [
          { kind: "error_rate" },
          { kind: "memory" },
          { kind: "test_pass_set" },
          { kind: "quality" },
          { kind: "quality" },
        ],
      },
    ],
    ["duplicate reported-only metrics", { reportedOnly: [metric(), metric()] }],
    ["primary also reported-only", { reportedOnly: [metric()] }],
    ["too many reported-only metrics", { reportedOnly: manyMetrics(17) }],
    ["bad budget", { budget: { wallClockMinutes: -1 } }],
    ["unknown field", { secondary: metric() }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(ObjectiveSchema, { ...objective(), ...patch });
  });
});

function manyMetrics(count: number) {
  return Array.from({ length: count }, (_, i) => ({ ...metric(), name: `reported_${i}` }));
}
