import { z } from "zod";
import { GitShaSchema, IdSchema, idRecord, labelSchema } from "./primitives.js";

export const ArmSchema = z.enum(["a", "b"]);
export type Arm = z.infer<typeof ArmSchema>;

/**
 * Baseline runs at A, decision pairs for one change, the final baseline-vs-final check, or one
 * profiling run at A (`profile_target`), which decides nothing.
 */
export const SamplePhaseSchema = z.enum(["baseline", "change", "final_check", "profile"]);
export type SamplePhase = z.infer<typeof SamplePhaseSchema>;

/** One day. A single replication unit (one launch, load run, build, ...) never takes longer. */
export const MAX_SAMPLE_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_SEQUENCE_INDEX = 999;

/** One independent run of the workload in one arm. */
export const SampleSchema = z
  .strictObject({
    phase: SamplePhaseSchema,
    /** Set exactly when `phase` is `change`. */
    changeId: z.uuid().optional(),
    arm: ArmSchema,
    sha: GitShaSchema,
    /** Position in the interleaved A B A B sequence; an A and a B with the same index are a pair. */
    index: z.number().int().min(0).max(MAX_SEQUENCE_INDEX),
    metric: IdSchema,
    value: z.number().min(0),
    /** Guardrail and reported-only metrics measured in the same run, keyed by metric name. */
    secondary: idRecord(z.number()).default({}),
    startedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().min(0).max(MAX_SAMPLE_DURATION_MS),
    /** Invalid samples (dropped load iterations, sleep/wake, hygiene failure) are kept but not used. */
    valid: z.boolean(),
    invalidReason: labelSchema().optional(),
  })
  .superRefine((sample, ctx) => {
    if ((sample.phase === "change") !== (sample.changeId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "changeId is set exactly when phase is change",
        path: ["changeId"],
      });
    }
    if (sample.valid === (sample.invalidReason !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "invalidReason is set exactly when the sample is invalid",
        path: ["invalidReason"],
      });
    }
  });
export type Sample = z.infer<typeof SampleSchema>;
