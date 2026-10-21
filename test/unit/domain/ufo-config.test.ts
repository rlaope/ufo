import { describe, expect, it } from "vitest";
import { profiledSteps, UfoConfigSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, metric, ufoConfig } from "./fixtures.js";

describe("UfoConfigSchema", () => {
  it("accepts a valid config", () => {
    const parsed = expectAccepts(UfoConfigSchema, ufoConfig());
    expect(parsed.objective.budget).toEqual({ wallClockMinutes: 120, maxTechniques: 10 });
    expect(parsed.workload.command).toBe("k6 run --quiet load/startup.js");
  });

  it("accepts the minimal form and applies defaults", () => {
    const parsed = expectAccepts(UfoConfigSchema, {
      version: 1,
      objective: { primary: metric(), scenario: "startup" },
      workload: { command: "./bin/start-and-wait" },
    });
    expect(parsed.oracles).toEqual([]);
    expect(parsed.targets).toEqual([]);
    expect(parsed.cards).toEqual([]);
    expect(parsed.optIns).toEqual([]);
  });

  it("accepts every workload lifecycle step", () => {
    expectAccepts(UfoConfigSchema, {
      ...ufoConfig(),
      workload: {
        setup: "docker compose up -d db",
        start: "java -jar target/app.jar",
        healthcheck: "curl -fsS http://127.0.0.1:8080/health",
        warmup: "k6 run --quiet load/warmup.js",
        command: "k6 run --quiet load/measure.js",
        teardown: "docker compose down",
        reset: "psql -f load/reset.sql",
      },
    });
  });

  it("rejects an empty object", () => {
    expectRejects(UfoConfigSchema, {});
  });

  it.each(["version", "objective", "workload"] as const)("rejects a config missing %s", (field) => {
    const value: Record<string, unknown> = ufoConfig();
    delete value[field];
    expectRejects(UfoConfigSchema, value);
  });

  it.each([
    ["future version", { version: 2 }],
    ["string version", { version: "1" }],
    ["workload without a command", { workload: { start: "java -jar app.jar" } }],
    ["multi-line workload command", { workload: { command: "k6 run a.js\ncurl evil" } }],
    ["unknown workload step", { workload: { command: "k6 run a.js", deploy: "kubectl apply" } }],
    [
      "duplicate oracle names",
      {
        oracles: [
          { name: "tests", kind: "test_pass_set", command: "npm test" },
          { name: "tests", kind: "smoke", command: "npm run smoke" },
        ],
      },
    ],
    ["too many oracles", { oracles: manyOracles(17) }],
    ["duplicate card ids", { cards: ["jvm.heap-size", "jvm.heap-size"] }],
    ["too many cards", { cards: Array.from({ length: 257 }, (_, i) => `card-${i}`) }],
    ["bad card id", { cards: ["Heap Size"] }],
    ["bad opt-in", { optIns: ["everything"] }],
    ["bad target", { targets: ["0.0.0.0/-1"] }],
    ["top-level scenario", { scenario: "startup" }],
    ["top-level budget", { budget: { maxTechniques: 3 } }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(UfoConfigSchema, { ...ufoConfig(), ...patch });
  });
});

function manyOracles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `oracle-${i}`,
    kind: "smoke",
    command: "npm run smoke",
  }));
}

describe("UfoConfigSchema hygiene", () => {
  it("defaults to AC power and a 0.5 × cores load limit, and bounds the factor", () => {
    expect(UfoConfigSchema.parse(ufoConfig()).hygiene).toEqual({
      requireAcPower: true,
      maxLoadFactor: 0.5,
    });
    expect(
      UfoConfigSchema.parse({ ...ufoConfig(), hygiene: { maxLoadFactor: 2 } }).hygiene,
    ).toEqual({ requireAcPower: true, maxLoadFactor: 2 });
    for (const bad of [0, -1, 65]) {
      expect(
        UfoConfigSchema.safeParse({ ...ufoConfig(), hygiene: { maxLoadFactor: bad } }).success,
      ).toBe(false);
    }
  });
});

