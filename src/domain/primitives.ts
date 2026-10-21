import { z } from "zod";

// Bounds shared by the domain schemas. Each limit is far above any legitimate value and exists so
// that a malformed or hostile document (an evidence bundle passed to `ufo verify-bundle`, a
// `ufo.yaml` drafted by an agent) is rejected before it is processed.

/** Ids and names (metrics, cards, oracles, tools). Long enough for `domain.technique-name`. */
export const MAX_ID_LENGTH = 64;
/** One-line human-readable text: a unit, a title, a version string, a reason. */
export const MAX_LABEL_LENGTH = 200;
/** A sentence or short paragraph: a scenario, a precondition, a known trap. */
export const MAX_NOTE_LENGTH = 1000;
/** Notes per list (preconditions, signals, traps, limitations of one card). */
export const MAX_NOTES = 32;
/** One shell command line, e.g. a workload or oracle command. */
export const MAX_COMMAND_LENGTH = 4000;
/** Repository-relative path or glob. Matches the common PATH_MAX of 4096 with room to spare. */
export const MAX_PATH_LENGTH = 1024;

/** Lowercase dotted/kebab/snake identifier, e.g. `p95_latency`, `jvm.aot-cache`. */
export const IdSchema = z
  .string()
  .max(MAX_ID_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "must be a lowercase identifier");

/** Full 40-character lowercase git commit SHA. Abbreviated SHAs are ambiguous and rejected. */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character git SHA");

/** Lowercase hex SHA-256 digest. */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 digest");

/** One-line text: trimmed, non-empty, no control characters. */
export function labelSchema(max: number = MAX_LABEL_LENGTH) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");
}

/** A short list of human-readable notes. */
export const NoteListSchema = z.array(labelSchema(MAX_NOTE_LENGTH)).max(MAX_NOTES);

// Bidi overrides, zero-width characters, and exotic spaces would make the line `ufo approve`
// prints look different from the bytes that run.
const NO_INVISIBLE = /^[^\p{Cf}\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const NO_INVISIBLE_MESSAGE = "must not contain invisible format characters or non-ASCII spaces";

/**
 * A single shell command line. Newlines are rejected so the command `ufo approve` prints is
 * exactly the command that runs.
 */
export const CommandLineSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_COMMAND_LENGTH)
  .regex(/^[^\p{Cc}]*$/u, "must be a single line without control characters")
  .regex(NO_INVISIBLE, NO_INVISIBLE_MESSAGE);

/** An environment variable's value that `ufo approve` shows: one line, as it is, maybe empty. */
export const EnvValueSchema = z
  .string()
  .max(MAX_COMMAND_LENGTH)
  .regex(/^[^\p{Cc}]*$/u, "must be a single line without control characters")
  .regex(NO_INVISIBLE, NO_INVISIBLE_MESSAGE);

/** Repository-relative path or glob: no absolute paths, no `..` segments, no backslashes. */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(/^[^\p{Cc}\\]*$/u, "must not contain control characters or backslashes")
  .refine((path) => !path.startsWith("/"), "must be relative to the repository root")
  .refine((path) => !path.split("/").includes(".."), "must not contain `..` segments");

/** Evidence bundle id, e.g. `server-jvm-2026-10-17.1`. */
export const BundleIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a lowercase bundle id");

/** Entries per record (tool versions, secondary sample values). */
export const MAX_RECORD_ENTRIES = 64;

/** Record keyed by identifiers, with at most `MAX_RECORD_ENTRIES` entries. */
export function idRecord<T extends z.ZodType>(value: T) {
  return z
    .record(IdSchema, value)
    .refine(
      (record) => Object.keys(record).length <= MAX_RECORD_ENTRIES,
      `must have at most ${MAX_RECORD_ENTRIES} entries`,
    );
}

/** Map from a tool or runtime name to its version, e.g. `{ k6: "0.54.0" }`. */
export const VersionMapSchema = idRecord(labelSchema(MAX_ID_LENGTH));

/** Array whose elements are unique under `key`. */
export function uniqueArray<T extends z.ZodType>(
  item: T,
  max: number,
  key: (value: z.output<T>) => unknown,
  what: string,
) {
  return z
    .array(item)
    .max(max)
    .refine((values) => new Set(values.map(key)).size === values.length, `${what} must be unique`);
}
