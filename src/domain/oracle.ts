import { z } from "zod";
import {
  CommandLineSchema,
  GitShaSchema,
  IdSchema,
  labelSchema,
  MAX_NOTE_LENGTH,
  RepoPathSchema,
} from "./primitives.js";

/** What an oracle compares between baseline and candidate. */
export const OracleKindSchema = z.enum([
  "test_pass_set",
  "http_golden",
  "result_set_equality",
  "smoke",
  "quality_eval",
  "loss_tolerance",
]);
export type OracleKind = z.infer<typeof OracleKindSchema>;

/** An oracle as declared in `ufo.yaml`. Its command is part of the approved command set. */
export const OracleSpecSchema = z.strictObject({
  name: IdSchema,
  kind: OracleKindSchema,
  command: CommandLineSchema,
});
export type OracleSpec = z.infer<typeof OracleSpecSchema>;

/** One oracle run against one SHA. */
export const OracleResultSchema = z.strictObject({
  oracle: IdSchema,
  sha: GitShaSchema,
  /** The change under test; absent for baseline and final-check runs. */
  changeId: z.uuid().optional(),
  passed: z.boolean(),
  /** Score for `quality_eval` and `loss_tolerance` oracles, in the oracle's own unit. */
  score: z.number().optional(),
  summary: labelSchema(MAX_NOTE_LENGTH).optional(),
  /** Full output, relative to the run state directory. */
  artifactRef: RepoPathSchema.optional(),
});
export type OracleResult = z.infer<typeof OracleResultSchema>;
