import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type OptIn, OptInListSchema, Sha256HexSchema } from "../../domain/index.js";
import { ufoHome } from "../git/home.js";
import { REPO_ID_PATTERN } from "../git/run.js";
import { PolicyError, type PolicyViolation, violation } from "./rules.js";

const APPROVAL_VERSION = 1;

/** `$UFO_HOME/approvals/<repo-id>.json`: the latest `ufo approve` for one repository. */
export const ApprovalSchema = z.strictObject({
  version: z.literal(APPROVAL_VERSION),
  repoId: z.string().regex(REPO_ID_PATTERN),
  /** `sha256(ufo.yaml)` as approved. */
  configHash: Sha256HexSchema,
  optIns: OptInListSchema,
  approvedAt: z.iso.datetime({ offset: true }),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export interface ApprovalStoreOptions {
  /** Defaults to `ufoHome()`. */
  home?: string;
}

/** sha256 of the exact `ufo.yaml` bytes, lowercase hex. Any edit changes it. */
export function hashConfig(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvalPath(repoId: string, options: ApprovalStoreOptions): string {
  // The id becomes a file name, so it is checked before any path is built from it.
  if (!REPO_ID_PATTERN.test(repoId)) throw new RangeError(`invalid repo id: ${repoId}`);
  return path.join(options.home ?? ufoHome(), "approvals", `${repoId}.json`);
}

/**
 * Records a human approval of `configHash` with the granted opt-ins, replacing any earlier one.
 * The file is written to a temporary name, synced, and renamed, so a reader sees the old or the
 * new approval and never a partial one. Mode 0600. Callers run `requireTty` first.
 */
export async function recordApproval(
  repoId: string,
  configHash: string,
  optIns: readonly OptIn[],
  options: ApprovalStoreOptions & { now?: Date } = {},
): Promise<Approval> {
  const file = approvalPath(repoId, options);
  const approval = ApprovalSchema.parse({
    version: APPROVAL_VERSION,
    repoId,
    configHash,
    optIns: [...optIns],
    approvedAt: (options.now ?? new Date()).toISOString(),
  });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${repoId}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
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
    raw = await readFile(approvalPath(repoId, options), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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

/** `unapproved_config` without an approval, `config_changed` when the hash differs. */
export async function checkApproval(
  repoId: string,
  configHash: string,
  options: ApprovalStoreOptions = {},
): Promise<PolicyViolation | undefined> {
  const approval = await readApproval(repoId, options);
  if (approval === undefined) {
    return violation(
      "unapproved_config",
      "ufo.yaml has not been approved; run `ufo approve` in a terminal",
    );
  }
  if (approval.configHash !== configHash) {
    return violation(
      "config_changed",
      "ufo.yaml changed since it was approved; run `ufo approve` in a terminal",
    );
  }
  return undefined;
}

export async function isApproved(
  repoId: string,
  configHash: string,
  options: ApprovalStoreOptions = {},
): Promise<boolean> {
  return (await checkApproval(repoId, configHash, options)) === undefined;
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
