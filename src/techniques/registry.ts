import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type PolicyViolation, violation } from "../core/policy/index.js";
import { type TechniqueCard, TechniqueCardSchema } from "../domain/index.js";

/**
 * The package's own cards, `src/techniques/<domain>/<name>.yaml`. Resolved from this module's
 * location, which is `src/techniques` in the sources and `dist/techniques` once built; the YAML
 * files ship in `src/techniques` either way.
 */
export const BUILTIN_CARDS_DIR = fileURLToPath(new URL("../../src/techniques/", import.meta.url));

const CARD_FILE = /^([a-z0-9][a-z0-9._-]*)\.ya?ml$/;
/** A card file is a few kilobytes; anything far larger is not a card. */
const MAX_CARD_BYTES = 256 * 1024;

export class CardLoadError extends Error {
  override name = "CardLoadError";
}

/** Every card UFO knows, in catalog order: built-in cards first, then each extra directory. */
export interface TechniqueCatalog {
  readonly cards: ReadonlyMap<string, TechniqueCard>;
  /** The directory each card was loaded from: `BUILTIN_CARDS_DIR` or one of the extra ones. */
  readonly dirs: ReadonlyMap<string, string>;
}

/**
 * Loads `<dir>/<domain>/<name>.yaml` from the built-in directory and `extraDirs`. A card's
 * `domain` must equal its directory and its `id` must be `<domain>.<name>`, so a card id names
 * exactly one file. Malformed or duplicate cards fail the whole load.
 */
export async function loadCatalog(extraDirs: readonly string[] = []): Promise<TechniqueCatalog> {
  const cards = new Map<string, TechniqueCard>();
  const dirs = new Map<string, string>();
  for (const dir of [BUILTIN_CARDS_DIR, ...extraDirs]) {
    for (const domain of await listDirs(dir)) {
      const domainDir = path.join(dir, domain);
      const names = (await readdir(domainDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && CARD_FILE.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      for (const name of names) {
        const file = path.join(domainDir, name);
        const card = await readCard(file);
        const expectedId = `${domain}.${name.replace(/\.ya?ml$/, "")}`;
        if (card.domain !== domain || card.id !== expectedId) {
          throw new CardLoadError(
            `${file}: a card in ${domain}/ must have domain ${domain} and id ${expectedId}`,
          );
        }
        if (cards.has(card.id)) throw new CardLoadError(`${file}: duplicate card id ${card.id}`);
        cards.set(card.id, card);
        dirs.set(card.id, dir);
      }
    }
  }
  return { cards, dirs };
}

async function listDirs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new CardLoadError(`cannot read the card directory ${dir}`, { cause: error });
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readCard(file: string): Promise<TechniqueCard> {
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > MAX_CARD_BYTES) throw new CardLoadError(`${file}: too large`);
  let value: unknown;
  try {
    value = parseYaml(text, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new CardLoadError(`${file}: not valid YAML: ${(error as Error).message}`);
  }
  const parsed = TechniqueCardSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CardLoadError(
      `${file}: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid card"}`,
    );
  }
  return parsed.data;
}

/**
 * The card a change names, or why it may not be used: `unknown_card` when no catalog has it,
 * `card_not_enabled` when the approved `ufo.yaml` does not list it. The risk class always comes
 * from the card returned here, never from the caller.
 */
export function resolveCard(
  catalog: Pick<TechniqueCatalog, "cards">,
  cardId: string,
  enabled: readonly string[],
): { card: TechniqueCard } | { violation: PolicyViolation } {
  const card = catalog.cards.get(cardId);
  if (card === undefined) {
    return { violation: violation("unknown_card", `no technique card has id ${cardId}`, [cardId]) };
  }
  if (!enabled.includes(cardId)) {
    return {
      violation: violation(
        "card_not_enabled",
        `card ${cardId} is not enabled in the approved ufo.yaml`,
        [cardId],
      ),
    };
  }
  return { card };
}
