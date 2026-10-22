import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDEX_PAGE,
  indexEntries,
  indexPage,
  MAX_EVIDENCE_CARDS,
  MAX_INDEX_PAGE,
  MAX_INDEX_PAGE_BYTES,
  type TechniqueListing,
} from "../../../src/app/inspect.js";
import {
  displayName,
  type HintedFile,
  hotFrames,
  MAX_EVIDENCE,
  MAX_NAME_BYTES,
} from "../../../src/core/profile/index.js";
import {
  BottleneckSchema,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  type StackId,
  StackIdSchema,
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

  it("is the usual index when the frames point at no card", () => {
    const { cards: listed, evidenceOmitted } = indexEntries(
      cards,
      NONE,
      new Set<StackId>(["node"]),
      frames([["main.handler", 90]]),
    );
    expect(listed).toEqual(indexEntries(cards, NONE, new Set<StackId>(["node"])).cards);
    expect(listed.every((entry) => entry.expectedEffect === "faster when measured")).toBe(true);
    expect(evidenceOmitted).toBeUndefined();
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

  it("does not point at classpath scanning for the share every Spring startup has", async () => {
    const catalog = [...(await loadCatalog()).cards.values()];
    const spring = (pct: number) =>
      frames([
        ["org/springframework/context/annotation/ClassPathBeanDefinitionScanner.doScan", pct],
        ["org/springframework/context/annotation/ComponentScanAnnotationParser.parse", pct],
        [
          displayName(
            "org/springframework/context/annotation/ClassPathScanningCandidateComponentProvider.findCandidateComponents",
          ),
          pct,
        ],
        [
          displayName(
            "org/springframework/boot/autoconfigure/AutoConfigurationImportSelector.getAutoConfigurationEntry",
          ),
          pct,
        ],
      ]);
    const matched = (pct: number) =>
      indexEntries(catalog, NONE, NO_STACKS, spring(pct))
        .cards.filter((entry) => entry.evidence !== undefined)
        .map((entry) => entry.id);
    expect(matched(9.9)).toEqual([]);
    expect(matched(12)).toEqual(["jvm.reduce-classpath-scanning", "jvm.spring-aot-processing"]);
  });
});

// M6: the index comes in pages, so a catalog of any size fits the result budget.

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Every page of `listing` from the first on, `limit` entries at most each. */
function pages(listing: Omit<TechniqueListing, "total">, limit: number, key = "k") {
  const all = [indexPage(listing, 0, limit, key)];
  for (let next = all[0]?.nextCursor; next !== undefined; next = all.at(-1)?.nextCursor) {
    all.push(indexPage(listing, Number(next.split(".")[0]), limit, key));
  }
  return all;
}

describe("pages of the technique index", () => {
  // One character JSON writes as six bytes (\ud800): the most any card text costs per character.
  const lone = "\ud800";
  const label = lone.repeat(MAX_LABEL_LENGTH);
  // Package names at the frame-name bound, and hints longer still: a package matches as
  // `node_modules/name/`, and a hint that ends inside a surrogate pair costs six bytes for it.
  const packages = ["\u{1F600}", "\u{1F601}", "\u{1F602}"].map((emoji) => emoji.repeat(20));
  const hints = packages.map((name) => `node_modules/${name.slice(0, -1)}`);
  const widest = (i: number) =>
    TechniqueCardSchema.parse({
      id: `w${String(i).padStart(3, "0")}`.padEnd(MAX_ID_LENGTH, "x"),
      domain: "d".padEnd(MAX_ID_LENGTH, "x"),
      title: label,
      kind: "guided",
      riskClass: "lossless",
      stacks: StackIdSchema.options,
      bottlenecks: BottleneckSchema.options,
      signals: ["evidence"],
      frameHints: hints.map((match) => ({ match, minShare: 0.001 })),
      expectedEffect: label,
      sources: ["https://example.com/ufo-test-fixture"],
      verifiedIn: "unverified",
    });
  const bundle = hotFrames([
    {
      valid: true,
      kind: "bundle",
      modules: [],
      packages: packages.map((name) => ({ package: name, pct: 99.9 })),
    },
  ]);
  const worst = (count: number) => ({
    ...indexEntries(
      Array.from({ length: count }, (_, i) => widest(i)),
      NONE,
      NO_STACKS,
      bundle,
    ),
    note: label,
    configError: label,
  });

  it("fits a default page whole in the result budget with every field at its bound", () => {
    for (const name of packages) expect(bytes(name) - 2).toBe(MAX_NAME_BYTES);
    for (const hint of hints) expect(bytes(hint) - 2).toBe(MAX_NAME_BYTES + 15);
    const listing = worst(40);
    expect(listing.cards.slice(0, MAX_EVIDENCE_CARDS).map((entry) => entry.evidence)).toEqual(
      Array(MAX_EVIDENCE_CARDS).fill(expect.arrayContaining([expect.anything()])),
    );
    expect(listing.cards[0]?.evidence).toHaveLength(MAX_EVIDENCE);
    expect(listing.cards[0]?.evidence?.[0]).toMatchObject({ kind: "package", share: 0.999 });
    const page = indexPage(listing, 0, DEFAULT_INDEX_PAGE, "k");
    expect(page.cards).toHaveLength(DEFAULT_INDEX_PAGE);
    expect(page.nextCursor).toBeDefined();
    const text = JSON.stringify(success(page).structuredContent);
    expect(text).not.toContain("truncated");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_INDEX_PAGE_BYTES);
    expect(MAX_INDEX_PAGE_BYTES).toBeLessThan(MAX_RESULT_BYTES);
    // The default is the most such entries a page holds: one more and the page ends early.
    expect(indexPage(listing, 0, DEFAULT_INDEX_PAGE + 1, "k").cards).toHaveLength(
      DEFAULT_INDEX_PAGE,
    );
  });

  it("ends a page early rather than past the budget, and goes on from there", () => {
    const listing = worst(2 * MAX_INDEX_PAGE + 3);
    const all = pages(listing, MAX_INDEX_PAGE);
    expect(all.length).toBeGreaterThan(3);
    for (const page of all) {
      expect(page.cards.length).toBeGreaterThan(0);
      const text = JSON.stringify(success(page).structuredContent);
      expect(text).not.toContain("truncated");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_INDEX_PAGE_BYTES);
    }
    expect(all.flatMap((page) => page.cards)).toEqual(listing.cards);
    // Even an entry larger than a page alone is listed, one to a page.
    const huge = { ...listing, note: "x".repeat(MAX_INDEX_PAGE_BYTES) };
    expect(indexPage(huge, 0, MAX_INDEX_PAGE, "k").cards).toHaveLength(1);
  });

  it("pages the order of the whole listing, whatever the page size", () => {
    const listing = indexEntries(
      Array.from({ length: 23 }, (_, i) =>
        card(`p${String(i).padStart(2, "0")}`, [], i % 3 ? [] : ["node"]),
      ),
      NONE,
      new Set<StackId>(["node"]),
    );
    for (const limit of [1, 2, 7, DEFAULT_INDEX_PAGE, 22, 23, MAX_INDEX_PAGE]) {
      const all = pages(listing, limit);
      expect(
        all.flatMap((page) => page.cards),
        String(limit),
      ).toEqual(listing.cards);
      expect(all.length).toBe(Math.ceil(23 / limit));
      expect(all.every((page) => page.total === 23)).toBe(true);
      expect(all.slice(0, -1).every((page) => page.cards.length === limit)).toBe(true);
      expect(all.at(-1)).not.toHaveProperty("nextCursor");
    }
    expect(indexPage({ cards: [] }, 0, DEFAULT_INDEX_PAGE, "k")).toEqual({ cards: [], total: 0 });
  });
});
