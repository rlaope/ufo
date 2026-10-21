import { oneLine } from "../text.js";

// Hot spots of one profile file: shares of the total weight, small enough that the summaries of
// several files fit in one tool result with room to spare.

/** Frames listed by self share and by total share. */
export const TOP_FRAMES = 20;
export const TOP_STACKS = 10;
/**
 * Frames shown of each stack, the leaf last: where the time goes and what called it. A frame
 * calling itself is shown once, so deep recursion still shows its caller.
 */
export const STACK_FRAMES = 5;
/** A frame or file name at most this many bytes of JSON; a longer one keeps its start and end. */
export const MAX_NAME_BYTES = 80;
const MAX_REASON_LENGTH = 200;
/**
 * A frame name as a parser keeps it. Names are counted per sample, and a speedscope frame costs
 * one byte per reference however long its name, so a longer name is cut where it is read.
 */
export const MAX_RAW_NAME = 1024;

/**
 * `name` at most `MAX_RAW_NAME` characters, its start and end kept. A shown name keeps less than
 * 50 bytes from either end, so this cut, half the cap from each, is never part of what is shown.
 */
export function rawName(name: string): string {
  if (name.length <= MAX_RAW_NAME) return name;
  const half = MAX_RAW_NAME / 2;
  return `${name.slice(0, half - 1)}…${name.slice(-half)}`;
}

export interface FrameShare {
  frame: string;
  /** Percent of the file's total weight, to one decimal. */
  pct: number;
}

export interface StackShare {
  /** The stack's leaf-most frames, the leaf last. */
  frames: string[];
  pct: number;
}

/** One profile file, or why it could not be read. */
export type FileHotspots =
  | {
      file: string;
      valid: true;
      /** What the weights count: `samples`, `microseconds`, or a speedscope unit. */
      unit: string;
      /** The file's total weight, in `unit`. */
      weight: number;
      /** Of `weight`, what V8 spent idle (`(idle)`): waiting, not computing. */
      idle?: number;
      /** Time in the frame itself. */
      self: FrameShare[];
      /** Time with the frame anywhere on the stack, counted once per stack. */
      total: FrameShare[];
      /** The heaviest stacks by self weight, by their leaf-most frames. */
      stacks: StackShare[];
      note?: string;
    }
  | { file: string; valid: false; reason: string };

/**
 * Weights a parser adds up, keyed by frame names as the profiler wrote them: the total, each
 * frame's self and total weight, and the stacks by their leaf-most frames.
 */
export class Tally {
  weight = 0;
  readonly self = new Map<string, number>();
  readonly total = new Map<string, number>();
  readonly stacks = new Map<string, { frames: readonly string[]; weight: number }>();
  /** A number per frame name, so a stack's key is short whatever its names. */
  private readonly ids = new Map<string, number>();

  addSelf(frame: string, weight: number): void {
    this.self.set(frame, (this.self.get(frame) ?? 0) + weight);
  }

  addTotal(frame: string, weight: number): void {
    this.total.set(frame, (this.total.get(frame) ?? 0) + weight);
  }

  /**
   * `frames` are a stack's leaf-most frames, at most `STACK_FRAMES`, the leaf last, a frame
   * calling itself once.
   */
  addStack(frames: readonly string[], weight: number): void {
    const key = frames
      .map((frame) => {
        let id = this.ids.get(frame);
        if (id === undefined) {
          id = this.ids.size;
          this.ids.set(frame, id);
        }
        return id;
      })
      .join(",");
    const entry = this.stacks.get(key);
    if (entry === undefined) this.stacks.set(key, { frames, weight });
    else entry.weight += weight;
  }

  /**
   * One sample of a whole stack, root first: its weight is the leaf's self weight and, once per
   * frame however often recursion repeats it, every frame's total weight.
   */
  addSample(stack: readonly string[], weight: number): void {
    this.weight += weight;
    const leaf = stack.at(-1);
    if (leaf === undefined) return;
    this.addSelf(leaf, weight);
    for (const frame of new Set(stack)) this.addTotal(frame, weight);
    const shown: string[] = [];
    for (let i = stack.length - 1; i >= 0 && shown.length < STACK_FRAMES; i--) {
      const frame = stack[i] ?? "";
      if (frame !== shown[0]) shown.unshift(frame);
    }
    this.addStack(shown, weight);
  }
}

/** What a parser makes of one file's text. */
export type Parsed =
  | { valid: true; tally: Tally; unit: string; idle?: number; note?: string }
  | { valid: false; reason: string };

export function invalid(reason: string): Parsed {
  return { valid: false, reason: oneLine(reason, MAX_REASON_LENGTH, "invalid profile") };
}

