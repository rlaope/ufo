import { invalid, type Parsed, rawName, Tally } from "./summary.js";

// What `jfr print --json` writes of a JDK Flight Recorder recording (the JDK's
// jdk.jfr.internal.tool.JSONWriter): {"recording": {"events": [{"type": ..., "values": {...}},
// ...]}}. An execution sample's values hold `stackTrace` with `truncated` and `frames`, the
// innermost first, each `{ method: { type: { name }, name }, lineNumber, ... }`, with the class
// name as the recording stores it (`java/lang/String`). The output is read as it streams: each
// event is cut out at the depth of the events array and parsed alone, so memory holds one event,
// never the whole output, which runs to kilobytes per frame.

/** The event UFO reads: a sampled Java thread's stack. */
export const JFR_EVENT = "jdk.ExecutionSample";
/** Frames of a sample read, the innermost first: what `jfr print --stack-depth` is given. */
export const JFR_STACK_DEPTH = 64;

export interface JfrLimits {
  /** Samples counted; reading stops at the last one. */
  readonly samples: number;
  /** Bytes of one event; a larger one makes the output invalid. */
  readonly eventBytes: number;
  /** Bytes of output read; reading stops there. */
  readonly outputBytes: number;
}

export const JFR_LIMITS: JfrLimits = {
  samples: 100_000,
  eventBytes: 4 * 1024 * 1024,
  outputBytes: 512 * 1024 * 1024,
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
/** Root object, `recording`, `events`: an event opens at this depth. */
const EVENT_DEPTH = 3;

/** `Class.method` as JFR's own API names a frame, the class with dots; `undefined` if unnamed. */
function frameName(frame: unknown): string | undefined {
  const method = isObject(frame) ? frame.method : undefined;
  const type = isObject(method) ? method.type : undefined;
  if (!isObject(method) || !isObject(type)) return undefined;
  if (typeof type.name !== "string" || typeof method.name !== "string") return undefined;
  return rawName(`${type.name.replaceAll("/", ".")}.${method.name}`);
}

/**
 * Reads `jfr print --json` output chunk by chunk into a tally of its execution samples, weight 1
 * each, within `limits`. Strings are skipped byte by byte (an escape, then the byte after it), so
 * a bracket inside a name never moves the depth.
 */
export class JfrReader {
  private readonly limits: JfrLimits;
  private readonly tally = new Tally();
  private depth = 0;
  private inString = false;
  private escaped = false;
  private started = false;
  private ended = false;
  /** The event being cut out, in pieces, while one is open. */
  private event: Buffer[] | undefined;
  private eventBytes = 0;
  private read = 0;
  private samples = 0;
  private cutStacks = 0;
  private unstacked = 0;
  private problem: string | undefined;
  /** Why reading stopped before the output ended. */
  private stopped: string | undefined;

  // Assigned here rather than as a parameter property: Node's type stripping, which runs the
  // worker from the sources, does not support those.
  constructor(limits: JfrLimits = JFR_LIMITS) {
    this.limits = limits;
  }

  /** Reads the next chunk; `false` once it reads no more (a limit reached, or invalid output). */
  push(chunk: Buffer): boolean {
    if (this.done()) return false;
    const over = this.read + chunk.length > this.limits.outputBytes;
    const bytes = over ? chunk.subarray(0, this.limits.outputBytes - this.read) : chunk;
    this.read += bytes.length;
    let from = 0;
    for (let i = 0; i < bytes.length && this.problem === undefined; i++) {
      const byte = bytes[i] ?? 0;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (byte === BACKSLASH) this.escaped = true;
        else if (byte === QUOTE) this.inString = false;
        continue;
      }
      if (!this.started) {
        if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) continue;
        if (byte !== OPEN_OBJECT) return this.fail("not JSON: not jfr print --json output");
        this.started = true;
      }
      if (byte === QUOTE) this.inString = true;
      else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        if (this.ended) return this.fail("more than one JSON document");
        if (this.depth === EVENT_DEPTH && byte === OPEN_OBJECT) {
          this.event = [];
          this.eventBytes = 0;
          from = i;
        }
        this.depth++;
      } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        if (this.depth === 0) return this.fail("not JSON: a bracket closes nothing");
        this.depth--;
        if (this.depth === EVENT_DEPTH && this.event !== undefined) {
          this.keep(bytes.subarray(from, i + 1));
          if (this.problem === undefined) this.addEvent();
          if (this.done()) return false;
        }
        if (this.depth === 0) this.ended = true;
      }
    }
    if (this.event !== undefined && this.problem === undefined) this.keep(bytes.subarray(from));
    if (over) this.stop(`jfr print wrote more than ${this.limits.outputBytes / 1024 / 1024} MiB`);
    return !this.done();
  }

  /** Ends reading early, keeping what was read: `reason` says why, in the file's note. */
  stop(reason: string): void {
    this.stopped ??= reason;
  }

  /** The samples read: invalid output, or the tally with a note on what it leaves out. */
  finish(): Parsed {
    if (this.problem !== undefined) return invalid(this.problem);
    if (this.stopped === undefined && !this.ended) {
      return invalid("the jfr print output ends before its last event");
    }
    if (this.samples === 0) {
      return invalid(
        this.stopped === undefined
          ? `the recording holds no ${JFR_EVENT} events`
          : `${this.stopped} before a sample was read`,
      );
    }
    const notes: string[] = [];
    if (this.stopped !== undefined) {
      notes.push(`${this.stopped}: the first ${this.samples} samples are counted`);
    }
    if (this.cutStacks > 0) {
      notes.push(
        `${this.cutStacks} of ${this.samples} samples have more than ${JFR_STACK_DEPTH} frames, their outermost ones left out of total shares`,
      );
    }
    if (this.unstacked > 0) notes.push(`${this.unstacked} samples without a stack are left out`);
    return {
      valid: true,
      tally: this.tally,
      unit: "samples",
      ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
    };
  }

  private done(): boolean {
    return this.problem !== undefined || this.stopped !== undefined;
  }

  private fail(reason: string): false {
    this.problem = reason;
    return false;
  }

  private keep(piece: Buffer): void {
    if (this.event === undefined) return;
    this.eventBytes += piece.length;
    if (this.eventBytes > this.limits.eventBytes) {
      this.fail(`an event is larger than ${this.limits.eventBytes / 1024 / 1024} MiB`);
      return;
    }
    // A copy: the chunk's memory is reused once this returns.
    this.event.push(Buffer.from(piece));
  }

  private addEvent(): void {
    const text = Buffer.concat(this.event ?? []).toString("utf8");
    this.event = undefined;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      this.fail("not JSON: an event does not parse");
      return;
    }
    if (!isObject(event) || event.type !== JFR_EVENT) return;
    const values = isObject(event.values) ? event.values : undefined;
    const trace = isObject(values?.stackTrace) ? values.stackTrace : undefined;
    if (trace === undefined || !Array.isArray(trace.frames) || trace.frames.length === 0) {
      this.unstacked++;
      return;
    }
    if (this.samples === this.limits.samples) {
      this.stop(`more than ${this.limits.samples} samples`);
      return;
    }
    const frames: unknown[] = trace.frames.slice(0, JFR_STACK_DEPTH);
    if (trace.truncated === true || trace.frames.length > JFR_STACK_DEPTH) this.cutStacks++;
    // Innermost first in the recording; the tally takes the root first.
    const stack = frames.map((frame) => frameName(frame) ?? "(unnamed frame)").reverse();
    this.tally.addSample(stack, 1);
    this.samples++;
  }
}

/** `jfr print --json` output held whole, as `JfrReader` reads it streamed. */
export function parseJfrJson(text: string, limits: JfrLimits = JFR_LIMITS): Parsed {
  const reader = new JfrReader(limits);
  reader.push(Buffer.from(text, "utf8"));
  return reader.finish();
}
