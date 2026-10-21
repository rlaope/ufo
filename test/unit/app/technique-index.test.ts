import { describe, expect, it } from "vitest";
import { indexEntries, MAX_EVIDENCE_CARDS } from "../../../src/app/inspect.js";
import { type HintedFile, hotFrames, MAX_NAME_BYTES } from "../../../src/core/profile/index.js";
import {
  MAX_LABEL_LENGTH,
  type StackId,
  type TechniqueCard,
  TechniqueCardSchema,
} from "../../../src/domain/index.js";
import { MAX_RESULT_BYTES, success } from "../../../src/mcp/results.js";
import { loadCatalog } from "../../../src/techniques/index.js";

// M5 V1: a profile ranks the technique index. The cards whose frame hints its top frames show
// come first, the largest share first, with the matched frames as evidence.

function card(
  id: string,
  frameHints: (string | { match: string; minShare: number })[] = [],
  stacks: string[] = [],
): TechniqueCard {
  return TechniqueCardSchema.parse({
    id: `idx.${id}`,
    domain: "idx",
    title: `Card ${id}`,
    kind: "guided",
    riskClass: "lossless",
    stacks,
    bottlenecks: ["cpu"],
    signals: ["evidence"],
    frameHints,
    expectedEffect: "faster when measured",
    sources: ["https://example.com/ufo-test-fixture"],
    verifiedIn: "unverified",
  });
}

function frames(list: [string, number][]) {
  const file: HintedFile = {
    valid: true,
    self: list.map(([frame, pct]) => ({ frame, pct })),
    total: [],
  };
  return hotFrames([file]);
}

const NONE = new Set<string>();
const NO_STACKS = new Set<StackId>();

describe("the technique index ranked by a profile", () => {
  const cards = [
    card("a-plain"),
    card("b-jackson", ["ObjectMapper.<init>"]),
    card("c-logging", ["OutputStreamAppender.subAppend", "AppenderBase.doAppend"]),
    card("d-startup", [{ match: "preInstantiateSingletons", minShare: 0.3 }]),
    card("e-node", [], ["node"]),
  ];

  it("lists matching cards first, the largest share first, then the usual order", () => {
    const { cards: listed, evidenceOmitted } = indexEntries(
      cards,
      new Set(["idx.c-logging"]),
      new Set<StackId>(["node"]),
      frames([
        ["com/fasterxml/jackson/databind/ObjectMapper.<init>", 12],
        ["ch.qos.logback.core.OutputStreamAppender.subAppend", 30],
        ["ch.qos.logback.core.UnsynchronizedAppenderBase.doAppend", 31],
        [
          "org.springframework.beans.factory.support.DefaultListableBeanFactory.preInstantiateSingletons",
          20,
        ],
      ]),
    );
    expect(listed.map((entry) => entry.id)).toEqual([
      "idx.c-logging",
      "idx.b-jackson",
      "idx.e-node",
      "idx.a-plain",
      "idx.d-startup",
    ]);
    expect(evidenceOmitted).toBeUndefined();
    expect(listed[0]).toMatchObject({
      enabled: true,
      expectedEffect: "faster when measured",
      evidence: [
        {
          hint: "AppenderBase.doAppend",
          frame: "ch.qos.logback.core.UnsynchronizedAppenderBase.doAppend",
          share: 0.31,
          kind: "self",
        },
        {
          hint: "OutputStreamAppender.subAppend",
          frame: "ch.qos.logback.core.OutputStreamAppender.subAppend",
          share: 0.3,
          kind: "self",
        },
      ],
    });
    // The cards the profile does not point at stay short: no evidence, no expected effect.
    for (const entry of listed.slice(2)) {
      expect(entry.evidence).toBeUndefined();
      expect(entry.expectedEffect).toBeUndefined();
    }
  });

  it("is the usual index without frames", () => {
    const { cards: listed } = indexEntries(cards, NONE, new Set<StackId>(["node"]));
    expect(listed.map((entry) => entry.id)).toEqual([
      "idx.e-node",
      "idx.a-plain",
      "idx.b-jackson",
      "idx.c-logging",
      "idx.d-startup",
    ]);
    for (const entry of listed) {
      expect(entry.expectedEffect).toBe("faster when measured");
      expect(entry).not.toHaveProperty("evidence");
    }
  });

  it("gives evidence to the first cards it points at, and counts the others", () => {
    const many = Array.from({ length: MAX_EVIDENCE_CARDS + 3 }, (_, i) =>
      card(`m${String(i).padStart(2, "0")}`, [`hot.frame${String(i).padStart(2, "0")}`]),
    );
    const { cards: listed, evidenceOmitted } = indexEntries(
      [card("plain"), ...many],
      NONE,
      NO_STACKS,
      frames(many.map((_, i) => [`hot.frame${String(i).padStart(2, "0")}`, 10 + i])),
    );
    // The largest share first: the last card's frame is the hottest.
    expect(listed.map((entry) => entry.id).slice(0, 3)).toEqual(["idx.m14", "idx.m13", "idx.m12"]);
    expect(listed.filter((entry) => entry.evidence !== undefined)).toHaveLength(MAX_EVIDENCE_CARDS);
    expect(listed.slice(0, MAX_EVIDENCE_CARDS).every((entry) => entry.evidence)).toBe(true);
    expect(evidenceOmitted).toBe(3);
    expect(listed.at(-1)?.id).toBe("idx.plain");
  });

  it("stays within the result budget with every built-in card matched at its bounds", async () => {
    // Every card's hints at the frame-name bound (a hint longer than a shown frame never
    // matches), each frame the most bytes a summary shows, every card matching three of them.
    const catalog = [...(await loadCatalog()).cards.values()];
    expect(catalog.length).toBeGreaterThan(50);
    const names = [0, 1, 2].map((i) => `${String(i)}"\\`.padEnd(MAX_NAME_BYTES - 2, "x"));
    for (const name of names)
      expect(Buffer.byteLength(JSON.stringify(name)) - 2).toBe(MAX_NAME_BYTES);
    const widest = catalog.map((entry) => ({
      ...entry,
      frameHints: names.map((match) => ({ match, minShare: 0.05 })),
      expectedEffect: "x".repeat(MAX_LABEL_LENGTH),
    }));
    const listing = indexEntries(
      widest,
      new Set(catalog.map((entry) => entry.id)),
      NO_STACKS,
      frames(names.map((name) => [name, 99.9])),
    );
    expect(listing.cards.filter((entry) => entry.evidence?.length === 3)).toHaveLength(
      MAX_EVIDENCE_CARDS,
    );
    expect(listing.evidenceOmitted).toBe(catalog.length - MAX_EVIDENCE_CARDS);
    const text = JSON.stringify(
      success({
        ...listing,
        note: "x".repeat(MAX_LABEL_LENGTH),
        configError: "x".repeat(MAX_LABEL_LENGTH),
      }).structuredContent,
    );
    expect(text).not.toContain("truncated");
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_RESULT_BYTES);
  });
});
