import { z } from "zod";
import { BudgetSchema } from "./budget.js";
import { GuardrailSchema } from "./guardrail.js";
import { MetricSchema } from "./metric.js";
import { labelSchema, MAX_NOTE_LENGTH, uniqueArray } from "./primitives.js";

/** One per guardrail kind; a second guardrail of the same kind would make `guardrail:<kind>` ambiguous. */
const MAX_GUARDRAILS = 4;
const MAX_REPORTED_ONLY = 16;

export const ObjectiveSchema = z
  .strictObject({
    /** Exactly one primary metric decides keep or drop. */
    primary: MetricSchema,
    /** The single measured scenario, e.g. `GET /owners at 200 rps for 30 s`. */
    scenario: labelSchema(MAX_NOTE_LENGTH),
    guardrails: uniqueArray(
      GuardrailSchema,
      MAX_GUARDRAILS,
      (g) => g.kind,
      "guardrail kinds",
    ).default([]),
    /** Measured and reported, never used for the decision. */
    reportedOnly: uniqueArray(
      MetricSchema,
      MAX_REPORTED_ONLY,
      (m) => m.name,
      "metric names",
    ).default([]),
    /** Smallest relative improvement worth keeping: 0.03 means 3%. */
    minEffect: z.number().gt(0).lt(1).default(0.03),
    /** Stop once the primary metric improved by this factor, e.g. 2 for `2x`. */
    targetRatio: z.number().gt(1).max(1000).optional(),
    budget: BudgetSchema.prefault({}),
  })
  .refine((objective) => !objective.reportedOnly.some((m) => m.name === objective.primary.name), {
    message: "the primary metric must not also be reported-only",
    path: ["reportedOnly"],
  });
export type Objective = z.infer<typeof ObjectiveSchema>;
