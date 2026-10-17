import { z } from "zod";
import { IdSchema, labelSchema, MAX_ID_LENGTH } from "./primitives.js";

export const MetricDirectionSchema = z.enum(["lower_is_better", "higher_is_better"]);
export type MetricDirection = z.infer<typeof MetricDirectionSchema>;

/** Deterministic metrics repeat exactly (JS bytes, query count); stochastic metrics need pairs. */
export const MetricKindSchema = z.enum(["deterministic", "stochastic"]);
export type MetricKind = z.infer<typeof MetricKindSchema>;

/** What one independent sample is. Requests inside one run are never separate samples. */
export const ReplicationUnitSchema = z.enum([
  "process_launch",
  "load_run",
  "build",
  "page_load",
  "eval_pass",
  "training_pass",
]);
export type ReplicationUnit = z.infer<typeof ReplicationUnitSchema>;

export const MetricSchema = z.strictObject({
  name: IdSchema,
  /** e.g. `ms`, `bytes`, `tokens/s`. */
  unit: labelSchema(MAX_ID_LENGTH),
  direction: MetricDirectionSchema,
  kind: MetricKindSchema,
  replicationUnit: ReplicationUnitSchema,
});
export type Metric = z.infer<typeof MetricSchema>;
