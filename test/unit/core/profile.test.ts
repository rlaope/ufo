import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTextRedactor } from "../../../src/core/evidence/index.js";
import {
  type FileHotspots,
  heaviestFiles,
  MAX_COLLAPSED_LINES,
  MAX_CPUPROFILE_NODES,
  MAX_FILES_SUMMARIZED,
  MAX_NAME_BYTES,
  MAX_PROFILE_BYTES,
  MAX_PROFILE_FILES_READ,
  MAX_RAW_NAME,
  parseCollapsed,
  parseCpuprofile,
  parseSpeedscope,
  readProfileDir,
  STACK_FRAMES,
  summarizeProfile,
} from "../../../src/core/profile/index.js";

// M4 E2: hot spots from the three profile formats, on small hand-written files whose shares are
// worked out by hand.

const FIXTURES = fileURLToPath(new URL("../../fixtures/profiles", import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

function reasonOf(summary: FileHotspots): string {
  if (summary.valid) throw new Error(`${summary.file} is valid`);
  return summary.reason;
}

describe("collapsed stacks", () => {
  it("give self, total (recursion counted once), and stack shares", () => {
    expect(summarizeProfile("toy.collapsed", fixture("toy.collapsed"), "collapsed")).toEqual({
      file: "toy.collapsed",
      valid: true,
      kind: "stacks",
      unit: "samples",
      weight: 100,
      self: [
        { frame: "format", pct: 50 },
        { frame: "parse", pct: 40 },
        { frame: "idle", pct: 10 },
      ],
      // handle is on 90 of the samples, twice on 10 of them.
      total: [
        { frame: "main", pct: 100 },
        { frame: "handle", pct: 90 },
        { frame: "format", pct: 50 },
        { frame: "render", pct: 50 },
        { frame: "parse", pct: 40 },
        { frame: "idle", pct: 10 },
      ],
      // handle calling itself is shown once.
      stacks: [
        { frames: ["main", "handle", "render", "format"], pct: 50 },
        { frames: ["main", "handle", "parse"], pct: 40 },
        { frames: ["main", "idle"], pct: 10 },
      ],
    });
  });

  it(`show a stack by its ${STACK_FRAMES} leaf-most frames, a frame calling itself once`, () => {
    expect(summarizeProfile("deep", "a;b;c;c;c;d;e;f;f;g 1", "collapsed")).toMatchObject({
      stacks: [{ frames: ["c", "d", "e", "f", "g"], pct: 100 }],
    });
  });

  it("read the count after the last space, so frame names may hold spaces", () => {
    const text = 'process 42:"python app.py";handle (app.py:3) 2\r\n\nmain 2.5\n';
    expect(summarizeProfile("raw", text, "collapsed")).toMatchObject({
      valid: true,
      weight: 4.5,
      self: [
        { frame: "main", pct: 55.6 },
        { frame: "handle (app.py:3)", pct: 44.4 },
      ],
    });
  });

  it.each([
    ["a line without a count", "main;handle 3\nmain;handle\n", "line 2 is not"],
    ["a negative count", "main -3\n", "line 1 is not"],
    ["only a count", "12\n", "line 1 is not"],
    ["nothing", "\n\n", "the profile holds no samples"],
    ["only zero counts", "main 0\n", "the profile holds no samples"],
  ])("refuse %s, as that file's reason", (_label, text, reason) => {
    expect(reasonOf(summarizeProfile("bad", text, "collapsed"))).toContain(reason);
  });

  it(`refuse a file of more than ${MAX_COLLAPSED_LINES} stacks rather than cut it`, () => {
    const text = "main;f 1\n".repeat(MAX_COLLAPSED_LINES + 1);
    expect(reasonOf(summarizeProfile("big", text, "collapsed"))).toBe(
      `more than ${MAX_COLLAPSED_LINES} stacks`,
    );
    expect(summarizeProfile("fits", "main;f 1\n".repeat(1000), "collapsed").valid).toBe(true);
  });
});

describe("a V8 .cpuprofile", () => {
  it("weighs each sample until the next, the last until endTime, and walks the tree", () => {
    const summary = summarizeProfile("toy.cpuprofile", fixture("toy.cpuprofile"), "cpuprofile", [
      "file:///app/",
      "/app/",
    ]);
    expect(summary).toEqual({
      file: "toy.cpuprofile",
      valid: true,
      kind: "stacks",
      unit: "microseconds",
      weight: 100,
      idle: 10,
      self: [
        { frame: "parse (lib/parse.js:5)", pct: 70 },
        { frame: "handle (server.js:10)", pct: 20 },
        { frame: "(idle)", pct: 10 },
      ],
      // (root) is no frame; handle under handle counts once.
      total: [
        { frame: "handle (server.js:10)", pct: 90 },
        { frame: "main (server.js:1)", pct: 90 },
        { frame: "parse (lib/parse.js:5)", pct: 70 },
        { frame: "(idle)", pct: 10 },
      ],
      stacks: [
        {
          frames: ["main (server.js:1)", "handle (server.js:10)", "parse (lib/parse.js:5)"],
          pct: 70,
        },
        { frames: ["main (server.js:1)", "handle (server.js:10)"], pct: 20 },
        { frames: ["(idle)"], pct: 10 },
      ],
    });
  });

  it("keeps the absolute url without the arm's prefix, and reads a parent-linked tree", () => {
    const profile = JSON.parse(fixture("toy.cpuprofile")) as {
      nodes: { id: number; children?: number[]; parent?: number }[];
    };
    const parents = new Map<number, number>();
    for (const node of profile.nodes)
      for (const child of node.children ?? []) parents.set(child, node.id);
    for (const node of profile.nodes) {
      delete node.children;
      const parent = parents.get(node.id);
      if (parent !== undefined) node.parent = parent;
    }
    const summary = summarizeProfile("old", JSON.stringify(profile), "cpuprofile");
    expect(summary).toMatchObject({
      valid: true,
      weight: 100,
      self: [{ frame: "parse (file:///app/lib/parse.js:5)", pct: 70 }, {}, {}],
    });
  });

  it("keeps the clock where it was after a negative delta", () => {
    const profile = JSON.parse(fixture("toy.cpuprofile")) as { timeDeltas: number[] };
    profile.timeDeltas = [0, 20, 20, -5, 30];
    const summary = summarizeProfile("neg", JSON.stringify(profile), "cpuprofile");
    // Samples at 1000, 1020, 1040, 1040 (not 1035), and 1065; the end at 1100.
    expect(summary).toMatchObject({
      valid: true,
      weight: 100,
      self: [
        { frame: "parse (file:///app/lib/parse.js:5)", pct: 40 },
        { frame: "handle (file:///app/server.js:10)", pct: 35 },
        { frame: "(idle)", pct: 25 },
      ],
    });
  });

  it.each([
    ["text that is no JSON", "{nodes", "not JSON"],
    ["JSON without nodes", '{"samples":[]}', "no nodes"],
    [
      "no timeDeltas",
      '{"nodes":[{"id":1,"callFrame":{}}],"samples":[1],"startTime":0}',
      "no samples or timeDeltas",
    ],
    [
      "samples and deltas of different lengths",
      '{"nodes":[{"id":1,"callFrame":{}}],"samples":[1],"timeDeltas":[],"startTime":0}',
      "differ in length",
    ],
    [
      "a sample of no node",
      '{"nodes":[{"id":1,"callFrame":{}}],"samples":[9],"timeDeltas":[1],"startTime":0,"endTime":2}',
      "sample 0 names no node",
    ],
    [
      "a cycle",
      '{"nodes":[{"id":1,"callFrame":{},"children":[2]},{"id":2,"callFrame":{},"children":[3]},{"id":3,"callFrame":{},"children":[2]}],"samples":[1],"timeDeltas":[1],"startTime":0}',
      "the nodes do not form a tree",
    ],
    [
      "a cycle apart from the root",
      '{"nodes":[{"id":1,"callFrame":{}},{"id":2,"callFrame":{},"children":[3]},{"id":3,"callFrame":{},"children":[2]}],"samples":[1],"timeDeltas":[1],"startTime":0}',
      "the nodes do not form a tree",
    ],
    [
      // Visited twice, 4 and 7 make up for 5 and 6, which no walk from the root reaches.
      "a node of two parents",
      '{"nodes":[{"id":1,"callFrame":{},"children":[2,3]},{"id":2,"callFrame":{},"children":[4]},{"id":3,"callFrame":{},"children":[4]},{"id":4,"callFrame":{},"children":[7]},{"id":5,"callFrame":{},"children":[6]},{"id":6,"callFrame":{},"children":[5]},{"id":7,"callFrame":{}}],"samples":[7],"timeDeltas":[1],"startTime":0,"endTime":2}',
      "the nodes do not form a tree",
    ],
    [
      "a node of itself",
      '{"nodes":[{"id":1,"callFrame":{},"children":[1]}],"samples":[1],"timeDeltas":[1],"startTime":0}',
      "the nodes do not form a tree",
    ],
    [
      "two roots",
      '{"nodes":[{"id":1,"callFrame":{}},{"id":2,"callFrame":{}}],"samples":[1],"timeDeltas":[1],"startTime":0}',
      "the nodes do not form a tree",
    ],
    [
      "a repeated id",
      '{"nodes":[{"id":1,"callFrame":{}},{"id":1,"callFrame":{}}],"samples":[1],"timeDeltas":[1],"startTime":0}',
      "node id 1 repeats",
    ],
    [
      "no time at all",
      '{"nodes":[{"id":1,"callFrame":{}}],"samples":[1],"timeDeltas":[0],"startTime":0,"endTime":0}',
      "the profile holds no samples",
    ],
  ])("refuses %s, as that file's reason", (_label, text, reason) => {
    expect(reasonOf(summarizeProfile("bad", text, "cpuprofile"))).toContain(reason);
  });

  it(`refuses a tree of more than ${MAX_CPUPROFILE_NODES} nodes rather than cut it`, () => {
    const nodes = Array.from({ length: MAX_CPUPROFILE_NODES + 1 }, (_, i) => ({
      id: i + 1,
      callFrame: {},
    }));
    const text = JSON.stringify({ nodes, samples: [1], timeDeltas: [1], startTime: 0 });
    expect(reasonOf(summarizeProfile("big", text, "cpuprofile"))).toBe(
      `more than ${MAX_CPUPROFILE_NODES} nodes`,
    );
  });

  it("walks a deep recursion without the call stack", () => {
    const depth = 50_000;
    const nodes = [
      { id: 1, callFrame: { functionName: "(root)" }, children: [2] },
      ...Array.from({ length: depth }, (_, i) => ({
        id: i + 2,
        callFrame: { functionName: "recurse", url: "file:///app/r.js", lineNumber: 0 },
        ...(i + 1 < depth ? { children: [i + 3] } : {}),
      })),
    ];
    const text = JSON.stringify({
      nodes,
      samples: [depth + 1],
      timeDeltas: [0],
      startTime: 0,
      endTime: 10,
    });
    expect(summarizeProfile("deep", text, "cpuprofile")).toMatchObject({
      valid: true,
      self: [{ frame: "recurse (file:///app/r.js:1)", pct: 100 }],
      total: [{ frame: "recurse (file:///app/r.js:1)", pct: 100 }],
      stacks: [{ frames: ["recurse (file:///app/r.js:1)"], pct: 100 }],
    });
  });
});

describe("a speedscope file", () => {
  it("adds up a sampled profile's weighted stacks, root first", () => {
    expect(summarizeProfile("s.json", fixture("sampled.speedscope.json"), "speedscope")).toEqual({
      file: "s.json",
      valid: true,
      kind: "stacks",
      unit: "seconds",
      weight: 14,
      self: [
        { frame: "b (app/b.py:12)", pct: 35.7 },
        { frame: "c", pct: 35.7 },
        { frame: "d", pct: 28.6 },
      ],
      total: [
        { frame: "a", pct: 100 },
        { frame: "b (app/b.py:12)", pct: 100 },
        { frame: "c", pct: 35.7 },
        { frame: "d", pct: 28.6 },
      ],
      stacks: [
        { frames: ["a", "b (app/b.py:12)"], pct: 35.7 },
        { frames: ["a", "b (app/b.py:12)", "c"], pct: 35.7 },
        { frames: ["a", "b (app/b.py:12)", "d"], pct: 28.6 },
      ],
    });
  });

  it("times an evented profile between events, a reopened frame once", () => {
    expect(summarizeProfile("e.json", fixture("evented.speedscope.json"), "speedscope")).toEqual({
      file: "e.json",
      valid: true,
      kind: "stacks",
      unit: "milliseconds",
      weight: 14,
      self: [
        { frame: "b", pct: 42.9 },
        { frame: "a", pct: 28.6 },
        { frame: "c", pct: 28.6 },
      ],
      // b is open from 0 to 10, twice from 6 to 9.
      total: [
        { frame: "a", pct: 100 },
        { frame: "b", pct: 71.4 },
        { frame: "c", pct: 28.6 },
      ],
      stacks: [
        { frames: ["a", "b"], pct: 42.9 },
        { frames: ["a"], pct: 28.6 },
        { frames: ["a", "b", "c"], pct: 28.6 },
      ],
    });
  });

  it("closes what is still open at endValue, and leaves out profiles in another unit", () => {
    const file = JSON.parse(fixture("evented.speedscope.json")) as {
      profiles: { events: unknown[]; unit: string; endValue: number }[];
    };
    const [main] = file.profiles;
    if (main === undefined) throw new Error("no profile");
    main.events = main.events.slice(0, 3);
    main.endValue = 10;
    file.profiles.push({ ...main, unit: "bytes" });
    const summary = summarizeProfile("open.json", JSON.stringify(file), "speedscope");
    expect(summary).toMatchObject({
      valid: true,
      weight: 10,
      self: [
        { frame: "c", pct: 80 },
        { frame: "b", pct: 20 },
      ],
      total: [
        { frame: "a", pct: 100 },
        { frame: "b", pct: 100 },
        { frame: "c", pct: 80 },
      ],
      note: "1 of 2 profiles are in another unit and left out",
    });
  });

  it.each([
    ["text that is no JSON", "[", "not JSON"],
    ["no shared frames", '{"profiles":[]}', "no shared.frames"],
    ["no profiles", '{"shared":{"frames":[]},"profiles":[]}', "no profiles"],
    [
      "an unknown unit",
      '{"shared":{"frames":[]},"profiles":[{"type":"sampled","unit":"parsecs","samples":[],"weights":[]}]}',
      "has no unit",
    ],
    [
      "an unknown profile type",
      '{"shared":{"frames":[]},"profiles":[{"type":"traced","unit":"none"}]}',
      "neither sampled nor evented",
    ],
    [
      "a frame without a name",
      '{"shared":{"frames":[{"file":"x"}]},"profiles":[{"type":"sampled","unit":"none","samples":[],"weights":[]}]}',
      "frame 0 has no name",
    ],
    [
      "samples and weights of different lengths",
      '{"shared":{"frames":[{"name":"a"}]},"profiles":[{"type":"sampled","unit":"none","samples":[[0]],"weights":[]}]}',
      "of one length",
    ],
    [
      "a sample of no frame",
      '{"shared":{"frames":[{"name":"a"}]},"profiles":[{"type":"sampled","unit":"none","samples":[[3]],"weights":[1]}]}',
      "sample 0 names no frame",
    ],
    [
      "a negative weight",
      '{"shared":{"frames":[{"name":"a"}]},"profiles":[{"type":"sampled","unit":"none","samples":[[0]],"weights":[-1]}]}',
      "sample 0 is not a stack and weight",
    ],
    [
      "events out of order",
      '{"shared":{"frames":[{"name":"a"}]},"profiles":[{"type":"evented","unit":"none","endValue":5,"events":[{"type":"O","frame":0,"at":3},{"type":"C","frame":0,"at":1}]}]}',
      "event 1 is out of order",
    ],
    [
      "a close of another frame",
      '{"shared":{"frames":[{"name":"a"},{"name":"b"}]},"profiles":[{"type":"evented","unit":"none","endValue":5,"events":[{"type":"O","frame":0,"at":0},{"type":"C","frame":1,"at":1}]}]}',
      "closes a frame that is not the open one",
    ],
  ])("refuses %s, as that file's reason", (_label, text, reason) => {
    expect(reasonOf(summarizeProfile("bad", text, "speedscope"))).toContain(reason);
  });
});

describe("a frame name", () => {
  it(`is one line of at most ${MAX_NAME_BYTES} bytes of JSON, keeping its start and its end`, () => {
    const long = `com/example/Start.${"x".repeat(5000)}.end (Handler.java:42)`;
    const text = [
      `main;${long} 3`,
      `main;語${"語".repeat(400)}末 2`,
      `main;${'"'.repeat(300)} 1`,
      "main;a\u0007b\u001bc\ud800 1",
    ].join("\n");
    const summary = summarizeProfile("names", text, "collapsed");
    if (!summary.valid) throw new Error(summary.reason);
    if (summary.kind !== "stacks") throw new Error("a bundle");
    const names = summary.self.map((s) => s.frame);
    for (const name of names) expect(jsonBytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(names[0]).toMatch(/^com\/example\/Start\.x+…x+\.end \(Handler\.java:42\)$/);
    expect(names[1]).toMatch(/^語+…語+末$/);
    expect(names[2]).toMatch(/^"+…"+$/);
    expect(names[3]).toBe("a b c�");
    // A short name stays whole.
    expect(summarizeProfile("short", "main;f 1", "collapsed")).toMatchObject({
      self: [{ frame: "f" }],
    });
  });
});

// Security review: a secret is replaced whole before a long name is cut, since a cut one (the
// tail of a credential URL or a key) no longer matches what finds it.
// Security review: a speedscope frame is referenced by index, one byte a reference however long
// its name, so names are cut where they are read and stacks are keyed by number.
describe("long frame names", () => {
  it("cost no more per sample than short ones", () => {
    const frames = Array.from({ length: 20 }, (_, i) => ({
      name: `f${i}${"n".repeat(1_000_000)}`,
    }));
    const samples = Array.from({ length: 1000 }, (_, i) =>
      Array.from({ length: 5 }, (_, d) => (i + d) % 20),
    );
    const text = JSON.stringify({
      shared: { frames },
      profiles: [{ type: "sampled", unit: "none", samples, weights: samples.map(() => 1) }],
    });
    const started = Date.now();
    const parsed = parseSpeedscope(text);
    expect(Date.now() - started).toBeLessThan(5000);
    if (!parsed.valid) throw new Error(parsed.reason);
    expect(Math.max(...[...parsed.tally.self.keys()].map((k) => k.length))).toBeLessThanOrEqual(
      MAX_RAW_NAME,
    );
    expect(Math.max(...[...parsed.tally.stacks.keys()].map((k) => k.length))).toBeLessThan(64);
  });

  it("are cut where they are read in every format, keeping both ends", () => {
    const long = `start${"m".repeat(5000)}end`;
    const collapsed = parseCollapsed(`main;${long} 1`);
    const cpuprofile = parseCpuprofile(
      JSON.stringify({
        nodes: [
          { id: 1, callFrame: { functionName: "(root)" }, children: [2] },
          { id: 2, callFrame: { functionName: long, url: `file:///${long}.js`, lineNumber: 0 } },
        ],
        samples: [2],
        timeDeltas: [0],
        startTime: 0,
        endTime: 1,
      }),
    );
    const speedscope = parseSpeedscope(
      JSON.stringify({
        shared: { frames: [{ name: long, file: long }] },
        profiles: [{ type: "sampled", unit: "none", samples: [[0]], weights: [1] }],
      }),
    );
    for (const parsed of [collapsed, cpuprofile, speedscope]) {
      if (!parsed.valid) throw new Error(parsed.reason);
      for (const frame of parsed.tally.self.keys()) {
        expect(frame.length).toBeLessThanOrEqual(2 * MAX_RAW_NAME + 20);
        expect(frame.startsWith("start")).toBe(true);
        expect(frame).toMatch(/end(?: \(.*end(?:\.js:1)?\))?$/);
      }
    }
  });
});

describe("a name with a secret in it", () => {
  const PASSWORD = "Sup3rS3cretPassw0rd1234";
  const KEY = `sk-ant-${"A1b2C3d4".repeat(8)}`;
  const ENV_SECRET = "hunter2-but-longer-9f8e7d";
  const leaks = (text: string) =>
    [PASSWORD, KEY, ENV_SECRET].some((secret) =>
      // Any 8 characters of a secret in a row.
      Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((part) =>
        text.includes(part),
      ),
    );

  it("is redacted before it is cut, in frames and in the file name", () => {
    const pad = "x".repeat(120);
    const text = [
      `process 42:"python app.py --dsn postgres://app:${PASSWORD}@db.internal:5432/app ${pad}";handle 3`,
      `main;run --api-key=${KEY} ${pad} 2`,
      `main;connect (${pad} ${ENV_SECRET} ${pad}) 1`,
    ].join("\n");
    const redact = createTextRedactor({ env: { DB_PASSWORD: ENV_SECRET } });
    const summary = summarizeProfile(
      `prof-postgres://app:${PASSWORD}@db.internal-${pad}.collapsed`,
      text,
      "collapsed",
      [],
      redact,
    );
    const shown = JSON.stringify(summary);
    expect(leaks(shown)).toBe(false);
    expect(shown).toContain("<redacted:");
    // Unredacted, the cut names do show part of each.
    expect(leaks(JSON.stringify(summarizeProfile("f", text, "collapsed")))).toBe(true);
  });

  it("is redacted when read from a profile directory, by default", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ufo-profile-"));
    try {
      writeFileSync(
        path.join(dir, "p.collapsed"),
        `main;run --api-key=${KEY} ${"y".repeat(120)} 2\n`,
      );
      expect(leaks(JSON.stringify(await readProfileDir(dir, "collapsed")))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("several profile files", () => {
  const valid = (file: string, weight: number): FileHotspots => ({
    file,
    valid: true,
    kind: "stacks",
    unit: "samples",
    weight,
    self: [],
    total: [],
    stacks: [],
  });

  it(`keep the ${MAX_FILES_SUMMARIZED} heaviest, then the unreadable, and count the rest`, () => {
    const files = [
      valid("p1", 5),
      { file: "bad", valid: false as const, reason: "not JSON" },
      valid("p2", 50),
      valid("p3", 20),
      valid("p4", 40),
      valid("p5", 10),
    ];
    expect(heaviestFiles(files, 2)).toEqual({
      files: [valid("p2", 50), valid("p4", 40), valid("p3", 20), valid("p5", 10)],
      omitted: 4,
    });
    expect(heaviestFiles(files.slice(0, 2)).files.map((f) => f.file)).toEqual(["p1", "bad"]);
  });

  it("put a process that mostly waited (a wrapper) below the one that worked", () => {
    const wrapper = { ...valid("wrapper", 1000), idle: 990 };
    expect(heaviestFiles([wrapper, valid("app", 600)]).files.map((f) => f.file)).toEqual([
      "app",
      "wrapper",
    ]);
  });
});

describe("reading a profile directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ufo-profile-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads regular files only, never through a symlink, and none past the size cap", async () => {
    cpSync(path.join(FIXTURES, "toy.collapsed"), path.join(dir, "one.collapsed"));
    writeFileSync(path.join(dir, "two.collapsed"), "main;work 300\n");
    writeFileSync(path.join(dir, "broken.collapsed"), "main;work\n");
    symlinkSync(path.join(FIXTURES, "toy.collapsed"), path.join(dir, "link.collapsed"));
    mkdirSync(path.join(dir, "sub"));
    // Sparse: the size counts, nothing is written or read.
    writeFileSync(path.join(dir, "huge.collapsed"), "");
    truncateSync(path.join(dir, "huge.collapsed"), MAX_PROFILE_BYTES + 1);
    const read = await readProfileDir(dir, "collapsed");
    expect(
      read.files.map((f) => [
        f.file,
        !f.valid ? f.reason : f.kind === "stacks" ? f.weight : f.bytes,
      ]),
    ).toEqual([
      ["two.collapsed", 300],
      ["one.collapsed", 100],
      ["broken.collapsed", "line 1 is not `frame;frame;... count`"],
      ["huge.collapsed", `larger than ${MAX_PROFILE_BYTES / 1024 / 1024} MiB`],
    ]);
    expect(read.omitted).toBe(2);
    rmSync(path.join(dir, "two.collapsed"));
    rmSync(path.join(dir, "one.collapsed"));
    expect(
      (await readProfileDir(dir, "collapsed")).files.map((f) => [f.file, f.valid ? "" : f.reason]),
    ).toEqual([
      ["broken.collapsed", "line 1 is not `frame;frame;... count`"],
      ["huge.collapsed", `larger than ${MAX_PROFILE_BYTES / 1024 / 1024} MiB`],
      ["link.collapsed", "a symbolic link; UFO does not follow it"],
      ["sub", "not a regular file"],
    ]);
  });

  it(`reads at most ${MAX_PROFILE_FILES_READ} files, the largest first, and counts the others`, async () => {
    // Each file larger and lighter than the one before.
    const count = MAX_PROFILE_FILES_READ + 4;
    for (let i = 0; i < count; i++) {
      writeFileSync(
        path.join(dir, `p${String(i).padStart(2, "0")}`),
        `main;${"f".repeat(2 * i)} ${100 - i}\n`,
      );
    }
    const read = await readProfileDir(dir, "collapsed");
    // p00 to p03, the heaviest and smallest, are never read.
    expect(read.files.map((f) => f.file)).toEqual(["p04", "p05", "p06", "p07"]);
    expect(read.omitted).toBe(count - MAX_FILES_SUMMARIZED);
  });

  it("reports a FIFO without opening it, which would wait for a writer forever", async () => {
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    writeFileSync(path.join(dir, "p.collapsed"), "main;f 1\n");
    const read = await readProfileDir(dir, "collapsed");
    expect(
      read.files.map((f) => [
        f.file,
        !f.valid ? f.reason : f.kind === "stacks" ? f.weight : f.bytes,
      ]),
    ).toEqual([
      ["p.collapsed", 1],
      ["pipe", "not a regular file"],
    ]);
  }, 5000);

  it("holds no files when the workload removed the directory, and refuses a symlink for it", async () => {
    expect(await readProfileDir(path.join(dir, "gone"), "collapsed")).toEqual({
      files: [],
      omitted: 0,
    });
    mkdirSync(path.join(dir, "elsewhere"));
    symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "planted"));
    await expect(readProfileDir(path.join(dir, "planted"), "collapsed")).rejects.toMatchObject({
      code: "unsafe_state",
    });
  });
});
