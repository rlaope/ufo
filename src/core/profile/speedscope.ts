import { invalid, type Parsed, rawName, STACK_FRAMES, Tally } from "./summary.js";

const UNITS: ReadonlySet<string> = new Set([
  "none",
  "nanoseconds",
  "microseconds",
  "milliseconds",
  "seconds",
  "bytes",
]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** `name (file:line)`, as speedscope shows a frame. */
function frameOf(frame: Json): string | undefined {
  if (typeof frame.name !== "string") return undefined;
  const name = rawName(frame.name);
  if (typeof frame.file !== "string" || frame.file === "") return name;
  const line = typeof frame.line === "number" ? `:${frame.line}` : "";
  return `${name} (${rawName(frame.file)}${line})`;
}

/** A sampled profile: each stack, root first, with its weight. */
function addSampled(profile: Json, frames: readonly string[], tally: Tally): string | undefined {
  const { samples, weights } = profile;
  if (!Array.isArray(samples) || !Array.isArray(weights) || samples.length !== weights.length) {
    return "a sampled profile needs samples and weights of one length";
  }
  for (const [i, stack] of samples.entries()) {
    const weight = weights[i];
    if (!Array.isArray(stack) || !isWeight(weight)) return `sample ${i} is not a stack and weight`;
    const named: string[] = [];
    for (const index of stack) {
      const frame = typeof index === "number" ? frames[index] : undefined;
      if (frame === undefined) return `sample ${i} names no frame`;
      named.push(frame);
    }
    tally.addSample(named, weight);
  }
  return undefined;
}

/**
 * An evented profile: open and close events in order of `at`. Between two events the open
 * frames are the stack; a frame's total is the time it is open, once however often recursion
 * opens it again.
 */
function addEvented(profile: Json, frames: readonly string[], tally: Tally): string | undefined {
  const { events, endValue } = profile;
  if (!Array.isArray(events)) return "an evented profile needs events";
  const stack: string[] = [];
  // The stack as stacks show it, a frame reopened right inside itself once, and for each open
  // frame whether it was pushed there.
  const shown: string[] = [];
  const pushed: boolean[] = [];
  const open = new Map<string, { depth: number; since: number }>();
  let last: number | undefined;
  const advance = (to: number) => {
    const delta = to - (last ?? to);
    const leaf = stack.at(-1);
    if (delta > 0 && leaf !== undefined) {
      tally.weight += delta;
      tally.addSelf(leaf, delta);
      tally.addStack(shown.slice(-STACK_FRAMES), delta);
    }
    last = to;
  };
  const close = (frame: string, to: number) => {
    const entry = open.get(frame);
    if (entry === undefined) return;
    if (--entry.depth === 0) {
      tally.addTotal(frame, to - entry.since);
      open.delete(frame);
    }
  };
  for (const [i, event] of events.entries()) {
    if (!isObject(event) || typeof event.at !== "number" || !Number.isFinite(event.at)) {
      return `event ${i} has no time`;
    }
    const frame = typeof event.frame === "number" ? frames[event.frame] : undefined;
    if (frame === undefined) return `event ${i} names no frame`;
    if (last !== undefined && event.at < last) return `event ${i} is out of order`;
    advance(event.at);
    if (event.type === "O") {
      pushed.push(shown.at(-1) !== frame);
      if (pushed.at(-1) === true) shown.push(frame);
      stack.push(frame);
      const entry = open.get(frame);
      if (entry === undefined) open.set(frame, { depth: 1, since: event.at });
      else entry.depth++;
    } else if (event.type === "C") {
      if (stack.at(-1) !== frame) return `event ${i} closes a frame that is not the open one`;
      stack.pop();
      if (pushed.pop() === true) shown.pop();
      close(frame, event.at);
    } else {
      return `event ${i} is neither O nor C`;
    }
  }
  // Frames still open close at the profile's end.
  const end = Math.max(typeof endValue === "number" ? endValue : 0, last ?? 0);
  advance(end);
  for (const frame of stack.toReversed()) close(frame, end);
  return undefined;
}

/**
 * A speedscope file (https://www.speedscope.app/file-format-schema.json): `shared.frames` and
 * `profiles`, each `sampled` or `evented`. The profiles in the first one's unit are added up
 * (one per thread, as py-spy writes them); any in another unit are left out and counted.
 */
export function parseSpeedscope(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("not JSON");
  }
  if (!isObject(value) || !isObject(value.shared) || !Array.isArray(value.shared.frames)) {
    return invalid("no shared.frames: not a speedscope file");
  }
  const { profiles } = value;
  if (!Array.isArray(profiles) || profiles.length === 0) return invalid("no profiles");
  const frames: string[] = [];
  for (const [i, frame] of value.shared.frames.entries()) {
    const name = isObject(frame) ? frameOf(frame) : undefined;
    if (name === undefined) return invalid(`frame ${i} has no name`);
    frames.push(name);
  }
  if (!profiles.every(isObject)) return invalid("a profile is not an object");
  const unit = (profiles[0] as Json).unit;
  if (typeof unit !== "string" || !UNITS.has(unit)) return invalid("the first profile has no unit");
  const tally = new Tally();
  let skipped = 0;
  for (const [i, profile] of (profiles as Json[]).entries()) {
    if (profile.unit !== unit) {
      skipped++;
      continue;
    }
    const problem =
      profile.type === "sampled"
        ? addSampled(profile, frames, tally)
        : profile.type === "evented"
          ? addEvented(profile, frames, tally)
          : "its type is neither sampled nor evented";
    if (problem !== undefined) return invalid(`profile ${i}: ${problem}`);
  }
  return {
    valid: true,
    tally,
    unit,
    ...(skipped === 0
      ? {}
      : { note: `${skipped} of ${profiles.length} profiles are in another unit and left out` }),
  };
}
