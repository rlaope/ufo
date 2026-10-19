import { describe, expect, it } from "vitest";
import { UfoConfigSchema } from "../../../src/domain/index.js";
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
