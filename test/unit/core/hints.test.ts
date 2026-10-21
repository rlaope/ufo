import { describe, expect, it } from "vitest";
import {
  type HintedFile,
  hotFrames,
  MAX_EVIDENCE,
  matchHints,
} from "../../../src/core/profile/index.js";

// M5 V1: which of a card's frame hints a profile's top frames show, as plain substrings, at the
// share each hint needs.

function file(self: [string, number][], total: [string, number][] = []): HintedFile {
  return {
    valid: true,
    self: self.map(([frame, pct]) => ({ frame, pct })),
    total: total.map(([frame, pct]) => ({ frame, pct })),
  };
}

const hint = (match: string, minShare = 0.05) => ({ match, minShare });

describe("hot frames", () => {
  it("are every listed frame at the larger of its shares, across lists and files", () => {
    const frames = hotFrames([
      file(
        [["a", 12.5]],
        [
          ["a", 40],
          ["b", 7],
        ],
      ),
      { valid: false },
      file(
        [
          ["b", 9.1],
          ["a", 5],
        ],
        [["c", 100]],
      ),
    ]);
    expect(frames.map(({ frame, share, kind }) => ({ frame, share, kind }))).toEqual([
      { frame: "a", share: 0.4, kind: "total" },
      { frame: "b", share: 0.091, kind: "self" },
      { frame: "c", share: 1, kind: "total" },
    ]);
  });

  it("are compared with every / as . too", () => {
    const [frame] = hotFrames([file([["com/fasterxml/jackson/databind/ObjectMapper.<init>", 30]])]);
    expect(frame?.normalized).toBe("com.fasterxml.jackson.databind.ObjectMapper.<init>");
  });
});

describe("matching frame hints", () => {
  it("finds a JVM Class.method in async-profiler's slashed names and JFR's dotted ones", () => {
    const hints = [hint("databind.ObjectMapper.<init>")];
    for (const name of [
      "com/fasterxml/jackson/databind/ObjectMapper.<init>",
      "com.fasterxml.jackson.databind.ObjectMapper.<init>",
    ]) {
      expect(matchHints(hints, hotFrames([file([[name, 30]])]))).toEqual([
        { hint: "databind.ObjectMapper.<init>", frame: name, share: 0.3, kind: "self" },
      ]);
    }
  });

  it("finds a path hint in the frame as written", () => {
    const frames = hotFrames([file([["iterencode (json/encoder.py:261)", 20]])]);
    expect(matchHints([hint("json/encoder.py")], frames)).toHaveLength(1);
    expect(matchHints([hint("json.encoder.py")], frames)).toHaveLength(1);
  });

  it("is a case-sensitive substring, never a pattern", () => {
    const frames = hotFrames([file([["readFileSync (node:fs:441)", 30]])]);
    expect(matchHints([hint("readfilesync")], frames)).toEqual([]);
    expect(matchHints([hint("read.*Sync")], frames)).toEqual([]);
    expect(matchHints([hint("Sync (node:fs")], frames)).toHaveLength(1);
  });

  it("needs the hint's share, inclusive", () => {
    const frames = hotFrames([
      file([], [["DefaultListableBeanFactory.preInstantiateSingletons", 30]]),
    ]);
    const at = (minShare: number) =>
      matchHints([hint("preInstantiateSingletons", minShare)], frames).length;
    expect(at(0.3)).toBe(1);
    expect(at(0.301)).toBe(0);
    expect(at(0.05)).toBe(1);
  });

  it("keeps the largest shares, one entry per frame, at most three", () => {
    const frames = hotFrames([
      file(
        [
          ["runtime.mallocgc", 5],
          ["runtime.growslice", 25],
          ["runtime.makeslice", 9],
          ["runtime.newobject", 15],
          ["main.handler", 40],
        ],
        [["runtime.mallocgc", 35]],
      ),
    ]);
    const evidence = matchHints(
      [hint("runtime.mallocgc"), hint("runtime.growslice"), hint("runtime."), hint("newobject")],
      frames,
    );
    expect(evidence).toHaveLength(MAX_EVIDENCE);
    expect(evidence).toEqual([
      { hint: "runtime.mallocgc", frame: "runtime.mallocgc", share: 0.35, kind: "total" },
      { hint: "runtime.growslice", frame: "runtime.growslice", share: 0.25, kind: "self" },
      { hint: "runtime.", frame: "runtime.newobject", share: 0.15, kind: "self" },
    ]);
  });

  it("skips a hint whose share is not reached for a later one that is", () => {
    const frames = hotFrames([file([["java.lang.ClassLoader.defineClass1", 10]])]);
    expect(
      matchHints([hint("ClassLoader.defineClass1", 0.15), hint("defineClass1")], frames),
    ).toEqual([
      {
        hint: "defineClass1",
        frame: "java.lang.ClassLoader.defineClass1",
        share: 0.1,
        kind: "self",
      },
    ]);
  });
});
