import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type FileHotspots,
  JFR_LIMITS,
  JFR_STACK_DEPTH,
  JfrReader,
  MAX_RAW_NAME,
  parseJfrJson,
  summarize,
  summarizeProfile,
} from "../../../src/core/profile/index.js";

// M6: `jfr print --json` output. `hot.jfr.json` is written by hand in the shape the JDK's
// JSONWriter prints (jdk.jfr.internal.tool.JSONWriter, JDK 17 and 21): pretty-printed, `/`
// escaped as `\/`, class names as the recording stores them (`com/fasterxml/...`), frames
// innermost first, nested class loaders, and an event of another type.

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../../fixtures/profiles/hot.jfr.json", import.meta.url)),
  "utf8",
);

function reasonOf(summary: FileHotspots): string {
  if (summary.valid) throw new Error(`${summary.file} is valid`);
  return summary.reason;
}

function stacksOf(summary: FileHotspots) {
  if (!summary.valid || summary.kind !== "stacks") throw new Error(`${summary.file} has no stacks`);
  return summary;
}

/** One event as JSONWriter prints it, its frames innermost first. */
function event(frames: readonly string[], extra: { type?: string; truncated?: boolean } = {}) {
  const frame = (name: string) => {
    const dot = name.lastIndexOf(".");
    const type = name.slice(0, dot).replaceAll(".", "\\/");
    return `{"method": {"type": {"classLoader": null, "name": "${type}", "package": null}, "name": "${name.slice(dot + 1)}", "descriptor": "()V"}, "lineNumber": 1, "type": "Interpreted"}`;
  };
  return `{"type": "${extra.type ?? "jdk.ExecutionSample"}", "values": {"startTime": "2026-10-22T14:00:00Z", "state": "STATE_RUNNABLE", "stackTrace": {"truncated": ${extra.truncated ?? false}, "frames": [${frames.map(frame).join(", ")}]}}}`;
}

function recording(events: readonly string[]): string {
  return `{\n  "recording": {\n    "events": [${events.join(", ")}]\n  }\n}\n`;
}

