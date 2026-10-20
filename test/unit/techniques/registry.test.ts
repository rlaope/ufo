import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CARDS_DIR,
  CardLoadError,
  loadCatalog,
  resolveCard,
} from "../../../src/techniques/index.js";

const FIXTURE_CARDS = fileURLToPath(new URL("../../fixtures/toy-http/cards", import.meta.url));

const GUIDED = `id: extra.tune
domain: extra
title: Tune something
kind: guided
riskClass: lossless
bottlenecks: [cpu]
signals:
  - something is slow
sources:
  - https://example.com/ufo-test-fixture
verifiedIn: unverified
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-cards-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCard(domain: string, name: string, text: string): Promise<void> {
  await mkdir(path.join(root, domain), { recursive: true });
  await writeFile(path.join(root, domain, name), text);
}

describe("loadCatalog", () => {
  it("loads the built-in generic card, then extra directories in order", async () => {
    const catalog = await loadCatalog([FIXTURE_CARDS]);
    expect([...catalog.cards.keys()]).toEqual([
      "generic.code-change",
      "toy.cache-items",
      "toy.fast-path",
      "toy.fewer-requests",
      "toy.no-delay",
    ]);
    expect(catalog.cards.get("generic.code-change")).toMatchObject({
      kind: "guided",
      riskClass: "lossless",
    });
    expect(catalog.cards.get("toy.no-delay")?.edits).toHaveLength(1);
    expect(catalog.dirs.get("generic.code-change")).toBe(BUILTIN_CARDS_DIR);
    expect(catalog.dirs.get("toy.no-delay")).toBe(FIXTURE_CARDS);
    expect(BUILTIN_CARDS_DIR.endsWith(`${path.sep}src${path.sep}techniques${path.sep}`)).toBe(true);
  });

  it("loads every packaged card through the card schema, with a bottleneck and a source outside generic", async () => {
    const { cards } = await loadCatalog();
    expect(cards.size).toBeGreaterThan(0);
    for (const card of cards.values()) {
      expect(card.bottlenecks.length, card.id).toBeGreaterThan(0);
      if (card.domain !== "generic") expect(card.sources.length, card.id).toBeGreaterThan(0);
    }
  });

  it("requires id <domain>.<file name> and domain = directory", async () => {
    await writeCard("extra", "other.yaml", GUIDED);
    await expect(loadCatalog([root])).rejects.toThrow(/id extra\.other/);
    await rm(path.join(root, "extra", "other.yaml"));
    await writeCard("wrong", "tune.yaml", GUIDED);
    await expect(loadCatalog([root])).rejects.toThrow(CardLoadError);
  });

  it("rejects duplicate ids, invalid cards, YAML aliases, and missing directories", async () => {
    await writeCard("extra", "tune.yaml", GUIDED);
    await expect(loadCatalog([root, root])).rejects.toThrow(/duplicate card id extra\.tune/);
    await writeCard("extra", "tune.yaml", GUIDED.replace("riskClass: lossless", "riskClass: safe"));
    await expect(loadCatalog([root])).rejects.toThrow(/riskClass/);
    await writeCard("extra", "tune.yaml", `${GUIDED}traps: &t\n  - a\npreconditions: *t\n`);
    await expect(loadCatalog([root])).rejects.toThrow(/not valid YAML/);
    await expect(loadCatalog([path.join(root, "missing")])).rejects.toThrow(/cannot read/);
  });
});

describe("resolveCard", () => {
  it("returns the card with its own risk class, or unknown_card / card_not_enabled", async () => {
    const catalog = await loadCatalog([FIXTURE_CARDS]);
    const ok = resolveCard(catalog, "toy.cache-items", ["toy.cache-items"]);
    expect("card" in ok && ok.card.riskClass).toBe("lossy");
    expect(resolveCard(catalog, "toy.nope", ["toy.nope"])).toMatchObject({
      violation: { rule: "unknown_card", subjects: ["toy.nope"] },
    });
    expect(resolveCard(catalog, "toy.fast-path", ["generic.code-change"])).toMatchObject({
      violation: { rule: "card_not_enabled" },
    });
  });
});
