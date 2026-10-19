import { readFileSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
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
import { AppError } from "./errors.js";

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

/**
 * A `cardDirs` entry of ufo.yaml as an absolute directory: it must exist, be a directory, and be
 * reached without a symbolic link, inside the repository.
 */
interface CheckedDir {
  readonly dir: string;
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
}

async function repoCardDir(repoRoot: string, dir: string): Promise<CheckedDir> {
  const root = await realpath(repoRoot);
  const target = path.join(root, dir);
  const real = await realpath(target).catch(() => undefined);
  if (real === undefined || !(await stat(real)).isDirectory()) {
    throw new AppError("config_invalid", `ufo.yaml cardDirs: ${dir} is not a directory`);
  }
  if (real !== target || !real.startsWith(`${root}${path.sep}`)) {
    throw new AppError(
      "config_invalid",
      `ufo.yaml cardDirs: ${dir} must be a directory inside the repository, reached without a symbolic link`,
    );
  }
  const info = await lstat(real);
  return { dir, real, dev: info.dev, ino: info.ino };
}

/** Refuses a declared card directory that was replaced while its cards were loaded (N6). */
async function assertUnchanged(checked: CheckedDir): Promise<void> {
  const real = await realpath(checked.real).catch(() => undefined);
  const info = real === undefined ? undefined : await lstat(real).catch(() => undefined);
  if (real !== checked.real || info?.dev !== checked.dev || info?.ino !== checked.ino) {
    throw new AppError(
      "config_invalid",
      `ufo.yaml cardDirs: ${checked.dir} changed while its cards were loaded; try again`,
    );
  }
}

/**
 * The built-in cards, those of the context's card directories, and those of the `cardDirs`
 * ufo.yaml declares, each with its source.
 */
export async function loadCards(
  repoRoot: string,
  context: Pick<AppContext, "cardDirs">,
  config: Pick<UfoConfig, "cardDirs"> = { cardDirs: [] },
): Promise<Map<string, SourcedCard>> {
  const declared = await Promise.all(config.cardDirs.map((dir) => repoCardDir(repoRoot, dir)));
  const catalog = await loadCatalog([
    ...(context.cardDirs ?? []).map((dir) => path.resolve(dir)),
    ...declared.map((checked) => checked.real),
  ]);
  for (const checked of declared) await assertUnchanged(checked);
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
