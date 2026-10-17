import { describe, expect, it } from "vitest";
import { BudgetSchema, MAX_TECHNIQUES, MAX_WALL_CLOCK_MINUTES } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects } from "./fixtures.js";

describe("BudgetSchema", () => {
  it("defaults to 120 minutes and 10 techniques", () => {
    expect(expectAccepts(BudgetSchema, {})).toEqual({ wallClockMinutes: 120, maxTechniques: 10 });
  });

  it("accepts explicit values at the limits", () => {
    expectAccepts(BudgetSchema, { wallClockMinutes: MAX_WALL_CLOCK_MINUTES, maxTechniques: 1 });
  });

  it.each([
    ["zero minutes", { wallClockMinutes: 0 }],
    ["overlong minutes", { wallClockMinutes: MAX_WALL_CLOCK_MINUTES + 1 }],
    ["too many techniques", { maxTechniques: MAX_TECHNIQUES + 1 }],
    ["fractional techniques", { maxTechniques: 2.5 }],
    ["string minutes", { wallClockMinutes: "120" }],
    ["unknown field", { dollars: 5 }],
    ["not an object", 120],
  ])("rejects %s", (_label, value) => {
    expectRejects(BudgetSchema, value);
  });
});
