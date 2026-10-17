import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Clock,
  checkHygiene,
  DEFAULT_DRIFT_THRESHOLD_MS,
  describeHygiene,
  parsePmsetBatt,
  parsePowerSupplies,
  probeLoad,
  probePowerSource,
  readPowerSupplies,
  type SystemReaders,
  watchClockDrift,
} from "../../../src/core/measure/index.js";

const PMSET_AC_LAPTOP = [
  "Now drawing from 'AC Power'",
  " -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true",
  "",
].join("\n");
const PMSET_BATTERY = [
  "Now drawing from 'Battery Power'",
  " -InternalBattery-0 (id=4653155)\t84%; discharging; 5:12 remaining present: true",
  "",
].join("\n");
const PMSET_DESKTOP = "Now drawing from 'AC Power'\n";
const PMSET_UPS = "Now drawing from 'UPS Power'\n -UPS (id=1)\t90%; discharging; present: true\n";

function readers(overrides: Partial<SystemReaders> = {}): SystemReaders {
  return {
    platform: "darwin",
    pmsetBatt: async () => PMSET_AC_LAPTOP,
    powerSupplies: async () => [],
    loadAverage: () => 1.5,
    cores: () => 14,
    ...overrides,
  };
}

describe("parsePmsetBatt", () => {
  it.each([
    ["a laptop on AC", PMSET_AC_LAPTOP, "ac"],
    ["a laptop on battery", PMSET_BATTERY, "battery"],
    ["a desktop", PMSET_DESKTOP, "ac"],
    ["a UPS after a mains outage", PMSET_UPS, "battery"],
    ["empty output", "", "unknown"],
    ["an unexpected source", "Now drawing from 'Solar Power'\n", "unknown"],
  ])("reads %s", (_label, output, expected) => {
    expect(parsePmsetBatt(output)).toBe(expected);
  });
});

describe("parsePowerSupplies", () => {
  it.each([
    [
      "a laptop on AC",
      [
        { name: "AC", type: "Mains", online: "1" },
        { name: "BAT0", type: "Battery" },
      ],
      "ac",
    ],
    [
      "a laptop on battery",
      [
        { name: "AC", type: "Mains", online: "0" },
        { name: "BAT0", type: "Battery" },
      ],
      "battery",
    ],
    [
      "a laptop charging over USB-C",
      [
        { name: "ucsi-source-psy-USBC000:001", type: "USB", online: "1" },
        { name: "ucsi-source-psy-USBC000:002", type: "USB", online: "0" },
        { name: "BAT1", type: "Battery" },
      ],
      "ac",
    ],
    ["a desktop or VM without supplies", [], "unknown"],
    [
      "a desktop with only a wireless mouse battery",
      [{ name: "hidpp_battery_0", type: "Battery", online: "1" }],
      "unknown",
    ],
    ["offline adapters without a battery", [{ name: "AC", type: "Mains", online: "0" }], "unknown"],
  ])("reads %s", (_label, entries, expected) => {
    expect(parsePowerSupplies(entries)).toBe(expected);
  });
});

describe("readPowerSupplies", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("reads type and online of each supply, in name order", async () => {
    root = await mkdtemp(join(tmpdir(), "ufo-power-"));
    await mkdir(join(root, "BAT0"));
    await writeFile(join(root, "BAT0", "type"), "Battery\n");
    await mkdir(join(root, "AC"));
    await writeFile(join(root, "AC", "type"), "Mains\n");
    await writeFile(join(root, "AC", "online"), "1\n");
    const entries = await readPowerSupplies(root);
    expect(entries).toEqual([
      { name: "AC", type: "Mains", online: "1" },
      { name: "BAT0", type: "Battery" },
    ]);
    expect(parsePowerSupplies(entries)).toBe("ac");
  });

  it("returns no entries when the directory does not exist", async () => {
    root = await mkdtemp(join(tmpdir(), "ufo-power-"));
    expect(await readPowerSupplies(join(root, "missing"))).toEqual([]);
  });
});

describe("probePowerSource", () => {
  it("parses pmset on macOS", async () => {
    expect(await probePowerSource(readers({ pmsetBatt: async () => PMSET_BATTERY }))).toBe(
      "battery",
    );
  });

  it("reads power supplies on Linux", async () => {
    const linux = readers({
      platform: "linux",
      powerSupplies: async () => [{ name: "AC", type: "Mains", online: "1" }],
    });
    expect(await probePowerSource(linux)).toBe("ac");
  });

  it("is unknown on other platforms", async () => {
    expect(await probePowerSource(readers({ platform: "win32" }))).toBe("unknown");
  });

  it("is unknown when the reader fails", async () => {
    const failing = readers({
      pmsetBatt: async () => {
        throw new Error("spawn pmset ENOENT");
      },
    });
    expect(await probePowerSource(failing)).toBe("unknown");
  });
});

