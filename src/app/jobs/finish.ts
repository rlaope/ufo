import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { median, pairImprovement } from "../../core/decide/index.js";
import { collectFingerprint, redact, writeBundle } from "../../core/evidence/index.js";
import { publishBranch, removeRun, resetArms, resetBTo, revertB } from "../../core/git/index.js";
import {
  appendLedger,
  cancelJob,
  type JobRecord,
  type LedgerEvent,
  listJobs,
  readLedger,
  releaseMachineLock,
  updateRun,
  writeJsonAtomic,
} from "../../core/jobs/index.js";
import { MeasurementError, probePowerSource, runInterleaved } from "../../core/measure/index.js";
import { PolicyError } from "../../core/policy/index.js";
import {
  type EvidenceBundle,
  EvidenceBundleSchema,
  type MachineFingerprint,
  type Pair,
} from "../../domain/index.js";
import type { JobContext } from "../../worker/index.js";
import { describeResult, succeeded } from "../commands.js";
import {
  BaselineDataSchema,
  decisionsOf,
  EVENTS,
  latestBaseline,
  startedChanges,
} from "../events.js";
import {
  approvalViolation,
  jsonData,
  type OpenRun,
  openRun,
  REPORT_FILE,
  toJson,
} from "../state.js";
import { WorkloadError } from "../workload.js";
import { FINAL_CHECK_PAIRS, formatValue, type HandlerOptions, newSession } from "./shared.js";

const execFileAsync = promisify(execFile);

export interface FinalCheck {
  baselineSha: string;
  finalSha: string;
  /** `baseline` = the run's base SHA in B, `final` = the run branch HEAD in A. */
  pairs: { baseline: number; final: number }[];
  baselineMedian: number;
  finalMedian: number;
  /** Speed-up per pair: baseline / final when lower is better, final / baseline otherwise. */
  medianRatio: number;
  minRatio: number;
  maxRatio: number;
  /** Median relative improvement; below `minEffect` means no headline. */
  medianImprovement: number;
}

// Optional fields admit `undefined` before serialization; JSON drops them.
export interface DecisionSummary {
  changeId: string;
  cardId: string;
  outcome: string;
  reason?: string | undefined;
  effect?: number | undefined;
  detail?: string | undefined;
  commit?: string | undefined;
}

export interface RunReport {
  runId: string;
  branch: string;
  baselineSha: string;
  finalSha: string;
  headline?: string | undefined;
  /** Why there is no headline: nothing kept, the final check failed or is below `minEffect`. */
  noHeadline?: string | undefined;
  finalCheck?: FinalCheck | undefined;
  decisions: DecisionSummary[];
  bundleId: string;
  /** Where the redacted evidence bundle was written. */
  bundleDir: string;
  limitations: string[];
}

export function summarizeDecisions(events: readonly LedgerEvent[]): DecisionSummary[] {
  const commits = new Map(
    events
      .filter((e) => e.type === EVENTS.committed && e.changeId !== undefined)
      .map((e) => [e.changeId ?? "", (e.data as { sha?: string } | undefined)?.sha]),
  );
  return decisionsOf(events).map(({ decision, cardId }) => {
    const commit = commits.get(decision.changeId);
    return toJson({
      changeId: decision.changeId,
      cardId,
      outcome: decision.outcome,
      reason: decision.reason,
      effect: decision.effect,
      detail: decision.detail,
      commit,
    });
  });
}

function ratioOf(pair: { baseline: number; final: number }, lowerIsBetter: boolean): number {
  return lowerIsBetter ? pair.baseline / pair.final : pair.final / pair.baseline;
}

function machineLabel(machine: MachineFingerprint): string {
  return machine.cpuModel === "unknown" ? `${machine.cpuCores} cores` : machine.cpuModel;
}

function hostLabel(open: OpenRun): string {
  const host = open.state.hostAgent === "none" ? "no agent (recipes)" : open.state.hostAgent;
  return open.state.modelId === undefined
    ? host
    : `${host} + ${open.state.modelId} (self-reported)`;
}

/** Plan §4.6: median ratio with the min–max range, scenario, n, machine, host and model. */
export function formatHeadline(
  open: OpenRun,
  check: FinalCheck,
  machine: MachineFingerprint,
): string {
  const { primary, scenario } = open.config.objective;
  const ratio = (value: number) => `${value.toFixed(value >= 10 ? 1 : 2)}×`;
  return (
    `${scenario}: ${primary.name} ${formatValue(check.baselineMedian)} → ` +
    `${formatValue(check.finalMedian)} ${primary.unit} (${ratio(check.medianRatio)}, range ` +
    `${ratio(check.minRatio)}–${ratio(check.maxRatio)}, ${check.pairs.length} pairs, ` +
    `${machineLabel(machine)}, ${hostLabel(open)})`
  );
}

