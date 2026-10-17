import { describe, expect, it } from "vitest";
import { EvidenceBundleSchema } from "../../../src/domain/index.js";
import {
  change,
  evidenceBundle,
  expectAccepts,
  expectRejects,
  keepDecision,
  OTHER_CHANGE_ID,
  oracleResult,
  sample,
} from "./fixtures.js";

describe("EvidenceBundleSchema", () => {
  it("accepts a valid bundle", () => {
    const parsed = expectAccepts(EvidenceBundleSchema, evidenceBundle());
    expect(parsed.modelIdSource).toBe("self_reported");
    expect(parsed.objective.minEffect).toBe(0.03);
  });

  it("accepts a recipe-only bundle without a model id", () => {
    const { modelId: _m, modelIdSource: _s, ...rest } = evidenceBundle();
    expectAccepts(EvidenceBundleSchema, { ...rest, hostAgent: "none" });
  });

  it("rejects an empty object", () => {
    expectRejects(EvidenceBundleSchema, {});
  });

  it.each([
    "schemaVersion",
    "bundleId",
    "createdAt",
    "objective",
    "machine",
    "commands",
    "toolVersions",
    "shas",
    "samples",
    "changes",
    "oracleResults",
    "decisions",
    "limitations",
    "hostAgent",
  ] as const)("rejects a bundle missing %s", (field) => {
    const value: Record<string, unknown> = evidenceBundle();
    delete value[field];
    expectRejects(EvidenceBundleSchema, value);
  });

  it.each([
    ["future schema version", { schemaVersion: 2 }],
    ["bad created-at", { createdAt: "yesterday" }],
    ["bad baseline SHA", { shas: { baseline: "abc", final: "abc" } }],
    ["missing final SHA", { shas: { baseline: "0123456789abcdef0123456789abcdef01234567" } }],
    ["model id source other than self-reported", { modelIdSource: "verified" }],
    ["model id without a source", { modelIdSource: undefined }],
    ["source without a model id", { modelId: undefined }],
    ["overlong limitation", { limitations: ["l".repeat(1001)] }],
    ["too many limitations", { limitations: Array.from({ length: 257 }, (_, i) => `l${i}`) }],
    ["too many commands", { commands: Array.from({ length: 257 }, (_, i) => `echo ${i}`) }],
    ["bad host agent", { hostAgent: "Claude Code" }],
    ["duplicate changes", { changes: [change(), change()] }],
    ["duplicate decisions", { decisions: [keepDecision(), keepDecision()] }],
    [
      "decision for an unknown change",
      { decisions: [{ ...keepDecision(), changeId: OTHER_CHANGE_ID }] },
    ],
    ["sample for an unknown change", { samples: [{ ...sample(), changeId: OTHER_CHANGE_ID }] }],
    [
      "oracle result for an unknown change",
      { oracleResults: [{ ...oracleResult(), changeId: OTHER_CHANGE_ID }] },
    ],
    ["unknown field", { hostname: "build-box" }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(EvidenceBundleSchema, { ...evidenceBundle(), ...patch });
  });
});
