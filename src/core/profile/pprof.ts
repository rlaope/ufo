import { gunzipSync } from "node:zlib";
import { invalid, type Parsed, rawName, Tally } from "./summary.js";

// Go's pprof profile (https://github.com/google/pprof/blob/main/proto/profile.proto): a
// protobuf message, usually gzip-compressed. Only the fields hot spots need are read, with a
// small decoder that walks each message once, never recursing.

/** Bytes a profile may decompress to; a larger one is refused rather than inflated further. */
export const MAX_PPROF_BYTES = 64 * 1024 * 1024;
/** Entries of each table (sample types, samples, locations, lines, functions, strings). */
export const MAX_PPROF_ENTRIES = 1_000_000;
/**
 * Frames over all samples' stacks, inline frames included. A sample names each location in one
 * or two bytes however many frames it holds, so the stacks are bounded, not only the bytes.
 */
export const MAX_PPROF_FRAMES = 16_000_000;

/** Why a profile cannot be read; thrown inside the decoder only. */
class Unreadable extends Error {}

function malformed(what: string): Unreadable {
  return new Unreadable(`not a pprof profile: ${what}`);
}

const VARINT = 0;
const FIXED64 = 1;
const BYTES = 2;
const FIXED32 = 5;

/** The fields of one message in `buf[start, end)`, in order. */
class Fields {
  field = 0;
  wire = 0;
  /** A varint field's value: exact up to 2^53, larger ones approximate. */
  value = 0;
  /** A length-delimited field's bytes. */
  start = 0;
  end = 0;
  private readonly buf: Uint8Array;
  private readonly limit: number;
  private pos: number;

  // Fields assigned here rather than as parameter properties: Node's type stripping, which runs
  // the worker from the sources, does not support those.
  constructor(buf: Uint8Array, start: number, limit: number) {
    this.buf = buf;
    this.pos = start;
    this.limit = limit;
  }

  next(): boolean {
    if (this.pos >= this.limit) return false;
    const key = this.varint();
    this.field = Math.floor(key / 8);
    this.wire = key % 8;
    if (this.field === 0) throw malformed("a field numbered 0");
    if (this.wire === VARINT) this.value = this.varint();
    else if (this.wire === FIXED64) this.skip(8);
    else if (this.wire === FIXED32) this.skip(4);
    else if (this.wire === BYTES) {
      const length = this.varint();
      this.start = this.pos;
      this.skip(length);
      this.end = this.pos;
    } else throw malformed(`wire type ${this.wire}`);
    return true;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.limit) throw malformed("a varint runs past its message");
      const byte = this.buf[this.pos++] ?? 0;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
    throw malformed("a varint longer than 10 bytes");
  }

  /**
   * The values of a repeated integer field, one value or a packed run of them, into `into`,
   * which `tooMany` refuses to hold more than `max` of: a byte each would be eight as numbers.
   */
  integers(into: number[], max: number, tooMany: () => Unreadable): void {
    if (this.wire === VARINT) {
      if (into.length >= max) throw tooMany();
      into.push(this.value);
      return;
    }
    if (this.wire !== BYTES) throw malformed(`field ${this.field} is not an integer`);
    const packed = new Fields(this.buf, this.start, this.end);
    while (packed.pos < packed.limit) {
      if (into.length >= max) throw tooMany();
      into.push(packed.varint());
    }
  }

  expect(wire: number): void {
    if (this.wire !== wire) throw malformed(`field ${this.field} has wire type ${this.wire}`);
  }

  private skip(length: number): void {
    if (length > this.limit - this.pos) throw malformed("a field runs past its message");
    this.pos += length;
  }
}

function tooManyFrames(): Unreadable {
  return new Unreadable(`more than ${MAX_PPROF_FRAMES} frames over its samples`);
}

/** An id or index: a whole number exactly as written. */
function exact(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw malformed(`${what} is out of range`);
  return value;
}