async function gitVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5000 });
    return /(\d+\.\d+(?:\.\d+)?)/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Final check, report, and evidence bundle (plan §2.3 step 10, §4.6). B is put at the run's
 * base SHA and A stays at the final SHA; five fresh interleaved pairs give the headline, which
 * is published only when the median improvement reaches `minEffect`. Then the bundle is
 * redacted and written, the run branch is published to the user's repository, the arms are
 * removed, jobs still queued are cancelled, and the machine lock is released.
 */
export async function handleFinish(
  job: JobRecord,
  context: JobContext,
  options: HandlerOptions,
): Promise<RunReport> {
  void job;
  const open = await openRun(options.home, context.runDir);
  const unapproved = await approvalViolation(open);
  if (unapproved !== undefined) throw new PolicyError(unapproved);
  const baselineSha = open.git.baseSha;
  // A is measured exactly at its commit (security F11).
  const finalSha = await resetArms(open.git);
  const { primary, minEffect } = open.config.objective;
  const lowerIsBetter = primary.direction === "lower_is_better";
  const session = newSession(open, context, options.machine);
  let finalCheck: FinalCheck | undefined;
  let noHeadline: string | undefined;

  if (finalSha === baselineSha) {
    noHeadline = "no change was kept, so there is nothing to compare";
  } else {
    context.setProgress({ done: 0, total: 2, message: "final check" });
    // run.json says where B is while it sits at the base SHA, until `revertB` brings it back.
    await updateRun(context.runDir, (run) => ({ ...run, shas: { ...run.shas, b: baselineSha } }));
    await resetBTo(open.git, baselineSha);
    const armA = { arm: "a" as const, dir: open.git.armA, sha: finalSha };
    const armB = { arm: "b" as const, dir: open.git.armB, sha: baselineSha };
    try {
      for (const arm of [armA, armB]) {
        const setup = await session.setup(arm, "final_check");
        if (setup !== undefined && !succeeded(setup)) {
          throw new WorkloadError(`setup failed in the final check: ${describeResult(setup)}`);
        }
      }
      await session.start(armA, "final_check");
      await session.start(armB, "final_check");
      const raw: Pair[] = await runInterleaved(FINAL_CHECK_PAIRS, (arm, index) =>
        session.sample(arm === "a" ? armA : armB, index, "final_check"),
      );
      const pairs = raw.map(({ a, b }) => ({ baseline: b, final: a }));
      const ratios = pairs.map((pair) => ratioOf(pair, lowerIsBetter));
      finalCheck = {
        baselineSha,
        finalSha,
        pairs,
        baselineMedian: median(pairs.map((p) => p.baseline)),
        finalMedian: median(pairs.map((p) => p.final)),
        medianRatio: median(ratios),
        minRatio: Math.min(...ratios),
        maxRatio: Math.max(...ratios),
        medianImprovement: median(
          pairs.map((p) => pairImprovement({ a: p.baseline, b: p.final }, primary.direction)),
        ),
      };
      if (finalCheck.medianImprovement < minEffect) {
        noHeadline = `the final check improved ${(finalCheck.medianImprovement * 100).toFixed(1)}%, below min_effect ${(minEffect * 100).toFixed(1)}%`;
      }
    } catch (error) {
      if (!(error instanceof WorkloadError) && !(error instanceof MeasurementError)) throw error;
      noHeadline = `the final check failed: ${error.message}`;
    } finally {
      await session.teardown("final_check");
      // Defensive: B is not measured again in this run either way. Every later job resets both
      // arms before it uses them (`resetArms` in decide, `applyToB`), and resume does the same,
      // so a B left at the base SHA by a failure here is never compared against.
      await revertB(open.git);
      await updateRun(context.runDir, (run) => ({ ...run, shas: { ...run.shas, b: finalSha } }));
    }
    await appendLedger(context.runDir, {
      type: EVENTS.finalCheck,
      data: jsonData({
        baselineSha,
        finalSha,
        samples: session.samples,
        commands: [...session.commands],
      }),
    });
  }

  context.setProgress({ done: 1, total: 2, message: "evidence bundle" });
  const events = await readLedger(context.runDir);
  const machine = await collectFingerprint({
    powerSource: () => probePowerSource(options.machine.readers),
    runtimes: () => ({ node: process.versions.node }),
    ...(options.machine.dockerVm === undefined ? {} : { dockerVm: options.machine.dockerVm }),
  });
  const headline =
    finalCheck !== undefined && noHeadline === undefined
      ? formatHeadline(open, finalCheck, machine)
      : undefined;
  const bundle = await assembleBundle(open, events, machine, baselineSha, finalSha);
  const { dir } = await writeBundle(context.runDir, bundle);
  // Redacted like every view (security F13); the raw values stay in the ledger.
  const report: RunReport = redact(
    toJson({
      runId: open.state.runId,
      branch: open.git.branch,
      baselineSha,
      finalSha,
      headline,
      noHeadline,
      finalCheck,
      decisions: summarizeDecisions(events),
      bundleId: bundle.bundleId,
      bundleDir: dir,
      limitations: bundle.limitations,
    }),
  );
  await writeJsonAtomic(path.join(context.runDir, REPORT_FILE), report);
  await appendLedger(context.runDir, {
    type: EVENTS.runFinished,
    data: jsonData({ headline, noHeadline, finalSha, bundleId: bundle.bundleId }),
  });

  // The user's branch must hold every kept commit before the run counts as finished. The status
  // comes before the arms are removed, so a crash in between leaves a finished run with arms on
  // disk (a later start removes them), never a `running` run without arms.
  if (finalSha !== baselineSha) await publishBranch(open.git);
  await updateRun(context.runDir, (run) => ({
    ...run,
    status: "finished",
    shas: { ...run.shas, a: finalSha, b: finalSha },
  }));
  await removeRun(open.git);
  // A job queued while this one ran would wait forever for a worker of a finished run.
  for (const queued of await listJobs(context.runDir)) {
    if (queued.status !== "queued") continue;
    await cancelJob(context.runDir, queued, "the run finished before this job started");
  }
  await releaseMachineLock({ runId: open.state.runId, home: open.home });
  context.exitAfterJob();
  return report;
}

