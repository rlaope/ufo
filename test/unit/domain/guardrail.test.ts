import { describe, expect, it } from "vitest";
import { GuardrailKindSchema, GuardrailSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects } from "./fixtures.js";

describe("GuardrailSchema", () => {
  it("applies the documented defaults", () => {
    expect(expectAccepts(GuardrailSchema, { kind: "error_rate" })).toEqual({
      kind: "error_rate",
      maxDeltaPp: 0.1,
    });
    expect(expectAccepts(GuardrailSchema, { kind: "memory" })).toEqual({
      kind: "memory",
      maxRatio: 1.2,
    });
    expect(expectAccepts(GuardrailSchema, { kind: "test_pass_set" })).toEqual({
      kind: "test_pass_set",
    });
    expect(expectAccepts(GuardrailSchema, { kind: "quality" })).toEqual({
      kind: "quality",
      floorPp: 1,
    });
  });

  it("accepts quality tolerance inputs", () => {
    expectAccepts(GuardrailSchema, {
      kind: "quality",
      floorPp: 1,
      evalSize: 50,
      baselineSpreadPp: 2.5,
    });
  });

  it("has one enum entry per guardrail kind", () => {
    for (const kind of GuardrailKindSchema.options) {
      expectAccepts(GuardrailSchema, { kind });
    }
    expectRejects(GuardrailKindSchema, "latency");
  });

  it.each([
    ["empty object", {}],
    ["unknown kind", { kind: "latency" }],
    ["negative error delta", { kind: "error_rate", maxDeltaPp: -0.1 }],
    ["overlong error delta", { kind: "error_rate", maxDeltaPp: 101 }],
    ["memory ratio below 1", { kind: "memory", maxRatio: 0.9 }],
    ["overlong memory ratio", { kind: "memory", maxRatio: 101 }],
    ["zero eval size", { kind: "quality", evalSize: 0 }],
    ["fractional eval size", { kind: "quality", evalSize: 12.5 }],
    ["overlong eval size", { kind: "quality", evalSize: 1_000_001 }],
    ["string floor", { kind: "quality", floorPp: "1" }],
    ["field of another kind", { kind: "test_pass_set", maxRatio: 1.2 }],
  ])("rejects %s", (_label, value) => {
    expectRejects(GuardrailSchema, value);
  });
});
