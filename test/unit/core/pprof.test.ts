import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { indexEntries } from "../../../src/app/inspect.js";
import {
  type FileHotspots,
  hotFrames,
  MAX_PPROF_BYTES,
  MAX_PPROF_ENTRIES,
  MAX_PPROF_FRAMES,
  parsePprof,
  readProfileDir,
  summarizeProfile,
} from "../../../src/core/profile/index.js";
import type { StackId } from "../../../src/domain/index.js";
import { loadCatalog } from "../../../src/techniques/index.js";

// M5 V3: Go's pprof profile. `toy.pprof` is a real CPU profile from Go 1.27 (`go test -trimpath
// -bench . -cpuprofile`) of a benchmark that calls hotLoop, a loop around mix (inlined into it),
// and allocate, which formats integers into new strings; the shares below are those `go tool
// pprof -top` gives for the same file. The other profiles are protobuf built by hand.

const FIXTURE = fileURLToPath(new URL("../../fixtures/profiles/toy.pprof", import.meta.url));

function reasonOf(summary: FileHotspots): string {
  if (summary.valid) throw new Error(`${summary.file} is valid`);
  return summary.reason;
}

// A protobuf encoder, just enough for profile.proto.
const varint = (value: number | bigint): number[] => {
  // A negative int64 is its two's complement as 64 bits: ten bytes.
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes: number[] = [];
  do {
    const low = Number(n & 0x7fn);
    n >>= 7n;
    bytes.push(n > 0n ? low | 0x80 : low);
  } while (n > 0n);
  return bytes;
};
const num = (field: number, value: number | bigint) => [...varint(field * 8), ...varint(value)];
const msg = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];
const packed = (field: number, values: (number | bigint)[]) => msg(field, values.flatMap(varint));
const str = (text: string) => msg(6, [...Buffer.from(text)]);
const valueType = (type: number, unit: number) => msg(1, [...num(1, type), ...num(2, unit)]);
const fn = (id: number, name: number) => msg(5, [...num(1, id), ...num(2, name)]);
const line = (functionId: number) => msg(4, num(1, functionId));
const location = (id: number, ...functionIds: number[]) =>
  msg(4, [...num(1, id), ...functionIds.flatMap(line)]);
const sample = (locations: number[], values: (number | bigint)[]) =>
  msg(2, [...packed(1, locations), ...packed(2, values)]);
const bytes = (...parts: number[][]) => Buffer.from(parts.flat());

const STRINGS = ["", "samples", "count", "cpu", "nanoseconds", "main.main", "main.hot", "main.mix"];
const TABLES = [
  ...STRINGS.map(str),
  valueType(1, 2),
  valueType(3, 4),
  fn(1, 5),
  fn(2, 6),
  fn(3, 7),
  // main.mix inlined into main.hot: the innermost line first.
  location(10, 3, 2),
  location(20, 1),
];
/** main.main → main.hot → main.mix three times, main.main alone once; 10 ms of CPU each. */
const TOY = bytes(
  ...TABLES,
  sample([10, 20], [1, 10_000_000]),
  sample([10, 20], [1, 10_000_000]),
  sample([10, 20], [1, 10_000_000]),
  sample([20], [1, 10_000_000]),
);

