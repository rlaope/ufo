import { z } from "zod";
import { ObjectiveSchema } from "./objective.js";
import { OracleSpecSchema } from "./oracle.js";
import { OptInListSchema, TargetListSchema } from "./policy.js";
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
});
export type UfoConfig = z.infer<typeof UfoConfigSchema>;
