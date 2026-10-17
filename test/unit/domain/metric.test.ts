import { describe, expect, it } from "vitest";
import { MAX_ID_LENGTH, MetricSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, metric } from "./fixtures.js";

describe("MetricSchema", () => {
  it("accepts a valid metric", () => {
    expect(expectAccepts(MetricSchema, metric())).toEqual(metric());
  });

  it.each([
    "process_launch",
    "load_run",
    "build",
    "page_load",
    "eval_pass",
    "training_pass",
  ] as const)("accepts replication unit %s", (replicationUnit) => {
    expectAccepts(MetricSchema, { ...metric(), replicationUnit });
  });

  it("rejects an empty object", () => {
    expectRejects(MetricSchema, {});
  });

  it.each(["name", "unit", "direction", "kind", "replicationUnit"] as const)(
    "rejects a metric missing %s",
    (field) => {
      const value: Record<string, unknown> = metric();
      delete value[field];
      expectRejects(MetricSchema, value);
    },
  );

  it.each([
    ["overlong name", { name: "m".repeat(MAX_ID_LENGTH + 1) }],
    ["overlong unit", { unit: "u".repeat(MAX_ID_LENGTH + 1) }],
    ["bad direction", { direction: "smaller" }],
    ["bad kind", { kind: "random" }],
    ["bad replication unit", { replicationUnit: "request" }],
    ["name with spaces", { name: "startup time" }],
    ["numeric unit", { unit: 5 }],
    ["unknown field", { weight: 1 }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(MetricSchema, { ...metric(), ...patch });
  });
});
