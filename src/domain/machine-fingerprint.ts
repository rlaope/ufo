import { z } from "zod";
import { labelSchema, MAX_ID_LENGTH, VersionMapSchema } from "./primitives.js";

export const PowerSourceSchema = z.enum(["ac", "battery", "unknown"]);
export type PowerSource = z.infer<typeof PowerSourceSchema>;

const MAX_CORES = 4096;
const BytesSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * The machine a bundle was measured on. Holds no hostname, username, or path: bundles are
 * published, and these would identify the person who ran them.
 */
export const MachineFingerprintSchema = z.strictObject({
  cpuModel: labelSchema(),
  cpuCores: z.number().int().min(1).max(MAX_CORES),
  memoryBytes: BytesSchema,
  os: z.strictObject({
    /** Node's `process.platform`, e.g. `darwin`, `linux`. */
    platform: labelSchema(MAX_ID_LENGTH),
    release: labelSchema(MAX_ID_LENGTH),
    arch: labelSchema(MAX_ID_LENGTH),
  }),
  /** Runtimes the target uses, e.g. `{ node: "22.11.0", java: "25" }`. */
  runtimes: VersionMapSchema.default({}),
  powerSource: PowerSourceSchema,
  /** Resources of the Docker Desktop VM, when the workload runs containers. */
  dockerVm: z
    .strictObject({
      cpus: z.number().int().min(1).max(MAX_CORES),
      memoryBytes: BytesSchema,
    })
    .optional(),
});
export type MachineFingerprint = z.infer<typeof MachineFingerprintSchema>;
