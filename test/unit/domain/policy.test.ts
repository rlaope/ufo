import { describe, expect, it } from "vitest";
import { PolicySchema, TargetSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, policy } from "./fixtures.js";

/** A hostname of `labels` maximal 63-character labels. */
const longHostname = (labels: number) =>
  Array.from({ length: labels }, () => "a".repeat(63)).join(".");

describe("TargetSchema", () => {
  it.each(["127.0.0.1", "10.0.0.0/8", "::1", "fd00::/8", "db.internal", "localhost"])(
    "accepts %s",
    (target) => {
      expectAccepts(TargetSchema, target);
    },
  );

  it("accepts a hostname at the 253-character limit", () => {
    expectAccepts(TargetSchema, `${longHostname(3)}.${"b".repeat(61)}`);
  });

  it.each([
    ["empty", ""],
    ["URL", "http://10.0.0.1:8080/"],
    ["host with port", "db.internal:5432"],
    ["space", "db internal"],
    ["out-of-range CIDR", "10.0.0.0/33"],
    ["overlong hostname", longHostname(4)],
    ["not a string", 10],
  ])("rejects %s", (_label, value) => {
    expectRejects(TargetSchema, value);
  });
});

describe("PolicySchema", () => {
  it("accepts a valid policy and applies the default budget", () => {
    const parsed = expectAccepts(PolicySchema, policy());
    expect(parsed.budget).toEqual({ wallClockMinutes: 120, maxTechniques: 10 });
  });

  it("defaults opt-ins and targets to none", () => {
    const { optIns: _o, targets: _t, ...rest } = policy();
    const parsed = expectAccepts(PolicySchema, rest);
    expect(parsed.optIns).toEqual([]);
    expect(parsed.targets).toEqual([]);
  });

  it("rejects an empty object", () => {
    expectRejects(PolicySchema, {});
  });

  it.each(["protectedPaths", "approvedConfigHash"] as const)(
    "rejects a policy missing %s",
    (field) => {
      const value: Record<string, unknown> = policy();
      delete value[field];
      expectRejects(PolicySchema, value);
    },
  );

  it.each([
    ["bad opt-in", { optIns: ["numeric"] }],
    ["duplicate opt-ins", { optIns: ["lossy", "lossy"] }],
    [
      "uppercase hash",
      { approvedConfigHash: "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855" },
    ],
    ["short hash", { approvedConfigHash: "e3b0c442" }],
    ["absolute protected path", { protectedPaths: ["/etc/**"] }],
    [
      "too many protected paths",
      { protectedPaths: Array.from({ length: 257 }, (_, i) => `p${i}`) },
    ],
    ["too many targets", { targets: Array.from({ length: 65 }, (_, i) => `10.0.0.${i}`) }],
    ["bad target", { targets: ["http://example.com"] }],
    ["bad budget", { budget: { maxTechniques: 0 } }],
    ["unknown field", { allowSudo: true }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(PolicySchema, { ...policy(), ...patch });
  });
});
