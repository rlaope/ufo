import { createServer } from "node:net";
import type { DockerVm } from "../core/evidence/index.js";
import {
  type Clock,
  type ClockDriftProbe,
  checkHygiene,
  DEFAULT_MAX_RERUNS,
  describeHygiene,
  invalidSamplesMessage,
  MeasurementError,
  type SampleOutcome,
  type SystemReaders,
  systemClock,
  systemReaders,
  watchClockDrift,
} from "../core/measure/index.js";
import { oneLine } from "../core/text.js";
import {
  type Arm,
  type HygieneConfig,
  labelSchema,
  type Objective,
  type ProfileStep,
  type Sample,
  type SamplePhase,
  type Workload,
} from "../domain/index.js";
import { trackPort } from "../worker/index.js";
import {
  type BackgroundProcess,
  type CommandResult,
  describeResult,
  runCommand,
  startBackground,
  succeeded,
} from "./commands.js";
import { ERROR_RATE_KEY, RSS_KEY } from "./config.js";

/**
 * The machine the worker measures on: hygiene probes, the clocks compared for sleep/wake, and
 * the Docker Desktop VM for the fingerprint. Injectable so tests can pin a machine state.
 */
export interface Machine {
  readonly readers: SystemReaders;
  readonly clock: Clock;
  readonly dockerVm?: () => Promise<DockerVm | undefined>;
}

export const systemMachine: Machine = { readers: systemReaders, clock: systemClock };

const HEALTHCHECK_TIMEOUT_MS = 60_000;
const HEALTHCHECK_INTERVAL_MS = 250;
const MAX_REASON_LENGTH = 200;

/** One-line, bounded reason for `Sample.invalidReason`. */
function reason(text: string): string {
  return oneLine(text, MAX_REASON_LENGTH, "invalid sample");
}

export type ParsedSample =
  | { ok: true; value: number; secondary: Record<string, number> }
  | { ok: false; reason: string };

/**
 * Reads the workload's output: exactly one non-empty line on stdout, a JSON object with the
 * primary metric (a finite number ≥ 0) and optionally `error_rate` (0 to 1), `rss_bytes`, and
 * reported-only metrics. Any other key, a missing key a guardrail needs, or any other output
 * makes the sample invalid.
 */
export function parseSampleOutput(stdout: string, objective: Objective): ParsedSample {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    return { ok: false, reason: `expected one JSON line on stdout, got ${lines.length} lines` };
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? "");
  } catch {
    return { ok: false, reason: "stdout is not a JSON line" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "stdout is not a JSON object" };
  }
  const primary = objective.primary.name;
  const allowed = new Set([
    primary,
    ERROR_RATE_KEY,
    RSS_KEY,
    ...objective.reportedOnly.map((m) => m.name),
  ]);
  const record = value as Record<string, unknown>;
  const secondary: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!allowed.has(key)) return { ok: false, reason: `unexpected key ${key} in the output` };
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return { ok: false, reason: `${key} must be a finite number >= 0` };
    }
    if (key === ERROR_RATE_KEY && raw > 1) {
      return { ok: false, reason: `${ERROR_RATE_KEY} must be between 0 and 1` };
    }
    if (key !== primary) secondary[key] = raw;
  }
  const metric = record[primary];
  if (typeof metric !== "number") return { ok: false, reason: `missing ${primary} in the output` };
  for (const guardrail of objective.guardrails) {
    const key =
      guardrail.kind === "error_rate" ? ERROR_RATE_KEY : guardrail.kind === "memory" ? RSS_KEY : "";
    if (key !== "" && secondary[key] === undefined) {
      return { ok: false, reason: `the ${guardrail.kind} guardrail needs ${key} in the output` };
    }
  }
  return { ok: true, value: metric, secondary };
}

/** One arm of a measurement: its clone and the commit checked out there. */
export interface ArmSpec {
  readonly arm: Arm;
  readonly dir: string;
  readonly sha: string;
}

/** What a profile job adds to the environment of its commands (`workload.profile`). */
export interface ProfileEnv {
  /** `UFO_PROFILE_DIR`, for every step of the job. */
  readonly dir: string;
  /** For the profiled steps only, `{{profile_dir}}` already replaced. */
  readonly env: Readonly<Record<string, string>>;
  readonly steps: readonly ProfileStep[];
}

export interface SessionOptions {
  readonly runDir: string;
  readonly runId: string;
  readonly workload: Workload;
  readonly objective: Objective;
  readonly hygiene: HygieneConfig;
  readonly machine: Machine;
  readonly signal: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
  /** Only a profile job's session has it. */
  readonly profile?: ProfileEnv;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

/** A workload lifecycle step, as `ufo.yaml` names it. */
type WorkloadStep = Exclude<keyof Workload, "profile">;

export class WorkloadError extends Error {
  override name = "WorkloadError";
  readonly result: CommandResult | undefined;

