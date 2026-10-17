import { describe, expect, it } from "vitest";
import {
  DecisionReasonSchema,
  DecisionSchema,
  MAX_NOTE_LENGTH,
  MAX_PAIRS,
} from "../../../src/domain/index.js";
import { CHANGE_ID, expectAccepts, expectRejects, keepDecision } from "./fixtures.js";

const pairs = (count: number) => Array.from({ length: count }, () => ({ a: 100, b: 99 }));

describe("DecisionReasonSchema", () => {
  it.each([
    "no_effect",
    "regressed",
    "inconclusive",
    "patch_failed",
    "build_failed",
    "guardrail:error_rate",
    "guardrail:memory",
    "guardrail:test_pass_set",
    "guardrail:quality",
    "oracle:quality",
    "oracle:unit-tests",
    "policy:protected_path",
    "policy:test_set_shrunk",
    "policy:noise_floor",
  ])("accepts %s", (reason) => {
    expectAccepts(DecisionReasonSchema, reason);
  });

  it.each([
    ["empty", ""],
    ["unknown reason", "too_slow"],
    ["unknown guardrail", "guardrail:latency"],
    ["empty oracle name", "oracle:"],
    ["empty policy rule", "policy:"],
    ["uppercase rule", "policy:Protected_Path"],
    ["kebab-case rule", "policy:protected-path"],
    ["overlong oracle name", `oracle:${"o".repeat(80)}`],
    ["unknown prefix", "budget:techniques"],
    ["not a string", 1],
  ])("rejects %s", (_label, value) => {
    expectRejects(DecisionReasonSchema, value);
  });
});

describe("DecisionSchema", () => {
  it("accepts a keep decision", () => {
    expect(expectAccepts(DecisionSchema, keepDecision())).toEqual(keepDecision());
  });

  it("accepts a drop before measurement", () => {
    const parsed = expectAccepts(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "drop",
      reason: "policy:protected_path",
    });
    expect(parsed.pairs).toEqual([]);
  });

  it("accepts a measured drop, an escalated inconclusive, and a noise-floor refusal", () => {
    expectAccepts(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "drop",
      effect: -0.05,
      pairs: pairs(5),
      reason: "guardrail:error_rate",
    });
    expectAccepts(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "inconclusive",
      effect: 0.02,
      pairs: pairs(MAX_PAIRS),
      reason: "inconclusive",
    });
    expectAccepts(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "inconclusive",
      effect: 0.01,
      pairs: pairs(5),
      reason: "policy:noise_floor",
      detail: "noise floor 14% at A; the machine is on battery power",
    });
  });

  it("rejects an empty object", () => {
    expectRejects(DecisionSchema, {});
  });

  it.each(["changeId", "outcome"] as const)("rejects a decision missing %s", (field) => {
    const value: Record<string, unknown> = keepDecision();
    delete value[field];
    expectRejects(DecisionSchema, value);
  });

  it.each([
    ["bad outcome", { outcome: "maybe" }],
    ["too many pairs", { pairs: pairs(MAX_PAIRS + 1) }],
    ["negative sample in a pair", { pairs: [{ a: -1, b: 1 }] }],
    ["non-numeric pair", { pairs: [{ a: "100", b: 99 }] }],
    ["infinite effect", { effect: Number.POSITIVE_INFINITY }],
    ["keep with a reason", { reason: "no_effect" }],
    ["keep without pairs", { pairs: [], effect: undefined }],
    ["effect without pairs", { pairs: [] }],
    ["overlong detail", { detail: "d".repeat(MAX_NOTE_LENGTH + 1) }],
    ["bad change id", { changeId: "abc" }],
    ["unknown field", { commitSha: "abc" }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(DecisionSchema, { ...keepDecision(), ...patch });
  });

  it("rejects a drop without a reason", () => {
    expectRejects(DecisionSchema, { changeId: CHANGE_ID, outcome: "drop" });
  });

  it("rejects pairs without an effect", () => {
    expectRejects(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "drop",
      pairs: pairs(5),
      reason: "no_effect",
    });
  });

  it("rejects reason inconclusive on a drop", () => {
    expectRejects(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "drop",
      effect: 0.01,
      pairs: pairs(5),
      reason: "inconclusive",
    });
  });

  it("rejects an inconclusive outcome with a non-policy failure reason", () => {
    expectRejects(DecisionSchema, {
      changeId: CHANGE_ID,
      outcome: "inconclusive",
      effect: 0.01,
      pairs: pairs(5),
      reason: "regressed",
    });
  });
});
