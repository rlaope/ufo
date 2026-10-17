import os from "node:os";
import { describe, expect, it } from "vitest";
import { collectFingerprint, readDockerDesktopVm } from "../../../src/core/evidence/index.js";
import { MachineFingerprintSchema } from "../../../src/domain/index.js";

describe("collectFingerprint", () => {
  it("builds the fingerprint from the injected readers", async () => {
    const fingerprint = await collectFingerprint({
      cpus: () => Array.from({ length: 14 }, () => ({ model: " Apple M4 Pro " })),
      totalMemoryBytes: () => 48 * 1024 ** 3,
      os: () => ({ platform: "darwin", release: "25.0.0", arch: "arm64" }),
      runtimes: async () => ({ node: "22.11.0", java: "25" }),
      powerSource: async () => "ac" as const,
      dockerVm: async () => ({ cpus: 8, memoryBytes: 16 * 1024 ** 3 }),
    });
    expect(fingerprint).toEqual({
      cpuModel: "Apple M4 Pro",
      cpuCores: 14,
      memoryBytes: 48 * 1024 ** 3,
      os: { platform: "darwin", release: "25.0.0", arch: "arm64" },
      runtimes: { node: "22.11.0", java: "25" },
      powerSource: "ac",
      dockerVm: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
    });
  });

  it("reads this machine by default and holds no hostname or username", async () => {
    const fingerprint = await collectFingerprint({
      powerSource: () => "unknown",
      dockerVm: () => undefined,
    });
    expect(MachineFingerprintSchema.parse(fingerprint)).toEqual(fingerprint);
    expect(fingerprint.cpuCores).toBeGreaterThanOrEqual(1);
    expect(fingerprint.os.platform).toBe(process.platform);
    expect(fingerprint.runtimes).toEqual({});
    expect(fingerprint.dockerVm).toBeUndefined();
    expect(Object.keys(fingerprint).sort()).toEqual(
      ["cpuCores", "cpuModel", "memoryBytes", "os", "powerSource", "runtimes"].sort(),
    );
    const text = JSON.stringify(fingerprint);
    expect(text).not.toContain(os.hostname());
    expect(text).not.toContain(os.homedir());
  });

  it("falls back to a placeholder CPU model", async () => {
    const fingerprint = await collectFingerprint({
      cpus: () => [{ model: "" }],
      powerSource: () => "battery",
      dockerVm: () => undefined,
    });
    expect(fingerprint).toMatchObject({ cpuModel: "unknown", cpuCores: 1, powerSource: "battery" });
  });
});

describe("readDockerDesktopVm", () => {
  it("returns a valid VM or nothing, whatever Docker setup this machine has", async () => {
    const vm = await readDockerDesktopVm();
    if (vm !== undefined) {
      expect(MachineFingerprintSchema.shape.dockerVm.parse(vm)).toEqual(vm);
    }
  });
});
