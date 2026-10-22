import { z } from "zod";
import { ObjectiveSchema } from "./objective.js";
import { OracleSpecSchema } from "./oracle.js";
import { EnvNameListSchema, OptInListSchema, TargetListSchema } from "./policy.js";
import {
  CommandLineSchema,
  EnvValueSchema,
  IdSchema,
  RepoPathSchema,
  uniqueArray,
} from "./primitives.js";
import { SCHEMA_VERSION } from "./version.js";

const MAX_ORACLES = 16;
const MAX_CARDS = 256;
const MAX_CARD_DIRS = 16;
const MAX_PROFILE_ENV = 16;

/** The one placeholder of `workload.profile.env`: the profile job's own directory. */
export const PROFILE_DIR_PLACEHOLDER = "{{profile_dir}}";

/**
 * File formats `profile_target` reads hot spots from. `bundle-stats` is a build's bundle
 * analyzer JSON (webpack stats, rollup-plugin-visualizer raw-data, source-map-explorer), each
 * file's tool found from what it holds.
 */
export const ProfileFormatSchema = z.enum([
  "collapsed",
  "cpuprofile",
  "speedscope",
  "bundle-stats",
  "pprof",
]);
export type ProfileFormat = z.infer<typeof ProfileFormatSchema>;

/**
 * Profilers UFO sets up itself. `node-cpu`: `node --cpu-prof` through `NODE_OPTIONS`, with UFO's
 * preload so a server stopped by SIGTERM still writes its profile.
 */
export const ProfilePresetSchema = z.enum(["node-cpu"]);
export type ProfilePreset = z.infer<typeof ProfilePresetSchema>;

/** Workload steps a profiler can run under. */
export const ProfileStepSchema = z.enum(["setup", "start", "warmup", "command"]);
export type ProfileStep = z.infer<typeof ProfileStepSchema>;

/**
 * A variable the profiled steps get. `PATH` and `HOME` stay the run's own, and `UFO_*` names
 * are UFO's.
 */
const ProfileEnvNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an uppercase environment variable name")
  .refine((name) => name !== "PATH" && name !== "HOME", "PATH and HOME stay the run's own")
  .refine((name) => !name.startsWith("UFO_"), "UFO_ names are reserved for UFO's own variables");

/**
 * `workload.profile`: how `profile_target` runs the workload under a profiler. Only a profile
 * job uses it; baselines, samples, oracles, and the final check run unprofiled. A `preset` sets
 * `env` and `format` itself; without one, `format` is required and `env` optional (a command
 * can start the profiler itself in `$UFO_PROFILE_DIR`).
 */
export const WorkloadProfileSchema = z
  .strictObject({
    preset: ProfilePresetSchema.optional(),
    /** Added to the profiled steps; `{{profile_dir}}` is replaced with the job's directory. */
    env: z
      .record(
        z.string(),
        EnvValueSchema.refine(
          (value) => !value.replaceAll(PROFILE_DIR_PLACEHOLDER, "").includes("{{"),
          `${PROFILE_DIR_PLACEHOLDER} is the only placeholder`,
        ),
      )
      .superRefine((env, ctx) => {
        const names = Object.keys(env);
        if (names.length > MAX_PROFILE_ENV) {
          ctx.addIssue({ code: "custom", message: `must have at most ${MAX_PROFILE_ENV} entries` });
        }
        // Checked here rather than as the record's key, so the message says what is wrong.
        for (const name of names) {
          const issue = ProfileEnvNameSchema.safeParse(name).error?.issues[0];
          if (issue !== undefined)
            ctx.addIssue({ code: "custom", path: [name], message: issue.message });
        }
      })
      .optional(),
    /** Default: `[start]` when the workload has a `start`, else `[command]`. */
    steps: uniqueArray(
      ProfileStepSchema,
      ProfileStepSchema.options.length,
      (step) => step,
      "profile steps",
    )
      .min(1)
      .optional(),
    /** What the profiler writes into the directory. */
    format: ProfileFormatSchema.optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.preset === undefined) {
      if (profile.format === undefined) {
        ctx.addIssue({ code: "custom", path: ["format"], message: "is required without a preset" });
      }
      return;
    }
    for (const key of ["env", "format"] as const) {
      if (profile[key] !== undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `preset ${profile.preset} sets it` });
      }
    }
  });
export type WorkloadProfile = z.infer<typeof WorkloadProfileSchema>;

/**
 * Commands for each workload lifecycle step:
 * `setup → start → healthcheck → warmup → command (measure) → teardown → reset`.
 * Only the measure command is required; `reset` runs before every sample.
 */
export const WorkloadSchema = z
  .strictObject({
    setup: CommandLineSchema.optional(),
    start: CommandLineSchema.optional(),
    healthcheck: CommandLineSchema.optional(),
    warmup: CommandLineSchema.optional(),
    command: CommandLineSchema,
    teardown: CommandLineSchema.optional(),
    reset: CommandLineSchema.optional(),
    profile: WorkloadProfileSchema.optional(),
  })
  .superRefine((workload, ctx) => {
    for (const step of workload.profile?.steps ?? []) {
      if (workload[step] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["profile", "steps"],
          message: `${step} is not a step of this workload`,
        });
      }
    }
  });
export type Workload = z.infer<typeof WorkloadSchema>;

/** The steps a profile job runs under `workload.profile`, its default filled in. */
export function profiledSteps(workload: Workload): ProfileStep[] {
  return workload.profile?.steps ?? [workload.start === undefined ? "command" : "start"];
}

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
  /**
   * Repository directories with technique cards besides the built-in ones. Their cards are
   * covered by the approval like the others, and no change may edit them.
   */
  cardDirs: uniqueArray(RepoPathSchema, MAX_CARD_DIRS, (d) => d, "card directories").default([]),
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