const MAX_BUNDLE_COMMANDS = 256;

async function assembleBundle(
  open: OpenRun,
  events: readonly LedgerEvent[],
  machine: MachineFingerprint,
  baselineSha: string,
  finalSha: string,
): Promise<EvidenceBundle> {
  const baselines = events
    .filter((e) => e.type === EVENTS.baselineMeasured)
    .map((e) => BaselineDataSchema.parse(e.data));
  // A job re-run after a crash records its change again; the latest record wins.
  const changes = [
    ...new Map(startedChanges(events).map((s) => [s.change.changeId, s.change])).values(),
  ];
  const changeIds = new Set(changes.map((c) => c.changeId));
  const decisions = decisionsOf(events).filter((d) => changeIds.has(d.decision.changeId));
  const finals = events
    .filter((e) => e.type === EVENTS.finalCheck)
    .map((e) => e.data as { samples?: unknown[]; commands?: string[] });
  const commands = new Set<string>();
  for (const source of [...baselines, ...decisions, ...finals]) {
    for (const command of source.commands ?? []) commands.add(command);
  }
  const limitations = [...(latestBaseline(events)?.limitations ?? [])];
  if (process.platform === "darwin") {
    limitations.push(
      "macOS: no core pinning or hardware performance counters; samples share the machine with other apps",
    );
  }
  if (decisionsOf(events).length !== decisions.length) {
    limitations.push("decisions made before a diff was recorded are in the run report only");
  }
  const git = await gitVersion();
  return EvidenceBundleSchema.parse({
    schemaVersion: 1,
    bundleId: open.state.bundleId,
    createdAt: new Date().toISOString(),
    objective: open.config.objective,
    machine,
    commands: [...commands].slice(0, MAX_BUNDLE_COMMANDS),
    toolVersions: { node: process.versions.node, ...(git === undefined ? {} : { git }) },
    shas: { baseline: baselineSha, final: finalSha },
    samples: [
      ...baselines.flatMap((b) => b.samples),
      ...decisions.flatMap((d) => d.samples),
      ...finals.flatMap((f) => f.samples ?? []),
    ],
    changes,
    oracleResults: [
      ...baselines.flatMap((b) => b.oracleResults),
      ...decisions.flatMap((d) => d.oracleResults),
    ],
    decisions: decisions.map((d) => d.decision),
    limitations,
    hostAgent: open.state.hostAgent,
    ...(open.state.modelId === undefined
      ? {}
      : { modelId: open.state.modelId, modelIdSource: "self_reported" }),
  });
}
