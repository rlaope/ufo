import { z } from "zod";
import { ObjectiveSchema } from "./objective.js";
import { OracleSpecSchema } from "./oracle.js";
import { EnvNameListSchema, OptInListSchema, TargetListSchema } from "./policy.js";
import { CommandLineSchema, IdSchema, uniqueArray } from "./primitives.js";
import { SCHEMA_VERSION } from "./version.js";

const MAX_ORACLES = 16;
const MAX_CARDS = 256;

/**
 * Commands for each workload lifecycle step:
 * `setup → start → healthcheck → warmup → command (measure) → teardown → reset`.
 * Only the measure command is required; `reset` runs before every sample.
 */
export const WorkloadSchema = z.strictObject({
  setup: CommandLineSchema.optional(),
  start: CommandLineSchema.optional(),
  healthcheck: CommandLineSchema.optional(),
  warmup: CommandLineSchema.optional(),
  command: CommandLineSchema,
  teardown: CommandLineSchema.optional(),
  reset: CommandLineSchema.optional(),
});
export type Workload = z.infer<typeof WorkloadSchema>;

/** Plan §4.5 defaults: every sample needs AC power and a 1-minute load below 0.5 × cores. */
export const DEFAULT_HYGIENE = { requireAcPower: true, maxLoadFactor: 0.5 } as const;

/**
 * Machine checks before every sample. Loosening them (CI runners without a battery reading, a
 * shared machine) keeps samples valid where the defaults would refuse them; the bundle records
 * the change as a limitation.
 */
export const HygieneConfigSchema = z.strictObject({
  requireAcPower: z.boolean().default(DEFAULT_HYGIENE.requireAcPower),
  maxLoadFactor: z.number().positive().max(64).default(DEFAULT_HYGIENE.maxLoadFactor),
});
export type HygieneConfig = z.infer<typeof HygieneConfigSchema>;

/**
 * The shape of `ufo.yaml`. The scenario and budget live inside `objective`, so each has one
 * source of truth.
 */
export const UfoConfigSchema = z.strictObject({
  version: z.literal(SCHEMA_VERSION),
  objective: ObjectiveSchema,
  workload: WorkloadSchema,
  oracles: uniqueArray(OracleSpecSchema, MAX_ORACLES, (o) => o.name, "oracle names").default([]),
  targets: TargetListSchema.default([]),
  /** Technique card ids enabled for this target, in the order `ufo run` applies recipes. */
  cards: uniqueArray(IdSchema, MAX_CARDS, (c) => c, "card ids").default([]),
  /** Requested here, granted only when `ufo approve` confirms them. */
  optIns: OptInListSchema.default([]),
  /**
   * Environment variables passed to every command besides the defaults (PATH, HOME, LANG,
   * LC_*, TMPDIR, USER, SHELL, TERM). Their values are captured when the run starts.
   */
  env: EnvNameListSchema.default([]),
  hygiene: HygieneConfigSchema.default({ ...DEFAULT_HYGIENE }),
});
export type UfoConfig = z.infer<typeof UfoConfigSchema>;
