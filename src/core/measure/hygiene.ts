import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PowerSource } from "../../domain/index.js";

/** One entry of `/sys/class/power_supply`, with its trimmed `type` and `online` files if present. */
export interface PowerSupplyEntry {
  readonly name: string;
  readonly type?: string;
  readonly online?: string;
}

/** Machine state the hygiene probes read. Tests inject fixtures; `systemReaders` reads this host. */
export interface SystemReaders {
  /** `process.platform`. */
  readonly platform: string;
  /** Output of `pmset -g batt` (macOS). */
  pmsetBatt(): Promise<string>;
  /** Entries of `/sys/class/power_supply` (Linux). */
  powerSupplies(): Promise<PowerSupplyEntry[]>;
  /** 1-minute load average. */
  loadAverage(): number;
  /** Logical CPU cores. */
  cores(): number;
}

/** Wall clock and monotonic clock, compared to detect sleep/wake during a sample. */
export interface Clock {
  wallMs(): number;
  monotonicNs(): bigint;
}

/** Samples need a 1-minute load average below this many times the core count. */
export const DEFAULT_LOAD_FACTOR = 0.5;

/** Wall-clock vs monotonic drift over one sample at or above which the sample is invalid. */
export const DEFAULT_DRIFT_THRESHOLD_MS = 1000;

const POWER_SUPPLY_ROOT = "/sys/class/power_supply";
const PMSET_TIMEOUT_MS = 5000;

/**
 * Parses `pmset -g batt`. Its first line is `Now drawing from 'AC Power'` (or `'Battery Power'`,
 * `'UPS Power'`); drawing from a UPS means mains power is out, so it counts as battery.
 */
export function parsePmsetBatt(output: string): PowerSource {
  const source = /Now drawing from '([^']+)'/.exec(output)?.[1];
  if (source === "AC Power") return "ac";
  if (source === "Battery Power" || source === "UPS Power") return "battery";
  return "unknown";
}

/**
 * Reads the power source from `/sys/class/power_supply` entries. Any non-battery supply with
 * `online` = 1 (Mains, USB, UPS) means AC. All such supplies offline with a battery present
 * means battery. Anything else (no supplies, as on most desktops and VMs) is unknown.
 */
export function parsePowerSupplies(entries: readonly PowerSupplyEntry[]): PowerSource {
  const adapters = entries.filter(
    (entry) => entry.online !== undefined && entry.type !== "Battery",
  );
  if (adapters.some((entry) => entry.online === "1")) return "ac";
  if (adapters.length > 0 && entries.some((entry) => entry.type === "Battery")) return "battery";
  return "unknown";
}

/** Lists `root` (default `/sys/class/power_supply`); a missing directory yields no entries. */
export async function readPowerSupplies(root = POWER_SUPPLY_ROOT): Promise<PowerSupplyEntry[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return Promise.all(
    names.sort().map(async (name) => {
      const type = await readTrimmed(join(root, name, "type"));
      const online = await readTrimmed(join(root, name, "online"));
      return {
        name,
        ...(type === undefined ? {} : { type }),
        ...(online === undefined ? {} : { online }),
      };
    }),
  );
}

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

const execFileAsync = promisify(execFile);

export const systemReaders: SystemReaders = {
  platform: process.platform,
  async pmsetBatt() {
    const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], {
      timeout: PMSET_TIMEOUT_MS,
    });
    return stdout;
  },
  powerSupplies: () => readPowerSupplies(),
  loadAverage: () => loadavg()[0] ?? 0,
  cores: () => availableParallelism(),
};

export const systemClock: Clock = {
  wallMs: () => Date.now(),
  monotonicNs: () => process.hrtime.bigint(),
};

/**
 * Power source of this machine: `pmset` on macOS, `/sys/class/power_supply` on Linux, unknown
 * elsewhere. A reader that fails yields unknown, so the probe never stops a run by itself.
 */
export async function probePowerSource(
  readers: SystemReaders = systemReaders,
): Promise<PowerSource> {
  try {
    if (readers.platform === "darwin") return parsePmsetBatt(await readers.pmsetBatt());
    if (readers.platform === "linux") return parsePowerSupplies(await readers.powerSupplies());
  } catch {
    return "unknown";
  }
  return "unknown";
}

