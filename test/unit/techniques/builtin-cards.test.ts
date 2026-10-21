import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { displayName } from "../../../src/core/profile/index.js";
import { BUILTIN_CARDS_DIR, loadCatalog } from "../../../src/techniques/index.js";

// M3 P4: every card the package ships loads through the card schema, sits in the directory of its
// domain under the name its id gives, and says where its claims come from.

const domains = readdirSync(BUILTIN_CARDS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("the built-in technique cards", () => {
  it("all load, each named after its id in its domain's directory", async () => {
    const catalog = await loadCatalog();
    const files = domains.flatMap((domain) =>
      readdirSync(path.join(BUILTIN_CARDS_DIR, domain))
        .filter((name) => name.endsWith(".yaml"))
        .map((name) => `${domain}.${name.replace(/\.yaml$/, "")}`),
    );
    expect([...catalog.cards.keys()].sort()).toEqual(files.sort());
    for (const [id, card] of catalog.cards) {
      expect(id.startsWith(`${card.domain}.`), id).toBe(true);
    }
  });

  it("give every card outside generic a source, a signal, and a bottleneck", async () => {
    const catalog = await loadCatalog();
    for (const [id, card] of catalog.cards) {
      expect(card.signals.length, id).toBeGreaterThan(0);
      expect(card.bottlenecks.length, id).toBeGreaterThan(0);
      if (card.domain !== "generic") {
        expect(card.sources.length, id).toBeGreaterThan(0);
        for (const source of card.sources) expect(source, id).toMatch(/^https:\/\//);
      }
    }
  });

  // M5 V1: a summary shows a long frame name by its start and end, so a hint is the end of a
  // frame (its method, or its file before the line number), which survives the cut.
  it("give frame hints that a shown frame keeps, however long the package before them", async () => {
    const catalog = await loadCatalog();
    let hinted = 0;
    for (const [id, card] of catalog.cards) {
      if (card.frameHints.length > 0) hinted++;
      for (const { match, minShare } of card.frameHints) {
        expect(minShare, id).toBeGreaterThan(0);
        for (const frame of [
          `${"org/example/".repeat(10)}${match}`,
          `f (${"lib/".repeat(25)}${match}:12345)`,
        ]) {
          expect(displayName(frame), `${id}: ${match}`).toContain(match);
        }
      }
    }
    expect(hinted).toBeGreaterThan(10);
  });
});