describe("jfr print --json", () => {
  it("counts each execution sample once, names frames Class.method with dots, leaf first in JFR", () => {
    const summary = stacksOf(summarizeProfile("hot.jfr", FIXTURE, "jfr"));
    expect(summary).toMatchObject({ unit: "samples", weight: 3 });
    expect(summary.self).toEqual([
      { frame: "Hot.spin", pct: 66.7 },
      { frame: "com.fasterxml.jackson.databind.ObjectMapper.<init>", pct: 33.3 },
    ]);
    expect(summary.total).toEqual([
      { frame: "Hot.main", pct: 100 },
      { frame: "Hot.parentWork", pct: 66.7 },
      { frame: "Hot.spin", pct: 66.7 },
      { frame: "com.fasterxml.jackson.databind.ObjectMapper.<init>", pct: 33.3 },
    ]);
    expect(summary.stacks[0]).toEqual({
      frames: ["Hot.main", "Hot.parentWork", "Hot.spin"],
      pct: 66.7,
    });
    expect(summary).not.toHaveProperty("note");
  });

  it("reads the output the same however it is split into chunks", () => {
    const whole = summarizeProfile("hot.jfr", FIXTURE, "jfr");
    const bytes = Buffer.from(FIXTURE);
    for (const size of [1, 7, 64, 4096]) {
      const reader = new JfrReader();
      for (let at = 0; at < bytes.length; at += size) {
        expect(reader.push(bytes.subarray(at, at + size))).toBe(true);
      }
      expect(summarize("hot.jfr", reader.finish())).toEqual(whole);
    }
  });

  it("notes stacks JFR cut, cuts longer ones itself, and leaves out samples without a stack", () => {
    const deep = Array.from({ length: JFR_STACK_DEPTH + 6 }, (_, i) => `app.Deep.f${i}`);
    const text = recording([
      event(["app.A.leaf", "app.A.main"], { truncated: true }),
      event(deep),
      '{"type": "jdk.ExecutionSample", "values": {"stackTrace": null}}',
    ]);
    const summary = stacksOf(summarizeProfile("x.jfr", text, "jfr"));
    expect(summary.weight).toBe(2);
    expect(summary.note).toBe(
      `2 of 2 samples have more than ${JFR_STACK_DEPTH} frames, their outermost ones left out of total shares; 1 samples without a stack are left out`,
    );
    // The innermost 64 are kept: f0 is the leaf, f63 the outermost kept.
    expect(summary.self.map((share) => share.frame)).toContain("app.Deep.f0");
    const parsed = parseJfrJson(text);
    if (!parsed.valid) throw new Error(parsed.reason);
    expect(parsed.tally.total.has(`app.Deep.f${JFR_STACK_DEPTH - 1}`)).toBe(true);
    expect(parsed.tally.total.has(`app.Deep.f${JFR_STACK_DEPTH}`)).toBe(false);
  });

  it("cuts a long name where it reads it", () => {
    const long = `app.${"x".repeat(3000)}.run`;
    const parsed = parseJfrJson(recording([event([long])]));
    if (!parsed.valid) throw new Error(parsed.reason);
    const [name] = [...parsed.tally.self.keys()];
    expect(name?.length).toBe(MAX_RAW_NAME);
  });

  it("stops at the sample limit and says so", () => {
    const events = Array.from({ length: 5 }, () => event(["app.A.run"]));
    const limits = { ...JFR_LIMITS, samples: 3 };
    const reader = new JfrReader(limits);
    expect(reader.push(Buffer.from(recording(events)))).toBe(false);
    const summary = stacksOf(summarize("x.jfr", reader.finish()));
    expect(summary.weight).toBe(3);
    expect(summary.note).toBe("more than 3 samples: the first 3 samples are counted");
    // Exactly at the limit, nothing is left out.
    const exact = stacksOf(summarize("x.jfr", parseJfrJson(recording(events.slice(0, 3)), limits)));
    expect(exact.weight).toBe(3);
    expect(exact).not.toHaveProperty("note");
  });

  it("stops at the output limit, keeping the samples before it", () => {
    const one = event(["app.A.run"]);
    const text = recording(Array.from({ length: 10 }, () => one));
    const limits = { ...JFR_LIMITS, outputBytes: text.indexOf(one) + 3 * (one.length + 2) };
    const reader = new JfrReader(limits);
    expect(reader.push(Buffer.from(text))).toBe(false);
    expect(reader.push(Buffer.from(text))).toBe(false);
    const summary = stacksOf(summarize("x.jfr", reader.finish()));
    expect(summary.weight).toBe(3);
    expect(summary.note).toMatch(/^jfr print wrote more than [\d.]+ MiB: the first 3 samples/);
  });

  it("refuses an event larger than its limit", () => {
    const text = recording([event(["app.A.run"]), event(["app.B.run"])]);
    const limits = { ...JFR_LIMITS, eventBytes: event(["app.A.run"]).length - 1 };
    expect(reasonOf(summarize("x.jfr", parseJfrJson(text, limits)))).toBe(
      `an event is larger than ${limits.eventBytes / 1024 / 1024} MiB`,
    );
  });

  it.each([
    ["not JSON", "jfr: file not found", "not JSON: not jfr print --json output"],
    ["cut short", FIXTURE.slice(0, FIXTURE.length / 2), "the jfr print output ends before"],
    ["an event that does not parse", recording(["{oops}"]), "not JSON: an event does not parse"],
    ["a bracket that closes nothing", "{}}", "not JSON: a bracket closes nothing"],
    [
      "no execution samples",
      recording([event(["app.A.run"], { type: "jdk.ThreadSleep" })]),
      "the recording holds no jdk.ExecutionSample events",
    ],
    ["two documents", `${recording([])}{}`, "more than one JSON document"],
  ])("reports %s with its reason", (_, text, reason) => {
    expect(reasonOf(summarizeProfile("x.jfr", text, "jfr"))).toContain(reason);
  });
});
