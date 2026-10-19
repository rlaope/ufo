import { createHash, randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  EnvNameListSchema,
  IdSchema,
  type OptIn,
  OptInListSchema,
  Sha256HexSchema,
  uniqueArray,
} from "../../domain/index.js";
import { REPO_ID_PATTERN } from "../git/run.js";
import {
  isErrno,
  OPEN_CREATE_EXCLUSIVE,
  openNoFollow,
  readTextNoFollow,
} from "../jobs/atomic-file.js";
import { approvalsRoot, ensureTrustedDir, ufoHome } from "../paths.js";
import { PolicyError, type PolicyViolation, preview, violation } from "./rules.js";

const APPROVAL_VERSION = 3;
const MAX_APPROVED_CARDS = 256;

/** One enabled technique card as approved: where it was loaded from and its content hash. */
export const ApprovedCardSchema = z.strictObject({
  id: IdSchema,
  /** `ufo-agents@<version>` for a built-in card, `dir:<path relative to the repo>` otherwise. */
  source: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\p{Cc}]*$/u, "must be one line"),
  /** sha256 of the card's parsed content in canonical JSON. */
  sha256: Sha256HexSchema,
});
export type ApprovedCard = z.infer<typeof ApprovedCardSchema>;

/**
 * What one approval covers: the exact `ufo.yaml` bytes, every card it enables, the opt-ins the
 * human confirmed, and the environment variable names passed to commands besides the defaults.
 */
export interface ApprovalSubject {
  /** `sha256(ufo.yaml)`. */
  readonly configHash: string;
  readonly cards: readonly ApprovedCard[];
  readonly optIns: readonly OptIn[];
  /** `env:` of `ufo.yaml`. */
  readonly env: readonly string[];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sortKeys(record[key])]),
  );
}

/** JSON with object keys sorted at every level, so equal values always encode the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function byId(cards: readonly ApprovedCard[]): ApprovedCard[] {
  return [...cards].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The approved digest: sha256 over the canonical encoding of the subject, cards in id order,
 * opt-ins and environment names sorted.
 */
export function approvalDigest(subject: ApprovalSubject): string {
  return hashConfig(
    canonicalJson({
      version: 2,
      configHash: subject.configHash,
      cards: byId(subject.cards),
      optIns: [...subject.optIns].sort(),
      env: [...subject.env].sort(),
    }),
  );
}

