import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectFingerprint, readDockerDesktopVm } from "../../../src/core/evidence/index.js";
import { DOCKER_PROBE_TIMEOUT_MS, isPidAlive } from "../../../src/core/jobs/index.js";
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

// M5 V4: no test runs the real Docker. Each case puts a fake `docker` first on PATH.
describe("readDockerDesktopVm", () => {
  let bin: string;

  beforeEach(async () => {
    bin = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-docker-")));
    vi.stubEnv("PATH", [bin, "/usr/bin", "/bin"].join(path.delimiter));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(bin, { recursive: true, force: true });
  });

  async function fakeDocker(script: string): Promise<void> {
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  it("reads the CPUs and memory of a Docker Desktop VM", async () => {
    await fakeDocker(`printf 'Docker Desktop\\t8\\t%s\\n' ${16 * 1024 ** 3}`);
    expect(await readDockerDesktopVm()).toEqual({ cpus: 8, memoryBytes: 16 * 1024 ** 3 });
  });

  it("returns nothing for native Docker, a stopped daemon, or no Docker", async () => {
    await fakeDocker(`printf 'Ubuntu 24.04 LTS\\t8\\t%s\\n' ${16 * 1024 ** 3}`);
    expect(await readDockerDesktopVm()).toBeUndefined();
    await fakeDocker("echo 'Cannot connect to the Docker daemon' >&2; exit 1");
    expect(await readDockerDesktopVm()).toBeUndefined();
    vi.stubEnv("PATH", path.join(bin, "none"));
    expect(await readDockerDesktopVm()).toBeUndefined();
  });

  // Docker Desktop installed but unable to start: the CLI waits on its backend, and a helper it
  // started keeps the output open after the CLI itself is gone.
  it("gives up on a docker that hangs, kills what it started, and says the VM is unknown", async () => {
    await fakeDocker(`sleep 20 &\necho $! > '${path.join(bin, "helper.pid")}'\nwait`);
    const started = Date.now();
    const vm = await readDockerDesktopVm();
    expect(Date.now() - started).toBeLessThan(DOCKER_PROBE_TIMEOUT_MS + 2000);
    expect(vm).toEqual({
      unknown: true,
      reason: `docker info did not finish within ${DOCKER_PROBE_TIMEOUT_MS / 1000} s`,
    });
    expect(MachineFingerprintSchema.shape.dockerVm.parse(vm)).toEqual(vm);
    const helper = Number(await readFile(path.join(bin, "helper.pid"), "utf8"));
    await vi.waitFor(() => expect(isPidAlive(helper)).toBe(false), { timeout: 2000 });
  }, 15_000);
});