describe("a Go CPU profile", () => {
  it("names the hot function, its inlined callee, and the allocator", () => {
    const summary = summarizeProfile("toy.pprof", readFileSync(FIXTURE), "pprof");
    if (!summary.valid) throw new Error(summary.reason);
    if (summary.kind !== "stacks") throw new Error("a bundle");
    expect(summary).toMatchObject({ file: "toy.pprof", unit: "nanoseconds", weight: 1.54e9 });
    expect(summary.self.slice(0, 2)).toEqual([
      { frame: "toyprof.mix", pct: 40.9 },
      { frame: "toyprof.hotLoop", pct: 15.6 },
    ]);
    expect(summary.total).toEqual(
      expect.arrayContaining([
        { frame: "toyprof.hotLoop", pct: 59.1 },
        { frame: "toyprof.mix", pct: 42.9 },
        { frame: "toyprof.allocate", pct: 25.3 },
        { frame: "runtime.mallocgc", pct: 6.5 },
      ]),
    );
    // mix is inlined into hotLoop: one location, two frames, the caller first.
    expect(summary.stacks[0]).toEqual({
      frames: [
        "testing.(*B).run1.func1",
        "testing.(*B).runN",
        "toyprof.BenchmarkWork",
        "toyprof.hotLoop",
        "toyprof.mix",
      ],
      pct: 40.9,
    });
  });

  it("is read from a profile directory as bytes, and ranks the Go allocation card", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ufo-pprof-"));
    try {
      cpSync(FIXTURE, path.join(dir, "cpu.pprof"));
      const read = await readProfileDir(dir, "pprof");
      expect(
        read.files.map((f) => [f.file, f.valid && f.kind === "stacks" && f.self[0]?.frame]),
      ).toEqual([["cpu.pprof", "toyprof.mix"]]);
      const catalog = [...(await loadCatalog()).cards.values()];
      const go = catalog.filter((card) => card.stacks.includes("go"));
      const { cards } = indexEntries(go, new Set(), new Set<StackId>(), hotFrames(read.files));
      expect(cards[0]).toMatchObject({
        id: "server.go-reduce-allocations",
        evidence: expect.arrayContaining([
          { hint: "runtime.mallocgc", frame: "runtime.mallocgc", share: 0.065, kind: "total" },
        ]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a hand-built pprof profile", () => {
  it("weighs by the last sample type and gives each inlined call a frame", () => {
    for (const file of [TOY, gzipSync(TOY)]) {
      expect(summarizeProfile("toy", file, "pprof")).toEqual({
        file: "toy",
        valid: true,
        kind: "stacks",
        unit: "nanoseconds",
        weight: 40_000_000,
        self: [
          { frame: "main.mix", pct: 75 },
          { frame: "main.main", pct: 25 },
        ],
        total: [
          { frame: "main.main", pct: 100 },
          { frame: "main.hot", pct: 75 },
          { frame: "main.mix", pct: 75 },
        ],
        stacks: [
          { frames: ["main.main", "main.hot", "main.mix"], pct: 75 },
          { frames: ["main.main"], pct: 25 },
        ],
      });
    }
  });

  it("follows default_sample_type, reads unpacked repeated fields, and skips other fields", () => {
    const file = bytes(
      ...TABLES,
      num(14, 1),
      // Mappings, labels, period, and comments are not read.
      msg(3, num(1, 1)),
      num(12, 10_000_000),
      // location_id and value one field each instead of packed.
      msg(2, [...num(1, 10), ...num(1, 20), ...num(2, 3), ...num(2, 1)]),
      sample([20], [1, 1]),
    );
    expect(summarizeProfile("default", file, "pprof")).toMatchObject({
      unit: "count",
      weight: 4,
      self: [
        { frame: "main.mix", pct: 75 },
        { frame: "main.main", pct: 25 },
      ],
    });
  });

  it("names an unsymbolized location by its address and leaves zero-weight samples out", () => {
    const file = bytes(
      ...TABLES,
      msg(4, [...num(1, 30), ...num(3, 0x4a2f)]),
      sample([30, 20], [1, 5]),
      sample([10, 20], [1, 0]),
      // No locations: weight without a frame.
      sample([], [1, 5]),
    );
    expect(summarizeProfile("addr", file, "pprof")).toMatchObject({
      weight: 10,
      self: [{ frame: "0x4a2f", pct: 50 }],
      total: [
        { frame: "0x4a2f", pct: 50 },
        { frame: "main.main", pct: 50 },
      ],
    });
  });

  it.each([
    ["an empty file", bytes(), 'string_table[0] is not ""'],
    ["text", Buffer.from("main;f 1\n"), "not a pprof profile"],
    ["gzip that is not", Buffer.from([0x1f, 0x8b, 1, 2, 3]), "not valid gzip"],
    ["gzip cut short", gzipSync(TOY).subarray(0, 40), "not valid gzip"],
    ["a truncated varint", bytes([0x08, 0x80]), "a varint runs past its message"],
    ["a varint of 11 bytes", bytes([0x08], Array(10).fill(0x80), [0x01]), "longer than 10 bytes"],
    ["a length past the end", bytes([0x12, 0x10, 0x08]), "a field runs past its message"],
    ["a field cut inside a sample", bytes(...TABLES, msg(2, [0x0a, 0x05, 0x01])), "runs past"],
    ["a group", bytes([0x0b]), "wire type 3"],
    ["field 0", bytes([0x00, 0x00]), "a field numbered 0"],
    ["a sample type as a varint", bytes(num(1, 3), ...STRINGS.map(str)), "field 1 has wire type 0"],
    ["no string table", bytes(valueType(0, 0)), 'string_table[0] is not ""'],
    ["a first string that is not empty", bytes(str("x")), 'string_table[0] is not ""'],
    ["no sample type", bytes(...STRINGS.map(str)), "no sample_type"],
    [
      "a unit not in the strings",
      bytes(str(""), valueType(1, 9)),
      "the unit is not in string_table",
    ],
    [
      "a function name not in the strings",
      bytes(...TABLES, fn(4, 99)),
      "the name of a function is not in string_table",
    ],
    ["a function without an id", bytes(...TABLES, msg(5, num(2, 5))), "a function without an id"],
    ["a function id twice", bytes(...TABLES, fn(3, 5)), "function id 3 repeats"],
    ["a location without an id", bytes(...TABLES, msg(4, line(1))), "a location without an id"],
    ["a location id twice", bytes(...TABLES, location(20, 2)), "location id 20 repeats"],
    [
      "a line naming no function",
      bytes(...TABLES, location(30, 9)),
      "a line names function 9, which is not in function",
    ],
    [
      "a sample naming no location",
      bytes(...TABLES, sample([10, 99], [1, 1])),
      "sample 0 names location 99, which is not in location",
    ],
    [
      "a sample with three values for two types",
      bytes(...TABLES, sample([10], [1, 2, 3])),
      "sample 0 has more values than the 2 sample types",
    ],
    [
      "a sample with one value for two types",
      bytes(...TABLES, sample([10], [1])),
      "sample 0 has 1 values for 2 sample types",
    ],
    [
      "a negative value",
      bytes(...TABLES, sample([10], [1, -1])),
      "a value of sample 0 is out of range",
    ],
    ["an id past 2^53", bytes(...TABLES, location(2 ** 60, 1)), "a location id is out of range"],
  ])("refuses %s", (_, file, reason) => {
    expect(reasonOf(summarizeProfile("bad", file, "pprof"))).toContain(reason);
  });
});

// Security review: a gzip bomb, a table of millions of tiny entries, and a location named a
// million times over each cost a bounded amount, refused rather than cut.
describe("pprof limits", () => {
  const MiB = MAX_PPROF_BYTES / 1024 / 1024;

  it(`inflates at most ${MiB} MiB`, () => {
    // Zeros compress about a thousand to one; inflated, a field numbered 0.
    const atCap = gzipSync(Buffer.alloc(MAX_PPROF_BYTES));
    expect(atCap.length).toBeLessThan(MAX_PPROF_BYTES / 500);
    expect(reasonOf(summarizeProfile("cap", atCap, "pprof"))).toContain("a field numbered 0");
    const bomb = gzipSync(Buffer.alloc(MAX_PPROF_BYTES + 1));
    expect(reasonOf(summarizeProfile("bomb", bomb, "pprof"))).toBe(
      `decompresses to more than ${MiB} MiB`,
    );
    expect(reasonOf(summarizeProfile("raw", Buffer.alloc(MAX_PPROF_BYTES + 1), "pprof"))).toBe(
      `larger than ${MiB} MiB`,
    );
  });

  it.each([
    ["samples", [0x12, 0x00]],
    ["strings", [0x32, 0x00]],
    ["functions", [0x2a, 0x00]],
    ["locations", [0x22, 0x00]],
    ["sample types", [0x0a, 0x00]],
  ])(`refuses more than ${MAX_PPROF_ENTRIES} %s`, (what, entry) => {
    const repeat = (count: number) => Buffer.from(Array(count).fill(entry).flat());
    expect(reasonOf(summarizeProfile("many", repeat(MAX_PPROF_ENTRIES + 1), "pprof"))).toBe(
      `more than ${MAX_PPROF_ENTRIES} ${what}`,
    );
    // At the cap the table is read, and the file fails on what else it lacks.
    expect(reasonOf(summarizeProfile("many", repeat(MAX_PPROF_ENTRIES), "pprof"))).not.toContain(
      "more than",
    );
  });

  it(`refuses more than ${MAX_PPROF_ENTRIES} lines`, () => {
    const lines = (count: number) =>
      bytes(...TABLES, msg(4, [...num(1, 30), ...Array(count).fill(line(1)).flat()]));
    expect(reasonOf(summarizeProfile("lines", lines(MAX_PPROF_ENTRIES - 2), "pprof"))).toBe(
      `more than ${MAX_PPROF_ENTRIES} lines`,
    );
  });

  it(`reads at most ${MAX_PPROF_FRAMES} frames over all stacks, quickly`, () => {
    // One location of 1000 frames, named once per sample: two bytes each.
    const deep = (samples: number, ...more: number[][]) =>
      bytes(
        ...TABLES,
        msg(4, [...num(1, 30), ...Array(1000).fill(line(2)).flat()]),
        ...Array(samples).fill(sample([30], [1, 1])),
        ...more,
      );
    const started = Date.now();
    const atCap = parsePprof(deep(MAX_PPROF_FRAMES / 1000));
    expect(Date.now() - started).toBeLessThan(10_000);
    if (!atCap.valid) throw new Error(atCap.reason);
    expect(atCap.tally.weight).toBe(MAX_PPROF_FRAMES / 1000);
    expect([...atCap.tally.total.keys()]).toEqual(["main.hot"]);
    // 1000 frames short of the cap, a sample of two such locations passes it.
    const over = deep(MAX_PPROF_FRAMES / 1000 - 1, sample([30, 30], [1, 1]));
    expect(reasonOf(summarizeProfile("deep", over, "pprof"))).toBe(
      `more than ${MAX_PPROF_FRAMES} frames over its samples`,
    );
  });

  it("refuses one sample naming more locations than the frame cap before holding them", () => {
    const count = MAX_PPROF_FRAMES + 1;
    // Location 99 is not defined: refused for their number before any is looked up.
    const ids = Buffer.concat([Buffer.from([0x0a, ...varint(count)]), Buffer.alloc(count, 99)]);
    const values = Buffer.from(packed(2, [1, 1]));
    const file = Buffer.concat([
      Buffer.from(TABLES.flat()),
      Buffer.from([0x12, ...varint(ids.length + values.length)]),
      ids,
      values,
    ]);
    const started = Date.now();
    expect(reasonOf(summarizeProfile("wide", file, "pprof"))).toBe(
      `more than ${MAX_PPROF_FRAMES} frames over its samples`,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