/** UTF-8 bytes `char` takes inside a JSON string. */
function jsonBytes(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (char === '"' || char === "\\") return 2;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** `text` in at most `max` bytes of JSON: whole, or its start and end around `…`. */
function fitBytes(text: string, max: number): string {
  const chars = [...text];
  if (chars.reduce((sum, char) => sum + jsonBytes(char), 0) <= max) return text;
  // The start names the function or package, the end its file and line.
  let budget = max - jsonBytes("…");
  let head = "";
  let headBudget = Math.floor(budget * 0.4);
  for (const char of chars) {
    if (jsonBytes(char) > headBudget) break;
    headBudget -= jsonBytes(char);
    budget -= jsonBytes(char);
    head += char;
  }
  let tail = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i] ?? "";
    if (jsonBytes(char) > budget) break;
    budget -= jsonBytes(char);
    tail = char + tail;
  }
  return `${head}…${tail}`;
}

/** Replaces secrets in a name; identity by default. */
export type NameRedactor = (text: string) => string;

/**
 * A name as a result shows it: the `prefixes` (arm A's directory) left out, so a path is the
 * repository's own; `redact`ed whole, before anything is cut, since a cut secret no longer
 * matches what finds it; one line, well-formed, at most `MAX_NAME_BYTES`.
 */
export function displayName(
  raw: string,
  prefixes: readonly string[] = [],
  redact: NameRedactor = (text) => text,
): string {
  let name = raw;
  for (const prefix of prefixes) if (prefix !== "") name = name.replaceAll(prefix, "");
  name = redact(name)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\p{Cs}/gu, String.fromCharCode(0xfffd))
    .trim();
  return fitBytes(name === "" ? "(unnamed)" : name, MAX_NAME_BYTES);
}

function pct(weight: number, total: number): number {
  return Math.round((weight / total) * 1000) / 10;
}

function heaviest<T>(entries: Iterable<[string, T]>, weight: (value: T) => number, count: number) {
  return [...entries]
    .filter(([, value]) => weight(value) > 0)
    .sort(([ka, a], [kb, b]) => weight(b) - weight(a) || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, count);
}

/** The hot spots of one file from what its parser found. */
export function summarize(
  file: string,
  parsed: Parsed,
  prefixes: readonly string[] = [],
  redact?: NameRedactor,
): FileHotspots {
  const name = displayName(file, [], redact);
  if (!parsed.valid) return { file: name, valid: false, reason: parsed.reason };
  const { tally } = parsed;
  if (!(tally.weight > 0) || !Number.isFinite(tally.weight)) {
    return { file: name, valid: false, reason: "the profile holds no samples" };
  }
  const names = new Map<string, string>();
  const frameName = (raw: string) => {
    let shown = names.get(raw);
    if (shown === undefined) {
      shown = displayName(raw, prefixes, redact);
      names.set(raw, shown);
    }
    return shown;
  };
  const frames = (map: Map<string, number>) =>
    heaviest(map, (w) => w, TOP_FRAMES).map(([raw, w]) => ({
      frame: frameName(raw),
      pct: pct(w, tally.weight),
    }));
  return {
    file: name,
    valid: true,
    unit: parsed.unit,
    weight: Math.round(tally.weight * 1000) / 1000,
    ...(parsed.idle === undefined || parsed.idle === 0
      ? {}
      : { idle: Math.round(parsed.idle * 1000) / 1000 }),
    self: frames(tally.self),
    total: frames(tally.total),
    stacks: heaviest(tally.stacks, (s) => s.weight, TOP_STACKS).map(([, stack]) => ({
      frames: stack.frames.map(frameName),
      pct: pct(stack.weight, tally.weight),
    })),
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
  };
}

/** Files summarized in a result; the others are counted. */
export const MAX_FILES_SUMMARIZED = 4;

/**
 * Several files (one per process the profiler reached): the busiest first (weight less idle, so
 * a wrapper process that waits on the app sorts below it), then the ones that could not be read,
 * the first `MAX_FILES_SUMMARIZED` kept and the rest counted in `omitted`.
 */
export function heaviestFiles(
  files: readonly FileHotspots[],
  unread = 0,
): { files: FileHotspots[]; omitted: number } {
  const weight = (file: FileHotspots) => (file.valid ? file.weight - (file.idle ?? 0) : -1);
  const sorted = [...files].sort(
    (a, b) => weight(b) - weight(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
  return {
    files: sorted.slice(0, MAX_FILES_SUMMARIZED),
    omitted: Math.max(0, sorted.length - MAX_FILES_SUMMARIZED) + unread,
  };
}
