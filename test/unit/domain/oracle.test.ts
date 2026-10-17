import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_LENGTH,
  OracleKindSchema,
  OracleResultSchema,
  OracleSpecSchema,
} from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, oracleResult, SHA_A } from "./fixtures.js";

const spec = () => ({ name: "unit-tests", kind: "test_pass_set", command: "npm test" });

describe("OracleSpecSchema", () => {
  it.each(OracleKindSchema.options)("accepts kind %s", (kind) => {
    expectAccepts(OracleSpecSchema, { ...spec(), kind });
  });

  it("rejects an empty object", () => {
    expectRejects(OracleSpecSchema, {});
  });

  it.each(["name", "kind", "command"] as const)("rejects a spec missing %s", (field) => {
    const value: Record<string, unknown> = spec();
    delete value[field];
    expectRejects(OracleSpecSchema, value);
  });

  it.each([
    ["bad kind", { kind: "vibes" }],
    ["multi-line command", { command: "npm test\nnpm publish" }],
    ["overlong command", { command: "x".repeat(4001) }],
    ["bad name", { name: "Unit Tests" }],
    ["unknown field", { timeout: 5 }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(OracleSpecSchema, { ...spec(), ...patch });
  });
});

describe("OracleResultSchema", () => {
  it("accepts a valid result", () => {
    expect(expectAccepts(OracleResultSchema, oracleResult())).toEqual(oracleResult());
  });

  it("accepts a baseline quality result with a score and an artifact", () => {
    const { changeId: _, ...rest } = oracleResult();
    expectAccepts(OracleResultSchema, {
      ...rest,
      sha: SHA_A,
      oracle: "quality",
      score: 0.82,
      artifactRef: "oracles/quality-baseline.json",
    });
  });

  it("rejects an empty object", () => {
    expectRejects(OracleResultSchema, {});
  });

  it.each(["oracle", "sha", "passed"] as const)("rejects a result missing %s", (field) => {
    const value: Record<string, unknown> = oracleResult();
    delete value[field];
    expectRejects(OracleResultSchema, value);
  });

  it.each([
    ["string passed", { passed: "yes" }],
    ["bad SHA", { sha: "main" }],
    ["bad change id", { changeId: "1" }],
    ["overlong summary", { summary: "s".repeat(MAX_NOTE_LENGTH + 1) }],
    ["absolute artifact", { artifactRef: "/var/log/out.txt" }],
    ["unknown field", { stdout: "ok" }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(OracleResultSchema, { ...oracleResult(), ...patch });
  });
});
