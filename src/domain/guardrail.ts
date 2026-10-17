import { z } from "zod";

/** Error rate may rise by at most this many percentage points over baseline. */
const ErrorRateGuardrailSchema = z.strictObject({
  kind: z.literal("error_rate"),
  maxDeltaPp: z.number().min(0).max(100).default(0.1),
});

/** RSS/heap may grow to at most this ratio of baseline, unless an approved card declares a budget. */
const MemoryGuardrailSchema = z.strictObject({
  kind: z.literal("memory"),
  maxRatio: z.number().min(1).max(100).default(1.2),
});

/** The candidate's test pass set must contain the baseline pass set, with zero new failures. */
const TestPassSetGuardrailSchema = z.strictObject({
  kind: z.literal("test_pass_set"),
});

/**
 * Quality may drop by at most the tolerance, in percentage points:
 * `max(floorPp, 100 / evalSize, baselineSpreadPp)`. `evalSize` and `baselineSpreadPp` are known
 * once the quality oracle has run at baseline.
 */
const QualityGuardrailSchema = z.strictObject({
  kind: z.literal("quality"),
  floorPp: z.number().min(0).max(100).default(1),
  evalSize: z.number().int().min(1).max(1_000_000).optional(),
  baselineSpreadPp: z.number().min(0).max(100).optional(),
});

export const GuardrailSchema = z.discriminatedUnion("kind", [
  ErrorRateGuardrailSchema,
  MemoryGuardrailSchema,
  TestPassSetGuardrailSchema,
  QualityGuardrailSchema,
]);
export type Guardrail = z.infer<typeof GuardrailSchema>;

/** Guardrail kinds as a standalone enum, used in `guardrail:<kind>` decision reasons. */
export const GuardrailKindSchema = z.enum(["error_rate", "memory", "test_pass_set", "quality"]);
export type GuardrailKind = z.infer<typeof GuardrailKindSchema>;