  constructor(message: string, result?: CommandResult) {
    super(message);
    this.result = result;
  }
}

/**
 * Runs the workload lifecycle of plan §2.2 for one job: `setup` per arm, then `start` →
 * `healthcheck` → `warmup` per arm, samples (`reset` before each `command`), and `teardown`.
 * Every command runs in the arm's directory with exactly the run's captured environment plus
 * `UFO_ARM`, `UFO_PORT`, `UFO_RUN_ID`, and `UFO_PHASE`; samples also get `UFO_SAMPLE_INDEX`.
 * A profile job's session adds `UFO_PROFILE_DIR` to every step and the profile's variables to
 * the profiled steps; oracles and hooks (`runInArm`) never get those. Every sample is recorded,
 * valid or not.
 */
export class WorkloadSession {
  readonly samples: Sample[] = [];
  readonly drifts: ClockDriftProbe[] = [];
  /** Every command line this session ran, for the evidence bundle. */
  readonly commands = new Set<string>();
  private readonly options: SessionOptions;
  private readonly ports = new Map<Arm, number>();
  private readonly started: { arm: ArmSpec; process?: BackgroundProcess }[] = [];

  constructor(options: SessionOptions) {
    this.options = options;
  }

  private async env(
    arm: Arm,
    phase: SamplePhase,
    step: WorkloadStep | undefined,
    extra: Record<string, string> = {},
  ) {
    let port = this.ports.get(arm);
    if (port === undefined) {
      port = await freePort();
      this.ports.set(arm, port);
      await trackPort(this.options.runDir, port).catch(() => undefined);
    }
    const { profile } = this.options;
    return {
      ...this.options.env,
      ...(profile?.steps.some((s) => s === step) ? profile.env : {}),
      UFO_ARM: arm,
      UFO_PORT: String(port),
      UFO_RUN_ID: this.options.runId,
      UFO_PHASE: phase,
      ...(profile === undefined ? {} : { UFO_PROFILE_DIR: profile.dir }),
      ...extra,
    };
  }

  private async run(
    command: string,
    spec: ArmSpec,
    phase: SamplePhase,
    step: WorkloadStep | undefined,
    label: string,
    extra?: Record<string, string>,
  ): Promise<CommandResult> {
    this.options.signal.throwIfAborted();
    this.commands.add(command);
    const result = await runCommand(command, {
      runDir: this.options.runDir,
      cwd: spec.dir,
      env: await this.env(spec.arm, phase, step, extra),
      label: `${spec.arm} ${label}`,
      signal: this.options.signal,
    });
    this.options.signal.throwIfAborted();
    return result;
  }

  /** Runs an arbitrary approved command (an oracle, a card's reset hook) in the arm. */
  runInArm(command: string, spec: ArmSpec, phase: SamplePhase, label: string) {
    return this.run(command, spec, phase, undefined, label);
  }

  /** The workload's `setup` (the build). `undefined` when there is none. */
  async setup(spec: ArmSpec, phase: SamplePhase): Promise<CommandResult | undefined> {
    const { setup } = this.options.workload;
    return setup === undefined ? undefined : this.run(setup, spec, phase, "setup", "setup");
  }

  /** `start` (kept running), `healthcheck` until it passes, then `warmup`. */
  async start(spec: ArmSpec, phase: SamplePhase): Promise<void> {
    const { start, healthcheck, warmup } = this.options.workload;
    const entry: { arm: ArmSpec; process?: BackgroundProcess } = { arm: spec };
    this.started.push(entry);
    if (start !== undefined) {
      this.commands.add(start);
      entry.process = await startBackground(start, {
        runDir: this.options.runDir,
        cwd: spec.dir,
        env: await this.env(spec.arm, phase, "start"),
        label: `${spec.arm} start`,
        log: `start-${spec.arm}.log`,
      });
    }
    if (healthcheck !== undefined) {
      const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;
      for (;;) {
        const result = await this.run(healthcheck, spec, phase, "healthcheck", "healthcheck");
        if (succeeded(result)) break;
        if (entry.process !== undefined && !entry.process.running()) {
          throw new WorkloadError(`arm ${spec.arm}: \`${start}\` exited before it was healthy`);
        }
        if (Date.now() > deadline) {
          throw new WorkloadError(
            `arm ${spec.arm}: healthcheck did not pass within ${HEALTHCHECK_TIMEOUT_MS / 1000} s: ${describeResult(result)}`,
            result,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTHCHECK_INTERVAL_MS));
      }
    }
    if (warmup !== undefined) {
      const result = await this.run(warmup, spec, phase, "warmup", "warmup");
      if (!succeeded(result)) {
        throw new WorkloadError(
          `arm ${spec.arm}: warmup failed: ${describeResult(result)}`,
          result,
        );
      }
    }
  }