/** Spans `[start, end)` of a repeated message field, counted against `MAX_PPROF_ENTRIES`. */
function addSpan(spans: number[], fields: Fields, what: string): void {
  fields.expect(BYTES);
  if (spans.length >= 2 * MAX_PPROF_ENTRIES) {
    throw new Unreadable(`more than ${MAX_PPROF_ENTRIES} ${what}`);
  }
  spans.push(fields.start, fields.end);
}

/** A sample type's unit as a result shows it: a plain word, else `value`. */
function unitOf(unit: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(unit) ? unit : "value";
}

function decode(data: Uint8Array): Parsed {
  if (data.length > MAX_PPROF_BYTES) {
    return invalid(`larger than ${MAX_PPROF_BYTES / 1024 / 1024} MiB`);
  }
  const sampleTypes: number[] = [];
  const samples: number[] = [];
  const locations: number[] = [];
  const functions: number[] = [];
  const strings: number[] = [];
  let defaultType = 0;
  const top = new Fields(data, 0, data.length);
  while (top.next()) {
    if (top.field === 1) addSpan(sampleTypes, top, "sample types");
    else if (top.field === 2) addSpan(samples, top, "samples");
    else if (top.field === 4) addSpan(locations, top, "locations");
    else if (top.field === 5) addSpan(functions, top, "functions");
    else if (top.field === 6) addSpan(strings, top, "strings");
    else if (top.field === 14) {
      top.expect(VARINT);
      defaultType = top.value;
    }
  }

  // Strings are decoded when a name or unit needs one, each once.
  const decoder = new TextDecoder();
  const decoded = new Map<number, string>();
  const text = (index: number, what: string): string => {
    if (!Number.isSafeInteger(index) || index >= strings.length / 2) {
      throw malformed(`the ${what} is not in string_table`);
    }
    let value = decoded.get(index);
    if (value === undefined) {
      value = rawName(decoder.decode(data.subarray(strings[2 * index], strings[2 * index + 1])));
      decoded.set(index, value);
    }
    return value;
  };
  if (strings.length === 0 || text(0, "string") !== "") {
    throw malformed('string_table[0] is not ""');
  }

  // The weights: the default sample type's values, else the last type's, as pprof reads them.
  const types: { type: number; unit: number }[] = [];
  for (let i = 0; i < sampleTypes.length; i += 2) {
    const entry = { type: 0, unit: 0 };
    const fields = new Fields(data, sampleTypes[i] ?? 0, sampleTypes[i + 1] ?? 0);
    while (fields.next()) {
      if (fields.field === 1 || fields.field === 2) {
        fields.expect(VARINT);
        entry[fields.field === 1 ? "type" : "unit"] = exact(fields.value, "a string index");
      }
    }
    types.push(entry);
  }
  if (types.length === 0) throw malformed("no sample_type");
  const chosen = types.findIndex((entry) => defaultType !== 0 && entry.type === defaultType);
  const index = chosen === -1 ? types.length - 1 : chosen;
  const unit = unitOf(text(types[index]?.unit ?? 0, "unit"));

  // Each function's frame once, however many lines name it: its name as Go writes it.
  const frameOf = new Map<number, string>();
  for (let i = 0; i < functions.length; i += 2) {
    let id = 0;
    let name = 0;
    const fields = new Fields(data, functions[i] ?? 0, functions[i + 1] ?? 0);
    while (fields.next()) {
      if (fields.field === 1 || fields.field === 2) {
        fields.expect(VARINT);
        if (fields.field === 1) id = exact(fields.value, "a function id");
        else name = exact(fields.value, "a string index");
      }
    }
    if (id === 0) throw malformed("a function without an id");
    if (frameOf.has(id)) throw malformed(`function id ${id} repeats`);
    frameOf.set(id, text(name, "name of a function"));
  }

  // Each location's frames, the innermost first: an inlined call is a line before its caller's.
  const framesAt = new Map<number, readonly string[]>();
  let lines = 0;
  for (let i = 0; i < locations.length; i += 2) {
    let id = 0;
    let address = 0;
    const frames: string[] = [];
    const fields = new Fields(data, locations[i] ?? 0, locations[i + 1] ?? 0);
    while (fields.next()) {
      if (fields.field === 1) {
        fields.expect(VARINT);
        id = exact(fields.value, "a location id");
      } else if (fields.field === 3) {
        fields.expect(VARINT);
        address = fields.value;
      } else if (fields.field === 4) {
        fields.expect(BYTES);
        if (++lines > MAX_PPROF_ENTRIES)
          throw new Unreadable(`more than ${MAX_PPROF_ENTRIES} lines`);
        let fn = 0;
        const line = new Fields(data, fields.start, fields.end);
        while (line.next()) {
          if (line.field === 1) {
            line.expect(VARINT);
            fn = exact(line.value, "a function id");
          }
        }
        // Function id 0 is a line whose function is not known.
        const frame = fn === 0 ? "(unknown)" : frameOf.get(fn);
        if (frame === undefined)
          throw malformed(`a line names function ${fn}, which is not in function`);
        frames.push(frame);
      }
    }
    if (id === 0) throw malformed("a location without an id");
    if (framesAt.has(id)) throw malformed(`location id ${id} repeats`);
    // An unsymbolized location is its address.
    if (frames.length === 0) {
      frames.push(
        Number.isSafeInteger(address) && address > 0 ? `0x${address.toString(16)}` : "(unknown)",
      );
    }
    framesAt.set(id, frames);
  }

  const tally = new Tally();
  let walked = 0;
  for (let i = 0; i < samples.length; i += 2) {
    const ids: number[] = [];
    const values: number[] = [];
    const sample = i / 2;
    const fields = new Fields(data, samples[i] ?? 0, samples[i + 1] ?? 0);
    while (fields.next()) {
      // Each location is a frame at least.
      if (fields.field === 1) fields.integers(ids, MAX_PPROF_FRAMES - walked, tooManyFrames);
      else if (fields.field === 2) {
        fields.integers(values, types.length, () =>
          malformed(`sample ${sample} has more values than the ${types.length} sample types`),
        );
      }
    }
    if (values.length !== types.length) {
      throw malformed(
        `sample ${sample} has ${values.length} values for ${types.length} sample types`,
      );
    }
    // A negative int64 reads as a varint above 2^63, so out of range too.
    const weight = exact(values[index] ?? 0, `a value of sample ${sample}`);
    // The leaf is the first location; the stack is root first.
    const stack: string[] = [];
    for (let at = ids.length - 1; at >= 0; at--) {
      const frames = framesAt.get(ids[at] ?? 0);
      if (frames === undefined) {
        throw malformed(`sample ${sample} names location ${ids[at]}, which is not in location`);
      }
      walked += frames.length;
      if (walked > MAX_PPROF_FRAMES) throw tooManyFrames();
      for (let line = frames.length - 1; line >= 0; line--) stack.push(frames[line] ?? "");
    }
    if (weight > 0) tally.addSample(stack, weight);
  }
  return { valid: true, tally, unit };
}

/**
 * A pprof profile as Go's `runtime/pprof`, `go test -cpuprofile`, and `net/http/pprof` write it:
 * gzip-compressed (at most `MAX_PPROF_BYTES` once inflated) or not. Each sample's weight is its
 * value of the default sample type (`cpu`, in `nanoseconds`, for a Go CPU profile), the stack
 * its locations' functions with each inlined call a frame of its own. Every id a sample or line
 * names must be defined once; anything else makes the file invalid.
 */
export function parsePprof(bytes: Uint8Array): Parsed {
  let data = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      data = gunzipSync(bytes, { maxOutputLength: MAX_PPROF_BYTES });
    } catch (error) {
      return invalid(
        (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
          ? `decompresses to more than ${MAX_PPROF_BYTES / 1024 / 1024} MiB`
          : "not valid gzip",
      );
    }
  }
  try {
    return decode(data);
  } catch (error) {
    if (error instanceof Unreadable) return invalid(error.message);
    throw error;
  }
}
