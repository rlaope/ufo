import { describe, expect, it } from "vitest";
import { ChangeSchema, MAX_DIFF_LENGTH, MAX_HYPOTHESIS_LENGTH } from "../../../src/domain/index.js";
import { change, DIFF, expectAccepts, expectRejects } from "./fixtures.js";

describe("ChangeSchema", () => {
  it("accepts a valid change", () => {
    expect(expectAccepts(ChangeSchema, change())).toEqual(change());
  });

  it("defaults evidence refs to an empty list", () => {
    const { evidenceRefs: _, ...withoutRefs } = change();
    expect(expectAccepts(ChangeSchema, withoutRefs).evidenceRefs).toEqual([]);
  });

  it("accepts a hypothesis at the length limit", () => {
    expectAccepts(ChangeSchema, { ...change(), hypothesis: "h".repeat(MAX_HYPOTHESIS_LENGTH) });
  });

  it("rejects an empty object", () => {
    expectRejects(ChangeSchema, {});
  });

  it.each(["changeId", "baseSha", "cardId", "diff", "hypothesis"] as const)(
    "rejects a change missing %s",
    (field) => {
      const value: Record<string, unknown> = change();
      delete value[field];
      expectRejects(ChangeSchema, value);
    },
  );

  it.each([
    ["overlong hypothesis", { hypothesis: "h".repeat(MAX_HYPOTHESIS_LENGTH + 1) }],
    ["empty hypothesis", { hypothesis: "   " }],
    ["control character in hypothesis", { hypothesis: "faster\u0007" }],
    ["overlong diff", { diff: DIFF + "+".repeat(MAX_DIFF_LENGTH) }],
    ["empty diff", { diff: "" }],
    ["text that is not a diff", { diff: "please make it faster" }],
    ["NUL byte in diff", { diff: `${DIFF}\u0000` }],
    ["abbreviated base SHA", { baseSha: "0123456" }],
    ["uppercase base SHA", { baseSha: "0123456789ABCDEF0123456789ABCDEF01234567" }],
    ["change id that is not a UUID", { changeId: "change-1" }],
    ["bad card id", { cardId: "Heap Size" }],
    ["absolute evidence ref", { evidenceRefs: ["/tmp/flame.html"] }],
    ["duplicate evidence refs", { evidenceRefs: ["a.html", "a.html"] }],
    ["too many evidence refs", { evidenceRefs: Array.from({ length: 33 }, (_, i) => `e${i}`) }],
    ["unknown field", { riskClass: "lossless" }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(ChangeSchema, { ...change(), ...patch });
  });
});
