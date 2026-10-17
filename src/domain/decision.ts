import { z } from "zod";
import { GuardrailKindSchema } from "./guardrail.js";
import { IdSchema, labelSchema, MAX_ID_LENGTH, MAX_NOTE_LENGTH } from "./primitives.js";

export const DecisionOutcomeSchema = z.enum(["keep", "drop", "inconclusive"]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** Policy rule names are snake_case, e.g. `protected_path`, `test_set_shrunk`, `noise_floor`. */
export const PolicyRuleSchema = z
  .string()
  .max(MAX_ID_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "must be a snake_case rule name");

/** Longest prefix (`guardrail:`) plus the longest name. */
const MAX_REASON_LENGTH = "guardrail:".length + MAX_ID_LENGTH;

/** Why a change was not kept. A kept change has no reason. */
export const DecisionReasonSchema = z
  .union([
    z.enum(["no_effect", "regressed", "inconclusive", "patch_failed", "build_failed"]),
    z.templateLiteral(["guardrail:", GuardrailKindSchema]),
    z.templateLiteral(["oracle:", IdSchema]),
    z.templateLiteral(["policy:", PolicyRuleSchema]),
  ])
  .refine(
    (reason) => reason.length <= MAX_REASON_LENGTH,
    `must be at most ${MAX_REASON_LENGTH} characters`,
  );
export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

/** Five pairs, plus one escalation of five more (measurement policy, stochastic metrics). */
export const MAX_PAIRS = 10;

/** One interleaved A/B pair of primary-metric samples. */
export const PairSchema = z.strictObject({
  a: z.number().min(0),
  b: z.number().min(0),
});
export type Pair = z.infer<typeof PairSchema>;

export const DecisionSchema = z
  .strictObject({
    /** The `Ufo-Change-Id` of the change this decision is about. */
    changeId: z.uuid(),
    outcome: DecisionOutcomeSchema,
    /**
     * Signed relative improvement of the primary metric's median, B over A, oriented so that a
     * positive value is always better: 0.1 means 10% better. Absent when nothing was measured.
     */
    effect: z.number().optional(),
    pairs: z.array(PairSchema).max(MAX_PAIRS).default([]),
    reason: DecisionReasonSchema.optional(),
    /** Human-readable detail, e.g. the likely cause of a `policy:noise_floor` refusal. */
    detail: labelSchema(MAX_NOTE_LENGTH).optional(),
  })
  .superRefine((decision, ctx) => {
    if (decision.outcome === "keep" && decision.reason !== undefined) {
      ctx.addIssue({ code: "custom", message: "a kept change has no reason", path: ["reason"] });
    }
    if (decision.outcome !== "keep" && decision.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "only a kept change has no reason",
        path: ["reason"],
      });
    }
    if (decision.outcome === "keep" && decision.pairs.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a kept change needs measured pairs",
        path: ["pairs"],
      });
    }
    if ((decision.effect === undefined) !== (decision.pairs.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "effect is present exactly when pairs were measured",
        path: ["effect"],
      });
    }
    if (decision.reason === "inconclusive" && decision.outcome !== "inconclusive") {
      ctx.addIssue({
        code: "custom",
        message: "reason inconclusive requires outcome inconclusive",
        path: ["outcome"],
      });
    }
    // Besides a borderline result, only a policy refusal to decide (e.g. `policy:noise_floor`)
    // leaves a change inconclusive.
    if (
      decision.outcome === "inconclusive" &&
      decision.reason !== undefined &&
      decision.reason !== "inconclusive" &&
      !decision.reason.startsWith("policy:")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "an inconclusive outcome needs reason inconclusive or a policy refusal",
        path: ["reason"],
      });
    }
  });
export type Decision = z.infer<typeof DecisionSchema>;
