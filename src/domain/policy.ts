import { z } from "zod";
import { BudgetSchema } from "./budget.js";
import { RepoPathSchema, Sha256HexSchema, uniqueArray } from "./primitives.js";

/** Risk classes a human must opt into with `ufo approve`. `lossless` and `numeric` need none. */
export const OptInSchema = z.enum(["lossy", "upgrade"]);
export type OptIn = z.infer<typeof OptInSchema>;

/** Longest DNS name. */
const MAX_HOSTNAME_LENGTH = 253;
const MAX_TARGETS = 64;
const MAX_PROTECTED_PATHS = 256;

/**
 * A load target beyond the loopback and Docker defaults: an IP address, a CIDR range, or a
 * hostname (resolved once and pinned before the load tool runs).
 */
export const TargetSchema = z.union([
  z.ipv4(),
  z.ipv6(),
  z.cidrv4(),
  z.cidrv6(),
  z.hostname().max(MAX_HOSTNAME_LENGTH),
]);
export type Target = z.infer<typeof TargetSchema>;

export const OptInListSchema = uniqueArray(
  OptInSchema,
  OptInSchema.options.length,
  (o) => o,
  "opt-ins",
);
export const TargetListSchema = uniqueArray(TargetSchema, MAX_TARGETS, (t) => t, "targets");

/** What the worker enforces for one run, derived from the approved `ufo.yaml`. */
export const PolicySchema = z.strictObject({
  /** Globs, relative to the repository root, that no change may touch. */
  protectedPaths: uniqueArray(RepoPathSchema, MAX_PROTECTED_PATHS, (p) => p, "protected paths"),
  /** `sha256(ufo.yaml)` recorded by `ufo approve`. */
  approvedConfigHash: Sha256HexSchema,
  optIns: OptInListSchema.default([]),
  targets: TargetListSchema.default([]),
  budget: BudgetSchema.prefault({}),
});
export type Policy = z.infer<typeof PolicySchema>;
