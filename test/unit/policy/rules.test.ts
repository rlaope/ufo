import { describe, expect, it } from "vitest";
import {
  checkOptIn,
  consume,
  POLICY_RULES,
  PolicyError,
  startBudget,
  violation,
} from "../../../src/core/policy/index.js";
import {
  DecisionReasonSchema,
  labelSchema,
  MAX_NOTE_LENGTH,
  PolicyRuleSchema,
} from "../../../src/domain/index.js";

describe("POLICY_RULES", () => {
  it("names each rule once, in the domain's rule format", () => {
    expect(new Set(POLICY_RULES).size).toBe(POLICY_RULES.length);
    for (const rule of POLICY_RULES) {
      expect(PolicyRuleSchema.safeParse(rule).success).toBe(true);
      expect(DecisionReasonSchema.safeParse(`policy:${rule}`).success).toBe(true);
    }
  });

  it("includes every rule the plan requires", () => {
    expect(POLICY_RULES).toEqual(
      expect.arrayContaining([
        "protected_path",
        "test_set_shrunk",
        "unapproved_config",
        "config_changed",
        "opt_in_required",
        "target_not_allowed",
        "non_tty_approval",
        "budget_exceeded",
        "noise_floor",
        "out_of_scope",
      ]),
    );
  });
});

describe("violation", () => {
  it("keeps the detail to one bounded line", () => {
    const v = violation("protected_path", `line one\nline two\t${"x".repeat(2 * MAX_NOTE_LENGTH)}`);
    expect(labelSchema(MAX_NOTE_LENGTH).safeParse(v.detail).success).toBe(true);
    expect(v.detail.startsWith("line one line two")).toBe(true);
  });

  it("is carried by PolicyError", () => {
    const error = new PolicyError(violation("noise_floor", "noise 14% > 10%: battery power"));
    expect(error.message).toBe("policy:noise_floor: noise 14% > 10%: battery power");
  });
});

describe("checkOptIn", () => {
  it("needs no opt-in for lossless and numeric cards", () => {
    expect(checkOptIn("lossless", [])).toBeUndefined();
    expect(checkOptIn("numeric", [])).toBeUndefined();
  });

  it("needs the matching opt-in for lossy and upgrade cards", () => {
    expect(checkOptIn("lossy", [])?.rule).toBe("opt_in_required");
    expect(checkOptIn("lossy", ["upgrade"])?.rule).toBe("opt_in_required");
    expect(checkOptIn("lossy", ["lossy"])).toBeUndefined();
    expect(checkOptIn("upgrade", ["lossy"])?.rule).toBe("opt_in_required");
    expect(checkOptIn("upgrade", ["upgrade"])).toBeUndefined();
  });
});

describe("budget counter", () => {
  const limits = { wallClockMinutes: 60, maxTechniques: 3 };

  it("allows spending below the caps", () => {
    let counter = startBudget(limits);
    for (let i = 0; i < 2; i++) {
      const result = consume(counter, { techniques: 1, wallClockMs: 60_000 });
      expect(result.violation).toBeUndefined();
      counter = result.counter;
    }
    expect(counter).toEqual({ limits, techniques: 2, wallClockMs: 120_000 });
  });

  it("stops when the technique cap is reached", () => {
    const counter = { ...startBudget(limits), techniques: 2 };
    const result = consume(counter, { techniques: 1 });
    expect(result.violation).toMatchObject({ rule: "budget_exceeded" });
    expect(result.violation?.detail).toContain("3 of 3 techniques");
  });

  it("stops when the wall-clock budget is used up", () => {
    const result = consume(startBudget(limits), { wallClockMs: 60 * 60_000 });
    expect(result.violation?.detail).toContain("60 of 60 minutes");
  });

  it("refuses negative or non-finite spending", () => {
    expect(() => consume(startBudget(limits), { techniques: -1 })).toThrow(RangeError);
    expect(() => consume(startBudget(limits), { wallClockMs: Number.NaN })).toThrow(RangeError);
  });
});
