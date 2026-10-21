import { z } from "zod";
import { BottleneckSchema } from "./bottleneck.js";
import {
  BundleIdSchema,
  CommandLineSchema,
  IdSchema,
  labelSchema,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  NoteListSchema,
  RepoPathSchema,
  uniqueArray,
  VersionMapSchema,
} from "./primitives.js";
import { StackIdSchema } from "./stack.js";

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
const MAX_EDITS = 16;
const MAX_SOURCES = 16;
/** Text a `replace_text` edit finds or inserts. Larger rewrites are guided changes, not recipes. */
export const MAX_EDIT_TEXT_LENGTH = 10_000;

/** A primary source: an https URL on one line. */
const SourceUrlSchema = z
  .string()
  .max(MAX_NOTE_LENGTH)
  .regex(/^https:\/\/[^\s\p{Cc}]+$/u, "must be an https URL");

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

const EditTextSchema = z
  .string()
  .max(MAX_EDIT_TEXT_LENGTH)
  .refine((text) => !text.includes("\0"), "must not contain NUL bytes");

/**
 * Sets `key=value` in a properties-style file: the one line `key=...` is rewritten, or the line
 * is appended when the key is absent. `value` may hold `{{param}}` placeholders.
 */
const SetPropertyEditSchema = z.strictObject({
  op: z.literal("set_property"),
  file: RepoPathSchema,
  key: z
    .string()
    .min(1)
    .max(MAX_ID_LENGTH)
    .regex(/^[^\s=:#!\p{Cc}]+$/u, "must be a property key without whitespace, =, :, # or !"),
  value: z
    .string()
    .max(MAX_LABEL_LENGTH)
    .regex(/^[^\p{Cc}]*$/u, "must be a single line"),
});

/**
 * Replaces the exact text `find` with `replace`. `find` must occur exactly once in the file, so
 * the edit cannot land somewhere the card's author did not mean. `replace` may hold
 * `{{param}}` placeholders.
 */
const ReplaceTextEditSchema = z.strictObject({
  op: z.literal("replace_text"),
  file: RepoPathSchema,
  find: EditTextSchema.min(1),
  replace: EditTextSchema,
});

/** A declarative edit of a recipe card. UFO computes the diff itself from the arm A tree. */
export const RecipeEditSchema = z.discriminatedUnion("op", [
  SetPropertyEditSchema,
  ReplaceTextEditSchema,
]);
export type RecipeEdit = z.infer<typeof RecipeEditSchema>;

export const MAX_FRAME_HINTS = 8;
export const MIN_FRAME_HINT_LENGTH = 4;
export const MAX_FRAME_HINT_LENGTH = 120;
/** The share of a profile a hinted frame needs before it points at the card, by default. */
export const DEFAULT_MIN_SHARE = 0.05;

const FrameHintMatchSchema = z
  .string()
  .min(MIN_FRAME_HINT_LENGTH)
  .max(MAX_FRAME_HINT_LENGTH)
  .regex(/^\S(?:[^\p{Cc}]*\S)?$/u, "must be one line without control characters or outer spaces");

/**
 * A plain, case-sensitive substring of a profiler frame name (never a pattern), as a string or
 * with the share of the profile the frame needs, e.g. `{ match: "ClassLoader.defineClass1",
 * minShare: 0.15 }` for a frame every startup shows a little of.
 */
export const FrameHintSchema = z
  .union([
    FrameHintMatchSchema,
    z.strictObject({
      match: FrameHintMatchSchema,
      minShare: z.number().gt(0).max(1).default(DEFAULT_MIN_SHARE),
    }),
  ])
  .transform((hint) =>
    typeof hint === "string" ? { match: hint, minShare: DEFAULT_MIN_SHARE } : hint,
  );
export type FrameHint = z.output<typeof FrameHintSchema>;

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
    /** Detected stacks the card applies to; empty means any stack. */
    stacks: uniqueArray(StackIdSchema, StackIdSchema.options.length, (s) => s, "stacks").default(
      [],
    ),
    /** What limits the target when this card helps. */
    bottlenecks: uniqueArray(
      BottleneckSchema,
      BottleneckSchema.options.length,
      (b) => b,
      "bottlenecks",
    ).min(1),
    params: uniqueArray(CardParamSchema, MAX_PARAMS, (p) => p.name, "param names").default([]),
    commandTemplates: uniqueArray(
      CommandTemplateSchema,
      MAX_COMMAND_TEMPLATES,
      (t) => t.id,
      "command template ids",
    ).default([]),
    /** Recipe cards only: edits UFO applies with default parameters during `ufo run`. */
    edits: z.array(RecipeEditSchema).max(MAX_EDITS).default([]),
    memoryBudget: MemoryBudgetSchema.optional(),
    preconditions: NoteListSchema.default([]),
    /** Profiler evidence that points at this card. A card nothing points at is never chosen. */
    signals: NoteListSchema.min(1),
    /**
     * Frames whose presence in a profile's hot spots points at this card. JVM hints are
     * `Class.method` without the package, since a frame is also compared with every `/` as `.`.
     */
    frameHints: uniqueArray(
      FrameHintSchema,
      MAX_FRAME_HINTS,
      (h) => h.match,
      "frame hints",
    ).default([]),
    /** Guided cards: the ordered how-to the agent follows. */
    steps: NoteListSchema.default([]),
    verification: NoteListSchema.default([]),
    traps: NoteListSchema.default([]),
    /** One line with its condition, e.g. "startup -20-40% on JDK 24+ with a training run". */
    expectedEffect: labelSchema().optional(),
    /** Primary sources (documentation, specifications) the card was written from. */
    sources: uniqueArray(SourceUrlSchema, MAX_SOURCES, (u) => u, "sources").default([]),
    /** Tools whose flags churn, pinned to the version the templates were written for. */
    pinnedToolVersions: VersionMapSchema.default({}),
    verifiedIn: z.union([
      z.literal("unverified"),
      uniqueArray(BundleIdSchema, MAX_VERIFIED_IN, (b) => b, "bundle ids").min(1),
    ]),
  })
  .superRefine((card, ctx) => {
    if (card.domain !== "generic" && card.sources.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a card outside the generic domain needs at least one primary source",
        path: ["sources"],
      });
    }
    if (card.kind === "recipe" && card.commandTemplates.length === 0 && card.edits.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a recipe card needs at least one command template or edit",
        path: ["commandTemplates"],
      });
    }
    if (card.kind === "guided" && card.edits.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "only recipe cards have edits; a guided change is written by the agent",
        path: ["edits"],
      });
    }
    const declared = new Set(card.params.map((p) => p.name));
    card.edits.forEach((edit, index) => {
      const text = edit.op === "set_property" ? edit.value : edit.replace;
      for (const match of text.matchAll(PLACEHOLDER)) {
        const name = match[1] ?? "";
        if (!declared.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `placeholder {{${name}}} is not a param declared on the card`,
            path: ["edits", index, edit.op === "set_property" ? "value" : "replace"],
          });
        }
      }
    });
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
