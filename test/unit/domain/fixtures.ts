import { expect } from "vitest";
import type { z } from "zod";
import type {
  ChangeSchema,
  DecisionSchema,
  EvidenceBundleSchema,
  MachineFingerprintSchema,
  MetricSchema,
  ObjectiveSchema,
  OracleResultSchema,
  PolicySchema,
  SampleSchema,
  TechniqueCardSchema,
  UfoConfigSchema,
} from "../../../src/domain/index.js";

export const SHA_A = "0123456789abcdef0123456789abcdef01234567";
export const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";
export const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const CHANGE_ID = "3f2b8c1e-5d4a-4b6f-9e7d-1a2b3c4d5e6f";
export const OTHER_CHANGE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const DIFF = [
  "diff --git a/src/server.ts b/src/server.ts",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -1,3 +1,2 @@",
  "-await sleep(5);",
  " respond();",
  "",
].join("\n");

/** Asserts that `schema` accepts `value` and returns the parsed output. */
export function expectAccepts<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  expect(result.error?.issues ?? []).toEqual([]);
  return result.data as z.output<T>;
}

export function expectRejects(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

export function metric(): z.input<typeof MetricSchema> {
  return {
    name: "startup_ms",
    unit: "ms",
    direction: "lower_is_better",
    kind: "stochastic",
    replicationUnit: "process_launch",
  };
}

export function objective(): z.input<typeof ObjectiveSchema> {
  return {
    primary: metric(),
    scenario: "process launch until the first 200 on /actuator/health",
    guardrails: [{ kind: "error_rate" }, { kind: "memory", maxRatio: 1.5 }],
    reportedOnly: [
      {
        name: "first_request_ms",
        unit: "ms",
        direction: "lower_is_better",
        kind: "stochastic",
        replicationUnit: "process_launch",
      },
    ],
  };
}

export function techniqueCard(): z.input<typeof TechniqueCardSchema> {
  return {
    id: "jvm.heap-size",
    domain: "server-jvm",
    title: "Size the heap for the workload",
    kind: "recipe",
    riskClass: "lossless",
    bottlenecks: ["allocation"],
    params: [{ name: "heap_mb", type: "integer", min: 256, max: 16384, default: 1024 }],
    commandTemplates: [
      { id: "launch", run: "java -Xmx{{heap_mb}}m -jar target/app.jar", params: ["heap_mb"] },
    ],
    signals: ["GC pauses above 10% of wall time in the profile"],
    sources: ["https://docs.oracle.com/en/java/javase/21/gctuning/"],
    verifiedIn: "unverified",
  };
}

export function change(): z.input<typeof ChangeSchema> {
  return {
    changeId: CHANGE_ID,
    baseSha: SHA_A,
    cardId: "jvm.heap-size",
    diff: DIFF,
    hypothesis: "The handler sleeps 5 ms per request.\nRemoving the sleep lowers latency.",
    evidenceRefs: ["profile/flame-001.html"],
  };
}

export function keepDecision(): z.input<typeof DecisionSchema> {
  return {
    changeId: CHANGE_ID,
    outcome: "keep",
    effect: 0.12,
    pairs: [
      { a: 100, b: 88 },
      { a: 101, b: 89 },
      { a: 99, b: 87 },
      { a: 100, b: 90 },
      { a: 102, b: 88 },
    ],
  };
}

export function sample(): z.input<typeof SampleSchema> {
  return {
    phase: "change",
    changeId: CHANGE_ID,
    arm: "b",
    sha: SHA_B,
    index: 3,
    metric: "startup_ms",
    value: 1620,
    secondary: { rss_bytes: 314572800, error_rate: 0 },
    startedAt: "2026-10-17T09:30:00Z",
    durationMs: 1700,
    valid: true,
  };
}

export function machine(): z.input<typeof MachineFingerprintSchema> {
  return {
    cpuModel: "Apple M4 Pro",
    cpuCores: 14,
    memoryBytes: 48 * 1024 ** 3,
    os: { platform: "darwin", release: "25.0.0", arch: "arm64" },
    runtimes: { node: "22.11.0", java: "25" },
    powerSource: "ac",
  };
}

export function oracleResult(): z.input<typeof OracleResultSchema> {
  return {
    oracle: "unit-tests",
    sha: SHA_B,
    changeId: CHANGE_ID,
    passed: true,
    summary: "412 of 412 baseline tests pass",
  };
}

export function evidenceBundle(): z.input<typeof EvidenceBundleSchema> {
  return {
    schemaVersion: 1,
    bundleId: "server-jvm-2026-10-17.1",
    createdAt: "2026-10-17T10:00:00Z",
    objective: objective(),
    machine: machine(),
    commands: ["./mvnw -q package -DskipTests", "java -Xmx1024m -jar target/app.jar"],
    toolVersions: { k6: "0.54.0" },
    shas: { baseline: SHA_A, final: SHA_B },
    samples: [sample()],
    changes: [change()],
    oracleResults: [oracleResult()],
    decisions: [keepDecision()],
    limitations: ["macOS: no core pinning"],
    hostAgent: "claude-code",
    modelId: "example-model-1",
    modelIdSource: "self_reported",
  };
}

export function policy(): z.input<typeof PolicySchema> {
  return {
    protectedPaths: ["src/test/**", "ufo.yaml", ".env*"],
    approvedConfigHash: SHA256,
    optIns: ["lossy"],
    targets: ["10.0.0.0/8"],
  };
}

export function ufoConfig(): z.input<typeof UfoConfigSchema> {
  return {
    version: 1,
    objective: objective(),
    workload: {
      start: "java -jar target/app.jar",
      healthcheck: "curl -fsS http://127.0.0.1:8080/actuator/health",
      command: "k6 run --quiet load/startup.js",
    },
    oracles: [{ name: "unit-tests", kind: "test_pass_set", command: "./mvnw -q test" }],
    targets: ["127.0.0.1"],
    cards: ["jvm.heap-size", "jvm.aot-cache"],
    optIns: [],
  };
}
