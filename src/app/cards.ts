import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ApprovalSubject,
  type ApprovedCard,
  canonicalJson,
  hashConfig,
} from "../core/policy/index.js";
import type { TechniqueCard, UfoConfig } from "../domain/index.js";
import { BUILTIN_CARDS_DIR, loadCatalog } from "../techniques/index.js";
import type { AppContext } from "./context.js";

/** The installed package's version. Resolves to the package root from both src/ and dist/. */
export function packageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const pkg: unknown = JSON.parse(raw);
  if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
    const { version } = pkg;
    if (typeof version === "string") return version;
  }
  throw new Error("package.json has no version field");
}

/** A loaded card and where it came from, as an approval records it. */
export interface SourcedCard {
  readonly source: string;
  readonly card: TechniqueCard;
}

/** Card id → card with its source, in catalog order. */
export type CardSet = ReadonlyMap<string, SourcedCard>;

/** `ufo-agents@<version>` for a built-in card, `dir:<path relative to the repo>` otherwise. */
export function cardSource(repoRoot: string, dir: string): string {
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(BUILTIN_CARDS_DIR)) return `ufo-agents@${packageVersion()}`;
  const relative = path.relative(repoRoot, resolved).split(path.sep).join("/");
  return `dir:${relative === "" ? "." : relative}`;
}

/** The built-in cards and those of the context's card directories, each with its source. */
export async function loadCards(
  repoRoot: string,
  context: Pick<AppContext, "cardDirs">,
): Promise<Map<string, SourcedCard>> {
  const catalog = await loadCatalog((context.cardDirs ?? []).map((dir) => path.resolve(dir)));
  const cards = new Map<string, SourcedCard>();
  for (const [id, card] of catalog.cards) {
    const dir = catalog.dirs.get(id) ?? BUILTIN_CARDS_DIR;
    cards.set(id, { source: cardSource(repoRoot, dir), card });
  }
  return cards;
}

/** sha256 of a card's parsed content in canonical JSON. */
export function cardDigest(card: TechniqueCard): string {
  return hashConfig(canonicalJson(card));
}

/**
 * What `ufo approve` records, and every run start and job checks again: `sha256(ufo.yaml)`;
 * for each card `ufo.yaml` enables, its id, source, and content hash; the opt-ins; and the
 * `env:` names. An enabled id the set does not have is left out, which an existing approval
 * reports as a missing card.
 */
export function approvalSubject(
  configHash: string,
  config: Pick<UfoConfig, "cards" | "optIns" | "env">,
  cards: CardSet,
): ApprovalSubject {
  const approved: ApprovedCard[] = [];
  for (const id of config.cards) {
    const entry = cards.get(id);
    if (entry === undefined) continue;
    approved.push({ id, source: entry.source, sha256: cardDigest(entry.card) });
  }
  return { configHash, cards: approved, optIns: config.optIns, env: config.env };
}