  /**
   * One sample: hygiene first (battery, load), then `reset`, then the timed `command` inside a
   * clock-drift probe (sleep/wake). Returns the outcome `runInterleaved` expects and records
   * the sample either way.
   */
  async sample(
    spec: ArmSpec,
    index: number,
    phase: SamplePhase,
    changeId?: string,
  ): Promise<SampleOutcome> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const record = (outcome: { value: number; secondary?: Record<string, number> } | string) => {
      const valid = typeof outcome !== "string";
      this.samples.push({
        phase,
        ...(changeId === undefined ? {} : { changeId }),
        arm: spec.arm,
        sha: spec.sha,
        index,
        metric: this.options.objective.primary.name,
        value: valid ? outcome.value : 0,
        secondary: valid ? (outcome.secondary ?? {}) : {},
        startedAt,
        durationMs: Math.max(0, performance.now() - started),
        valid,
        ...(valid ? {} : { invalidReason: labelSchema().parse(reason(outcome)) }),
      });
      return valid
        ? { valid: true as const, value: outcome.value }
        : { valid: false as const, reason: reason(outcome) };
    };

    const hygiene = await checkHygiene(this.options.machine.readers, this.hygieneOptions());
    if (!hygiene.ok) return record(`machine hygiene: ${describeHygiene(hygiene)}`);
    const { reset, command } = this.options.workload;
    if (reset !== undefined) {
      const result = await this.run(reset, spec, phase, "reset", `reset ${index}`);
      if (!succeeded(result)) return record(`reset failed: ${describeResult(result)}`);
    }
    const probe = watchClockDrift(this.options.machine.clock);
    const result = await this.run(command, spec, phase, "command", `sample ${index}`, {
      UFO_SAMPLE_INDEX: String(index),
    });
    const drift = probe();
    this.drifts.push(drift);
    if (!drift.ok) {
      return record(
        `sleep/wake or clock jump during the sample (wall vs monotonic drift ${Math.round(drift.driftMs)} ms)`,
      );
    }
    if (!succeeded(result)) return record(`workload failed: ${describeResult(result)}`);
    const parsed = parseSampleOutput(result.stdout, this.options.objective);
    if (!parsed.ok) return record(parsed.reason);
    return record({ value: parsed.value, secondary: parsed.secondary });
  }

  /** `count` valid samples of one arm (the baseline), re-running invalid ones like the pairs do. */
  async sampleArm(spec: ArmSpec, count: number, phase: SamplePhase): Promise<number[]> {
    const values: number[] = [];
    for (let index = 0; index < count; index++) {
      const reasons: string[] = [];
      for (;;) {
        const outcome = await this.sample(spec, index, phase);
        if (outcome.valid) {
          values.push(outcome.value);
          break;
        }
        reasons.push(outcome.reason);
        if (reasons.length > DEFAULT_MAX_RERUNS) {
          throw new MeasurementError(
            "too_many_invalid_samples",
            invalidSamplesMessage({ arm: spec.arm, index }, reasons),
            { arm: spec.arm, index },
            reasons,
          );
        }
      }
    }
    return values;
  }

  private hygieneOptions() {
    return {
      loadFactor: this.options.hygiene.maxLoadFactor,
      requireAcPower: this.options.hygiene.requireAcPower,
    };
  }

  /** The likely cause of noise, for a `policy:noise_floor` detail. */
  async noiseCause(): Promise<string> {
    return describeHygiene(
      await checkHygiene(this.options.machine.readers, {
        ...this.hygieneOptions(),
        clockDrifts: this.drifts,
      }),
    );
  }

  /** `teardown` in every started arm, then stops what `start` launched. Never throws. */
  async teardown(phase: SamplePhase): Promise<void> {
    const { teardown } = this.options.workload;
    for (const entry of this.started.splice(0).reverse()) {
      if (teardown !== undefined) {
        this.commands.add(teardown);
        await runCommand(teardown, {
          runDir: this.options.runDir,
          cwd: entry.arm.dir,
          env: await this.env(entry.arm.arm, phase, "teardown"),
          label: `${entry.arm.arm} teardown`,
        }).catch(() => undefined);
      }
      await entry.process?.stop().catch(() => undefined);
    }
  }
}