describe("probeLoad", () => {
  it("passes below 0.5 × cores", () => {
    expect(probeLoad(readers({ loadAverage: () => 6.99 }))).toEqual({
      oneMinute: 6.99,
      cores: 14,
      factor: 0.5,
      threshold: 7,
      ok: true,
    });
  });

  it("fails at 0.5 × cores", () => {
    expect(probeLoad(readers({ loadAverage: () => 7 })).ok).toBe(false);
  });

  it("takes a configured factor", () => {
    const probe = probeLoad(readers({ loadAverage: () => 9 }), 0.75);
    expect(probe).toMatchObject({ threshold: 10.5, ok: true });
  });

  it.each([0, -1, Number.NaN])("rejects factor %s", (factor) => {
    expect(() => probeLoad(readers(), factor)).toThrow(RangeError);
  });
});

/** A clock whose wall and monotonic readings the test moves by hand. */
function fakeClock() {
  const state = { wallMs: 1_700_000_000_000, monotonicNs: 5_000_000_000n };
  const clock: Clock = { wallMs: () => state.wallMs, monotonicNs: () => state.monotonicNs };
  const advance = (wallMs: number, monotonicMs: number) => {
    state.wallMs += wallMs;
    state.monotonicNs += BigInt(monotonicMs) * 1_000_000n;
  };
  return { clock, advance };
}

describe("watchClockDrift", () => {
  it("passes a sample where both clocks advance together", () => {
    const { clock, advance } = fakeClock();
    const stop = watchClockDrift(clock);
    advance(30_000, 29_990);
    expect(stop()).toEqual({ wallMs: 30_000, monotonicMs: 29_990, driftMs: 10, ok: true });
  });

  it("flags a sleep: the wall clock ran on while the monotonic clock stopped", () => {
    const { clock, advance } = fakeClock();
    const stop = watchClockDrift(clock);
    advance(65_000, 5_000);
    expect(stop()).toMatchObject({ driftMs: 60_000, ok: false });
  });

  it("flags a backward wall-clock jump", () => {
    const { clock, advance } = fakeClock();
    const stop = watchClockDrift(clock);
    advance(-4_000, 1_000);
    expect(stop()).toMatchObject({ driftMs: -5_000, ok: false });
  });

  it(`flags drift at the ${DEFAULT_DRIFT_THRESHOLD_MS} ms threshold, or a configured one`, () => {
    const { clock, advance } = fakeClock();
    const stopDefault = watchClockDrift(clock);
    const stopLoose = watchClockDrift(clock, 5_000);
    advance(DEFAULT_DRIFT_THRESHOLD_MS, 0);
    expect(stopDefault().ok).toBe(false);
    expect(stopLoose().ok).toBe(true);
  });

  it("reads the real clocks by default", () => {
    const probe = watchClockDrift()();
    expect(probe.ok).toBe(true);
    expect(probe.monotonicMs).toBeGreaterThanOrEqual(0);
  });
});

describe("checkHygiene and describeHygiene", () => {
  it("reports a clean machine", async () => {
    const report = await checkHygiene(readers());
    expect(report).toMatchObject({ power: "ac", ok: true, issues: [], clockDrifts: [] });
    expect(describeHygiene(report)).toBe(
      "no battery, load average, or sleep/wake issue detected; check background apps, or use a deterministic proxy metric",
    );
  });

  it("does not count an unknown power source as an issue", async () => {
    const report = await checkHygiene(readers({ platform: "linux" }));
    expect(report).toMatchObject({ power: "unknown", ok: true });
  });

  it("names battery power, high load, and sleep/wake together", async () => {
    const { clock, advance } = fakeClock();
    const stopFirst = watchClockDrift(clock);
    advance(10_000, 10_000);
    const first = stopFirst();
    const stopSecond = watchClockDrift(clock);
    advance(40_000, 2_000);
    const second = stopSecond();
    const report = await checkHygiene(
      readers({ pmsetBatt: async () => PMSET_BATTERY, loadAverage: () => 11.2 }),
      { clockDrifts: [first, second] },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toEqual(["battery", "load", "sleep_wake"]);
    expect(describeHygiene(report)).toBe(
      "running on battery power; 1-minute load average 11.20 is at or above 7.00 (0.5 x 14 cores); 1 of 2 samples spanned a sleep/wake or clock jump (largest wall vs monotonic drift 38000 ms)",
    );
  });

  it("applies the configured load factor", async () => {
    const report = await checkHygiene(readers({ loadAverage: () => 9 }), { loadFactor: 0.75 });
    expect(report.ok).toBe(true);
  });
});