/** `$UFO_HOME/private/approvals/<repo-id>.json`: the latest `ufo approve` for one repository. */
export const ApprovalSchema = z
  .strictObject({
    version: z.literal(APPROVAL_VERSION),
    repoId: z.string().regex(REPO_ID_PATTERN),
    /** `sha256(ufo.yaml)` as approved. */
    configHash: Sha256HexSchema,
    /** The enabled cards as approved, in id order. */
    cards: uniqueArray(ApprovedCardSchema, MAX_APPROVED_CARDS, (c) => c.id, "card ids"),
    /** Opt-ins the human confirmed with `ufo approve`. */
    optIns: OptInListSchema,
    /** Environment variable names passed to commands besides the defaults. */
    env: EnvNameListSchema,
    /** `approvalDigest` of the fields above; a file whose digest disagrees is no approval. */
    digest: Sha256HexSchema,
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .refine((approval) => approval.digest === approvalDigest(approval), {
    message: "does not match the approved ufo.yaml, cards, opt-ins, and environment",
    path: ["digest"],
  });
export type Approval = z.infer<typeof ApprovalSchema>;

export interface ApprovalStoreOptions {
  /**
   * The trusted home's real path (see `trustedHome`); defaults to `ufoHome()`. Always the
   * calling process's own home, never a path read from run state.
   */
  home?: string;
}

/** sha256 of the exact `ufo.yaml` bytes, lowercase hex. Any edit changes it. */
export function hashConfig(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvalPath(repoId: string, options: ApprovalStoreOptions): string {
  // The id becomes a file name, so it is checked before any path is built from it.
  if (!REPO_ID_PATTERN.test(repoId)) throw new RangeError(`invalid repo id: ${repoId}`);
  return path.join(approvalsRoot(options.home ?? ufoHome()), `${repoId}.json`);
}

/**
 * Records a human approval of `subject`, replacing any earlier one. The file is written to a
 * temporary name, synced, and renamed, so a reader sees the old or the new approval and never a
 * partial one. Mode 0600, in a 0700 directory. Callers run `requireTty` first.
 */
export async function recordApproval(
  repoId: string,
  subject: ApprovalSubject,
  options: ApprovalStoreOptions & { now?: Date } = {},
): Promise<Approval> {
  const file = approvalPath(repoId, options);
  const approval = ApprovalSchema.parse({
    version: APPROVAL_VERSION,
    repoId,
    configHash: subject.configHash,
    cards: byId(subject.cards),
    optIns: [...subject.optIns].sort(),
    env: [...subject.env].sort(),
    digest: approvalDigest(subject),
    approvedAt: (options.now ?? new Date()).toISOString(),
  });
  await ensureTrustedDir(options.home ?? ufoHome(), path.dirname(file));
  const temp = path.join(path.dirname(file), `.${repoId}.${randomUUID()}.tmp`);
  try {
    const handle = await openNoFollow(temp, OPEN_CREATE_EXCLUSIVE);
    try {
      await handle.writeFile(`${JSON.stringify(approval, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return approval;
}

/** The recorded approval, or undefined when there is none or the file is not a valid one. */
export async function readApproval(
  repoId: string,
  options: ApprovalStoreOptions = {},
): Promise<Approval | undefined> {
  let raw: string;
  try {
    raw = await readTextNoFollow(approvalPath(repoId, options));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ApprovalSchema.safeParse(parsed);
  return result.success && result.data.repoId === repoId ? result.data : undefined;
}

/**
 * `unapproved_config` without an approval; `config_changed` when `ufo.yaml`, an enabled card,
 * the opt-ins, or the environment names differ from what was approved. A card change names the
 * cards (`subjects`): a new content hash, another source, or an approved card that is no longer
 * there.
 */
export async function checkApproval(
  repoId: string,
  subject: ApprovalSubject,
  options: ApprovalStoreOptions = {},
): Promise<PolicyViolation | undefined> {
  const approval = await readApproval(repoId, options);
  if (approval === undefined) {
    return violation(
      "unapproved_config",
      "ufo.yaml has not been approved; run `ufo approve` in a terminal",
    );
  }
  if (approval.digest === approvalDigest(subject)) return undefined;
  if (approval.configHash !== subject.configHash) {
    return violation(
      "config_changed",
      "ufo.yaml changed since it was approved; run `ufo approve` in a terminal",
    );
  }
  const sameList = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && [...x].sort().every((item, i) => item === [...y].sort()[i]);
  if (!sameList(approval.optIns, subject.optIns) || !sameList(approval.env, subject.env)) {
    return violation(
      "config_changed",
      "the opt-ins or environment names differ from what was approved; run `ufo approve` in a terminal",
    );
  }
  const current = new Map(subject.cards.map((card) => [card.id, card]));
  const changed: string[] = [];
  const described: string[] = [];
  for (const id of new Set([...approval.cards, ...subject.cards].map((card) => card.id))) {
    const was = approval.cards.find((card) => card.id === id);
    const now = current.get(id);
    if (was !== undefined && now !== undefined && was.sha256 === now.sha256) {
      if (was.source === now.source) continue;
      described.push(`${id} (now from ${now.source}, approved from ${was.source})`);
    } else if (now === undefined) {
      described.push(`${id} (missing)`);
    } else {
      described.push(id);
    }
    changed.push(id);
  }
  return violation(
    "config_changed",
    `technique card ${preview(described)} changed since it was approved; run \`ufo approve\` in a terminal`,
    changed.sort(),
  );
}

export async function isApproved(
  repoId: string,
  subject: ApprovalSubject,
  options: ApprovalStoreOptions = {},
): Promise<boolean> {
  return (await checkApproval(repoId, subject, options)) === undefined;
}

/**
 * Approval is human-only: it needs an interactive terminal on stdin. There is no flag that skips
 * this check. Throws `PolicyError` (`non_tty_approval`).
 */
export function requireTty(stdin: { readonly isTTY?: boolean | undefined }): void {
  if (stdin.isTTY !== true) {
    throw new PolicyError(
      violation("non_tty_approval", "ufo approve needs an interactive terminal on stdin"),
    );
  }
}