// M4 E1: workload.profile, which only profile_target uses.
describe("UfoConfigSchema workload.profile", () => {
  const withProfile = (profile: unknown, workload: Record<string, unknown> = {}) => ({
    ...ufoConfig(),
    workload: { ...ufoConfig().workload, ...workload, profile },
  });

  it("profiles start by default, else the command, and takes no variables unless listed", () => {
    const parsed = expectAccepts(UfoConfigSchema, withProfile({ format: "cpuprofile" }));
    expect(parsed.workload.profile).toEqual({ format: "cpuprofile" });
    expect(profiledSteps(parsed.workload)).toEqual(["start"]);
    expect(profiledSteps({ command: "node bench.mjs" })).toEqual(["command"]);
    const listed = expectAccepts(
      UfoConfigSchema,
      withProfile(
        {
          env: {
            NODE_OPTIONS: "--cpu-prof --cpu-prof-dir={{profile_dir}}",
            EMPTY: "",
            ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`V${i}`, "x"])),
          },
          steps: ["setup", "command"],
          format: "collapsed",
        },
        { setup: "npm run build" },
      ),
    );
    expect(profiledSteps(listed.workload)).toEqual(["setup", "command"]);
    expect(listed.workload.profile?.env?.NODE_OPTIONS).toBe(
      "--cpu-prof --cpu-prof-dir={{profile_dir}}",
    );
  });

  it("takes a preset with steps, the preset setting the variables and the format", () => {
    expect(
      expectAccepts(UfoConfigSchema, withProfile({ preset: "node-cpu" })).workload.profile,
    ).toEqual({ preset: "node-cpu" });
    expectAccepts(UfoConfigSchema, withProfile({ preset: "node-cpu", steps: ["command"] }));
  });

  it.each([
    ["no format", { env: {} }],
    ["an unknown format", { format: "pprof" }],
    ["an unknown preset", { preset: "jvm-cpu" }],
    ["a preset with variables", { preset: "node-cpu", env: { X: "y" } }],
    ["a preset with a format", { preset: "node-cpu", format: "cpuprofile" }],
    ["an unknown key", { format: "collapsed", output: "x" }],
    ["a step that cannot be profiled", { format: "collapsed", steps: ["teardown"] }],
    ["a step twice", { format: "collapsed", steps: ["start", "start"] }],
    ["no steps", { format: "collapsed", steps: [] }],
    ["a step the workload lacks", { format: "collapsed", steps: ["warmup"] }],
    [
      "more than 16 variables",
      {
        format: "collapsed",
        env: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`V${i}`, "x"])),
      },
    ],
    ["PATH", { format: "collapsed", env: { PATH: "/tmp" } }],
    ["HOME", { format: "collapsed", env: { HOME: "/tmp" } }],
    ["a UFO_ name", { format: "collapsed", env: { UFO_PROFILE_DIR: "/tmp" } }],
    ["a lowercase name", { format: "collapsed", env: { node_options: "--cpu-prof" } }],
    ["a name with a dash", { format: "collapsed", env: { "NODE-OPTIONS": "--cpu-prof" } }],
    ["a name starting with a digit", { format: "collapsed", env: { "1X": "y" } }],
    ["a multi-line value", { format: "collapsed", env: { X: "a\nb" } }],
    ["an invisible character", { format: "collapsed", env: { X: "a\u202eb" } }],
    ["a value over 4000 characters", { format: "collapsed", env: { X: "x".repeat(4001) } }],
    ["another placeholder", { format: "collapsed", env: { X: "{{run_dir}}/p" } }],
    ["a value that is no string", { format: "collapsed", env: { X: 1 } }],
  ])("rejects %s", (_label, profile) => {
    expectRejects(UfoConfigSchema, withProfile(profile));
  });
});
