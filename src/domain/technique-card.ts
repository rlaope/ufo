import { z } from "zod";
import {
  BundleIdSchema,
  CommandLineSchema,
  IdSchema,
  labelSchema,
  MAX_ID_LENGTH,
  NoteListSchema,
  uniqueArray,
  VersionMapSchema,
} from "./primitives.js";

export const TechniqueKindSchema = z.enum(["recipe", "guided"]);
export type TechniqueKind = z.infer<typeof TechniqueKindSchema>;

/**
 * Owned by the card, never by the agent. `numeric` counts as lossless only while the quality
 * oracle stays within tolerance.
 */
export const RiskClassSchema = z.enum(["lossless", "numeric", "lossy", "upgrade"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

const MAX_PARAMS = 16;
const MAX_COMMAND_TEMPLATES = 8;
const MAX_ENUM_VALUES = 32;
const MAX_VERIFIED_IN = 64;

/** Enum values are substituted into commands, so they carry no shell metacharacters. */
const ParamTokenSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9._:/=+-]+$/, "must not contain shell metacharacters");

// Parameters have no free-form string type: every substituted value is a number, a boolean, or
// one of a fixed set of tokens, so a template cannot be turned into an arbitrary command.
const IntegerParamSchema = z
  .strictObject({
    name: IdSchema,
    type: z.literal("integer"),
    min: z.number().int(),
    max: z.number().int(),
    default: z.number().int(),
  })
  .refine((p) => p.min <= p.default && p.default <= p.max, "default must be within [min, max]");

const NumberParamSchema = z
  .strictObject({
    name: IdSchema,
    type: z.literal("number"),
    min: z.number(),
    max: z.number(),
    default: z.number(),
  })
  .refine((p) => p.min <= p.default && p.default <= p.max, "default must be within [min, max]");

const EnumParamSchema = z
  .strictObject({
    name: IdSchema,
    type: z.literal("enum"),
    values: uniqueArray(ParamTokenSchema, MAX_ENUM_VALUES, (v) => v, "enum values").min(1),
    default: ParamTokenSchema,
  })
  .refine((p) => p.values.includes(p.default), "default must be one of values");

const BooleanParamSchema = z.strictObject({
  name: IdSchema,
  type: z.literal("boolean"),
  default: z.boolean(),
});

export const CardParamSchema = z.discriminatedUnion("type", [
  IntegerParamSchema,
  NumberParamSchema,
  EnumParamSchema,
  BooleanParamSchema,
]);
export type CardParam = z.infer<typeof CardParamSchema>;

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;

export const CommandTemplateSchema = z.strictObject({
  id: IdSchema,
  /** Command line with `{{param}}` placeholders, e.g. `java -Xmx{{heap_mb}}m -jar app.jar`. */
  run: CommandLineSchema,
  /** Names of the card parameters this template substitutes. */
  params: uniqueArray(IdSchema, MAX_PARAMS, (p) => p, "template params").default([]),
});
export type CommandTemplate = z.infer<typeof CommandTemplateSchema>;

/** Overrides the memory guardrail for this card; takes effect only once approved with `ufo.yaml`. */
export const MemoryBudgetSchema = z.strictObject({
  maxRatio: z.number().min(1).max(100),
});
export type MemoryBudget = z.infer<typeof MemoryBudgetSchema>;

export const TechniqueCardSchema = z
  .strictObject({
    id: IdSchema,
    domain: IdSchema,
    title: labelSchema(),
    kind: TechniqueKindSchema,
    riskClass: RiskClassSchema,
    params: uniqueArray(CardParamSchema, MAX_PARAMS, (p) => p.name, "param names").default([]),
    commandTemplates: uniqueArray(
      CommandTemplateSchema,
      MAX_COMMAND_TEMPLATES,
      (t) => t.id,
      "command template ids",
    ).default([]),
    memoryBudget: MemoryBudgetSchema.optional(),
    preconditions: NoteListSchema.default([]),
    /** Profiler evidence that points at this card. A card nothing points at is never chosen. */
    signals: NoteListSchema.min(1),
    verification: NoteListSchema.default([]),
    traps: NoteListSchema.default([]),
    /** Tools whose flags churn, pinned to the version the templates were written for. */
    pinnedToolVersions: VersionMapSchema.default({}),
    verifiedIn: z.union([
      z.literal("unverified"),
      uniqueArray(BundleIdSchema, MAX_VERIFIED_IN, (b) => b, "bundle ids").min(1),
    ]),
  })
  .superRefine((card, ctx) => {
    if (card.kind === "recipe" && card.commandTemplates.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a recipe card needs at least one command template",
        path: ["commandTemplates"],
      });
    }
    const declared = new Set(card.params.map((p) => p.name));
    card.commandTemplates.forEach((template, index) => {
      const used = new Set(Array.from(template.run.matchAll(PLACEHOLDER), (m) => m[1]));
      for (const name of used) {
        if (name === undefined || !template.params.includes(name)) {
          ctx.addIssue({
            code: "custom",
            message: `placeholder {{${name ?? ""}}} is not listed in params`,
            path: ["commandTemplates", index, "run"],
          });
        }
      }
      for (const name of template.params) {
        if (!declared.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `param ${name} is not declared on the card`,
            path: ["commandTemplates", index, "params"],
          });
        } else if (!used.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `param ${name} is listed but never used in run`,
            path: ["commandTemplates", index, "params"],
          });
        }
      }
    });
  });
export type TechniqueCard = z.infer<typeof TechniqueCardSchema>;
