import { z } from "zod";
import { GitShaSchema, IdSchema, RepoPathSchema, uniqueArray } from "./primitives.js";

/** 1 MiB. A larger patch is not one technique. */
export const MAX_DIFF_LENGTH = 1024 * 1024;
export const MAX_HYPOTHESIS_LENGTH = 2000;
const MAX_EVIDENCE_REFS = 32;

/** A unified diff: text only (no NUL bytes) with at least one `---`/`+++` file header pair. */
export const UnifiedDiffSchema = z
  .string()
  .min(1)
  .max(MAX_DIFF_LENGTH)
  .refine((diff) => !diff.includes("\0"), "must not contain NUL bytes")
  .refine((diff) => /^--- .+\r?\n\+\+\+ .+$/m.test(diff), "must be a unified diff");

/** Multi-line prose: trimmed, non-empty, no control characters other than newline and tab. */
export const HypothesisSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_HYPOTHESIS_LENGTH)
  .regex(
    /^(?:[^\p{Cc}]|[\n\t])*$/u,
    "must not contain control characters other than newline and tab",
  );

/** One candidate patch, submitted by the agent or generated from a recipe card. */
export const ChangeSchema = z.strictObject({
  /** Recorded as the `Ufo-Change-Id` trailer; used to reconcile the ledger with commits. */
  changeId: z.uuid(),
  /** Arm A's SHA; the diff applies on top of it. */
  baseSha: GitShaSchema,
  /** Required: every change names the technique card it implements. */
  cardId: IdSchema,
  diff: UnifiedDiffSchema,
  hypothesis: HypothesisSchema,
  /** Profiler artifacts, relative to the run state directory, that motivated the change. */
  evidenceRefs: uniqueArray(RepoPathSchema, MAX_EVIDENCE_REFS, (r) => r, "evidence refs").default(
    [],
  ),
});
export type Change = z.infer<typeof ChangeSchema>;
