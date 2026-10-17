import { z } from "zod";
import { ChangeSchema } from "./change.js";
import { DecisionSchema } from "./decision.js";
import { MachineFingerprintSchema } from "./machine-fingerprint.js";
import { ObjectiveSchema } from "./objective.js";
import { OracleResultSchema } from "./oracle.js";
import {
  BundleIdSchema,
  CommandLineSchema,
  GitShaSchema,
  IdSchema,
  labelSchema,
  MAX_NOTE_LENGTH,
  uniqueArray,
  VersionMapSchema,
} from "./primitives.js";
import { SampleSchema } from "./sample.js";
import { SCHEMA_VERSION } from "./version.js";

const MAX_COMMANDS = 256;
const MAX_CHANGES = 1000;
const MAX_SAMPLES = 100_000;
const MAX_ORACLE_RESULTS = 10_000;
const MAX_LIMITATIONS = 256;

/** Everything needed to audit and reproduce one run. */
export const EvidenceBundleSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    bundleId: BundleIdSchema,
    createdAt: z.iso.datetime({ offset: true }),
    objective: ObjectiveSchema,
    machine: MachineFingerprintSchema,
    /** Every command UFO ran, after parameter substitution. */
    commands: z.array(CommandLineSchema).max(MAX_COMMANDS),
    toolVersions: VersionMapSchema,
    shas: z.strictObject({ baseline: GitShaSchema, final: GitShaSchema }),
    samples: z.array(SampleSchema).max(MAX_SAMPLES),
    changes: uniqueArray(ChangeSchema, MAX_CHANGES, (c) => c.changeId, "change ids"),
    oracleResults: z.array(OracleResultSchema).max(MAX_ORACLE_RESULTS),
    decisions: uniqueArray(DecisionSchema, MAX_CHANGES, (d) => d.changeId, "decision change ids"),
    /** e.g. flaky tests excluded from the pass set, macOS measurement limits. */
    limitations: z.array(labelSchema(MAX_NOTE_LENGTH)).max(MAX_LIMITATIONS),
    /** `claude-code`, `codex`, `cursor`, or `none` for a recipe-only `ufo run`. */
    hostAgent: IdSchema,
    /** Reported by the agent itself; UFO cannot verify it. */
    modelId: labelSchema().optional(),
    modelIdSource: z.literal("self_reported").optional(),
  })
  .superRefine((bundle, ctx) => {
    if ((bundle.modelId === undefined) !== (bundle.modelIdSource === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "modelId and modelIdSource are set together",
        path: ["modelIdSource"],
      });
    }
    const changeIds = new Set(bundle.changes.map((c) => c.changeId));
    for (const field of ["decisions", "samples", "oracleResults"] as const) {
      bundle[field].forEach((entry: { changeId?: string | undefined }, index) => {
        if (entry.changeId !== undefined && !changeIds.has(entry.changeId)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown change ${entry.changeId}`,
            path: [field, index, "changeId"],
          });
        }
      });
    }
  });
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