export interface LoadProbe {
  readonly oneMinute: number;
  readonly cores: number;
  readonly factor: number;
  /** `factor × cores`; the load average must stay below it. */
  readonly threshold: number;
  readonly ok: boolean;
}

export function probeLoad(
  readers: SystemReaders = systemReaders,
  factor = DEFAULT_LOAD_FACTOR,
): LoadProbe {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`the load factor must be a positive number, got ${factor}`);
  }
  const cores = readers.cores();
  const oneMinute = readers.loadAverage();
  const threshold = factor * cores;
  return { oneMinute, cores, factor, threshold, ok: oneMinute < threshold };
}

export interface ClockDriftProbe {
  /** Elapsed wall-clock time over the sample. */
  readonly wallMs: number;
  /** Elapsed monotonic time over the sample; it stops while the machine sleeps. */
  readonly monotonicMs: number;
  /** `wallMs - monotonicMs`: positive after a sleep, either sign after a wall-clock jump. */
  readonly driftMs: number;
  /** `|driftMs|` is below the threshold. */
  readonly ok: boolean;
}

/**
 * Starts watching one sample; call the returned function when it ends. The monotonic clock
 * (`process.hrtime`) does not advance during system sleep on macOS or Linux, while the wall
 * clock does, so a sleep/wake shows up as drift between the two.
 */
export function watchClockDrift(
  clock: Clock = systemClock,
  thresholdMs = DEFAULT_DRIFT_THRESHOLD_MS,
): () => ClockDriftProbe {
  const wallStart = clock.wallMs();
  const monotonicStart = clock.monotonicNs();
  return () => {
    const wallMs = clock.wallMs() - wallStart;
    const monotonicMs = Number(clock.monotonicNs() - monotonicStart) / 1e6;
    const driftMs = wallMs - monotonicMs;
    return { wallMs, monotonicMs, driftMs, ok: Math.abs(driftMs) < thresholdMs };
  };
}

export type HygieneIssueKind = "battery" | "load" | "sleep_wake";

export interface HygieneIssue {
  readonly kind: HygieneIssueKind;
  readonly message: string;
}

export interface HygieneReport {
  readonly power: PowerSource;
  readonly load: LoadProbe;
  readonly clockDrifts: readonly ClockDriftProbe[];
  readonly issues: readonly HygieneIssue[];
  /** No issues. An unknown power source is not an issue. */
  readonly ok: boolean;
}

export interface HygieneOptions {
  readonly loadFactor?: number;
  /** Drift probes of recent samples, to report sleep/wake among them. */
  readonly clockDrifts?: readonly ClockDriftProbe[];
}

/**
 * Checks the machine before a sample (AC power, load average) and summarizes sleep/wake over
 * recent samples. The report's `describeHygiene` text names the likely cause of a noisy metric.
 */
export async function checkHygiene(
  readers: SystemReaders = systemReaders,
  options: HygieneOptions = {},
): Promise<HygieneReport> {
  const power = await probePowerSource(readers);
  const load = probeLoad(readers, options.loadFactor);
  const clockDrifts = options.clockDrifts ?? [];
  const issues: HygieneIssue[] = [];
  if (power === "battery") {
    issues.push({ kind: "battery", message: "running on battery power" });
  }
  if (!load.ok) {
    issues.push({
      kind: "load",
      message: `1-minute load average ${load.oneMinute.toFixed(2)} is at or above ${load.threshold.toFixed(2)} (${load.factor} x ${load.cores} cores)`,
    });
  }
  const drifted = clockDrifts.filter((probe) => !probe.ok);
  if (drifted.length > 0) {
    const largest = Math.max(...drifted.map((probe) => Math.abs(probe.driftMs)));
    issues.push({
      kind: "sleep_wake",
      message: `${drifted.length} of ${clockDrifts.length} samples spanned a sleep/wake or clock jump (largest wall vs monotonic drift ${Math.round(largest)} ms)`,
    });
  }
  return { power, load, clockDrifts, issues, ok: issues.length === 0 };
}

/** One line naming the likely cause of noise, for a `policy:noise_floor` detail. */
export function describeHygiene(report: HygieneReport): string {
  if (report.issues.length === 0) {
    return "no battery, load average, or sleep/wake issue detected; check background apps, or use a deterministic proxy metric";
  }
  return report.issues.map((issue) => issue.message).join("; ");
}
