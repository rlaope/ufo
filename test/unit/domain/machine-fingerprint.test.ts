import { describe, expect, it } from "vitest";
import { MachineFingerprintSchema } from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, machine } from "./fixtures.js";

describe("MachineFingerprintSchema", () => {
  it("accepts a valid fingerprint", () => {
    expect(expectAccepts(MachineFingerprintSchema, machine())).toEqual(machine());
  });

  it("accepts a Docker Desktop VM and defaults runtimes", () => {
    const { runtimes: _, ...rest } = machine();
    const parsed = expectAccepts(MachineFingerprintSchema, {
      ...rest,
      dockerVm: { cpus: 8, memoryBytes: 8 * 1024 ** 3 },
    });
    expect(parsed.runtimes).toEqual({});
  });

  it("rejects an empty object", () => {
    expectRejects(MachineFingerprintSchema, {});
  });

  it.each(["cpuModel", "cpuCores", "memoryBytes", "os", "powerSource"] as const)(
    "rejects a fingerprint missing %s",
    (field) => {
      const value: Record<string, unknown> = machine();
      delete value[field];
      expectRejects(MachineFingerprintSchema, value);
    },
  );

  it.each([
    ["zero cores", { cpuCores: 0 }],
    ["overlong core count", { cpuCores: 4097 }],
    ["fractional memory", { memoryBytes: 1.5 }],
    ["unsafe memory size", { memoryBytes: Number.MAX_SAFE_INTEGER + 2 }],
    ["overlong CPU model", { cpuModel: "c".repeat(201) }],
    ["bad power source", { powerSource: "solar" }],
    ["os missing arch", { os: { platform: "darwin", release: "25.0.0" } }],
    ["bad runtime name", { runtimes: { "Java Runtime": "25" } }],
    ["Docker VM with zero CPUs", { dockerVm: { cpus: 0, memoryBytes: 1 } }],
    ["hostname field", { hostname: "build-box" }],
  ])("rejects %s", (_label, patch) => {
    expectRejects(MachineFingerprintSchema, { ...machine(), ...patch });
  });
});
