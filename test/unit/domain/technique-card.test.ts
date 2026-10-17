import { describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH, TechniqueCardSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, techniqueCard } from "./fixtures.js";

describe("TechniqueCardSchema", () => {
  it("accepts a valid recipe card and applies defaults", () => {
    const parsed = expectAccepts(TechniqueCardSchema, techniqueCard());
    expect(parsed.preconditions).toEqual([]);
    expect(parsed.traps).toEqual([]);
    expect(parsed.pinnedToolVersions).toEqual({});
    expect(parsed.memoryBudget).toBeUndefined();
  });

  it("accepts a guided card without command templates", () => {
    expectAccepts(TechniqueCardSchema, {
      id: "data.n-plus-one",
      domain: "data-postgres",
      title: "Batch-fetch an N+1 association",
      kind: "guided",
      riskClass: "lossless",
      signals: ["one query per row of the parent result set"],
      verifiedIn: ["data-2026-10-20.1"],
    });
  });

  it("accepts every parameter type, a memory budget, and pinned versions", () => {
    expectAccepts(TechniqueCardSchema, {
      ...techniqueCard(),
      riskClass: "lossy",
      params: [
        { name: "threads", type: "integer", min: 1, max: 64, default: 8 },
        { name: "ratio", type: "number", min: 0.1, max: 1, default: 0.5 },
        { name: "cache_type", type: "enum", values: ["f16", "q8_0"], default: "q8_0" },
        { name: "flash", type: "boolean", default: true },
      ],
      commandTemplates: [
        {
          id: "serve",
          run: "llama-server -t {{threads}} --cache-type-k {{cache_type}}",
          params: ["threads", "cache_type"],
        },
      ],
      memoryBudget: { maxRatio: 1.5 },
      pinnedToolVersions: { "llama-cpp": "b6000" },
    });
  });

  it("rejects an empty object", () => {
    expectRejects(TechniqueCardSchema, {});
  });

  it.each(["id", "domain", "title", "kind", "riskClass", "signals", "verifiedIn"] as const)(
    "rejects a card missing %s",
    (field) => {
      const value: Record<string, unknown> = techniqueCard();
      delete value[field];
      expectRejects(TechniqueCardSchema, value);
    },
  );

  it.each([
    ["bad kind", { kind: "auto" }],
    ["bad risk class", { riskClass: "safe" }],
    ["no signals", { signals: [] }],
    ["overlong signal", { signals: ["s".repeat(MAX_NOTE_LENGTH + 1)] }],
    ["too many signals", { signals: Array.from({ length: 33 }, (_, i) => `signal ${i}`) }],
    ["empty verifiedIn list", { verifiedIn: [] }],
    ["bad verifiedIn literal", { verifiedIn: "verified" }],
    ["recipe without templates", { commandTemplates: [] }],
    ["memory budget below 1", { memoryBudget: { maxRatio: 0.5 } }],
    ["unknown field", { owner: "someone" }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(TechniqueCardSchema, { ...techniqueCard(), ...patch });
  });

  it.each([
    ["integer default out of range", { name: "n", type: "integer", min: 1, max: 4, default: 8 }],
    ["fractional integer bound", { name: "n", type: "integer", min: 0.5, max: 4, default: 1 }],
    ["enum default not in values", { name: "n", type: "enum", values: ["a"], default: "b" }],
    ["empty enum", { name: "n", type: "enum", values: [], default: "a" }],
    ["shell metacharacter in enum", { name: "n", type: "enum", values: ["a;rm"], default: "a;rm" }],
    ["free-form string param", { name: "n", type: "string", default: "x" }],
  ])("rejects a param with %s", (_label, param) => {
    expectRejects(TechniqueCardSchema, { ...techniqueCard(), params: [param] });
  });

  it.each([
    ["an undeclared placeholder", "java -Xss{{stack_kb}}k -jar app.jar", ["heap_mb"]],
    ["a placeholder missing from params", "java -Xmx{{heap_mb}}m -jar app.jar", []],
    ["a listed param that is never used", "java -jar app.jar", ["heap_mb"]],
    ["a multi-line command", "java -Xmx{{heap_mb}}m\n-jar app.jar", ["heap_mb"]],
  ])("rejects a template with %s", (_label, run, params) => {
    expectRejects(TechniqueCardSchema, {
      ...techniqueCard(),
      commandTemplates: [{ id: "launch", run, params }],
    });
  });

  it("rejects a template param that the card does not declare", () => {
    expectRejects(TechniqueCardSchema, {
      ...techniqueCard(),
      params: [],
      commandTemplates: [
        { id: "launch", run: "java -Xmx{{heap_mb}}m -jar app.jar", params: ["heap_mb"] },
      ],
    });
  });

  it("rejects duplicate param names and template ids", () => {
    const card = techniqueCard();
    expectRejects(TechniqueCardSchema, {
      ...card,
      params: [card.params?.[0], card.params?.[0]],
    });
    expectRejects(TechniqueCardSchema, {
      ...card,
      commandTemplates: [card.commandTemplates?.[0], card.commandTemplates?.[0]],
    });
  });
});
