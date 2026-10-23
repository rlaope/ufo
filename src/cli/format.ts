import os from "node:os";
import path from "node:path";
import type {
  CancelResult,
  MeasureResult,
  ReportResult,
  ResumeResult,
  RunReport,
  RunView,
  StatusView,
} from "../app/api.js";
import type { ApproveResult, DoctorReport } from "../app/api-cli.js";

// Human-readable output of each command. `--json` prints the result objects instead.

const short = (sha: string | undefined) => (sha === undefined ? "-" : sha.slice(0, 7));

/** An absolute local path with your home directory as `~`, as the rest of the output names it. */
function tilde(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`)
    ? `~${file.slice(home.length)}`
    : file;
}
const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

export function formatApprove(result: ApproveResult): string {
  const optIns = result.optIns.length > 0 ? result.optIns.join(", ") : "none";
  return `Approved ufo.yaml (sha256 ${result.configHash}) and ${result.cards.length} enabled cards (digest ${result.digest}); opt-ins: ${optIns}.\n`;
}

export function formatMeasure(result: MeasureResult): string {
  const { baseline } = result;
  const lines = [
    `Baseline at ${short(baseline.sha)}: median ${baseline.median} over ${baseline.values.length} samples (${baseline.values.join(", ")})`,
    `Noise floor: ${baseline.noiseFloor === undefined ? "unknown" : percent(baseline.noiseFloor)}`,
  ];
  if (baseline.refusal !== undefined) {
    lines.push(`Refusal: ${baseline.refusal.reason}: ${baseline.refusal.detail}`);
  }
  for (const oracle of baseline.oracles) {
    lines.push(
      `Oracle ${oracle.oracle}: ${oracle.passed ? "passed" : "failed"}${oracle.summary ? ` (${oracle.summary})` : ""}`,
    );
  }
  for (const limitation of baseline.limitations) lines.push(`Limitation: ${limitation}`);
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function decisionLines(decisions: RunReport["decisions"]): string[] {
  return decisions.map((d) => {
    const effect = d.effect === undefined ? "" : ` ${d.effect >= 0 ? "+" : ""}${percent(d.effect)}`;
    const why = d.reason === undefined ? "" : ` ${d.reason}`;
    const commit = d.commit === undefined ? "" : ` -> ${short(d.commit)}`;
    const detail = d.detail === undefined ? "" : `: ${d.detail}`;
    return `  ${d.cardId} ${d.outcome}${why}${effect}${commit}${detail}`;
  });
}

function formatView(view: RunView): string[] {
  const lines = [
    `Run ${view.runId} (${view.purpose}): ${view.status}, branch ${view.branch}`,
    `  baseline ${short(view.shas.baseline)}, arm A at ${short(view.shas.a)}`,
    `  arm A: ${tilde(view.arms.a)}`,
    `  arm B: ${tilde(view.arms.b)}`,
    `  worker: ${view.worker.alive ? `running (pid ${view.worker.pid})` : "not running"}`,
    `  budget: ${view.budget.techniquesTried} of ${view.budget.maxTechniques} techniques, ${view.budget.elapsedMinutes} of ${view.budget.wallClockMinutes} min${view.budget.exhausted ? " (exhausted: run ufo extend-budget)" : ""}`,
  ];
  if (view.baseline !== undefined) {
    const floor = view.baseline.noiseFloor;
    lines.push(
      `  baseline median ${view.baseline.median}, noise floor ${floor === undefined ? "unknown" : percent(floor)}`,
    );
  }
  if (!view.usable) lines.push(`  not usable: ${view.unusableReason ?? "unknown"}`);
  for (const job of view.jobs) {
    lines.push(
      `  ${job.jobId} ${job.kind}: ${job.status}${job.progress ? ` (${job.progress})` : ""}${job.error ? `: ${job.error}` : ""}`,
    );
  }
  if (view.decisions.length > 0)
    lines.push("  decisions:", ...decisionLines(view.decisions).map((l) => `  ${l}`));
  if (view.headline !== undefined) lines.push(`  headline: ${view.headline}`);
  return lines;
}

export function formatStatus(result: StatusView): string {
  if (result.runs.length === 0) return "No UFO runs in this repository.\n";
  const lines = result.runs.map(
    (run) =>
      `${run.runId}  ${run.status}  ${run.createdAt}${run.workTree === undefined ? "" : `  (work tree ${run.workTree})`}`,
  );
  if (result.lock !== undefined) {
    lines.push(
      `Machine lock: run ${result.lock.runId}${result.lock.thisRepository ? "" : " (another repository)"}`,
    );
  }
  if (result.current !== undefined) lines.push("", ...formatView(result.current));
  if (result.note !== undefined) lines.push("", result.note);
  return `${lines.join("\n")}\n`;
}

export function formatReport(result: ReportResult): string {
  if (!result.finished) {
    const first =
      result.status === "running"
        ? "Run not finished yet."
        : `Run ${result.runId} is ${result.status}; it has no report.`;
    return `${[first, ...formatView(result)].join("\n")}\n`;
  }
  const lines = [
    `Run ${result.runId}: ${short(result.baselineSha)} -> ${short(result.finalSha)} on ${result.branch}`,
    result.headline === undefined
      ? `No headline: ${result.noHeadline ?? "unknown"}`
      : result.headline,
  ];
  if (result.decisions.length > 0) lines.push("Decisions:", ...decisionLines(result.decisions));
  lines.push(`Evidence bundle: ${result.bundleDir}`);
  for (const limitation of result.limitations) lines.push(`Limitation: ${limitation}`);
  return `${lines.join("\n")}\n`;
}

export function formatResume(result: ResumeResult): string {
  return `${[
    `Resumed run ${result.runId}; arms reset to ${short(result.armSha)}.`,
    `  requeued: ${result.requeued.join(", ") || "none"}; failed: ${result.failed.join(", ") || "none"}`,
    `  ledger entries recovered from commits: ${result.reconciled.join(", ") || "none"}`,
    `  worker: ${result.workerPid === undefined ? "not needed (no queued jobs)" : `pid ${result.workerPid}`}`,
  ].join("\n")}\n`;
}

export function formatCancel(result: CancelResult): string {
  const { containers } = result.processes;
  const docker = containers.dockerAvailable
    ? `removed ${containers.removed.length} containers`
    : `Docker not available (${containers.error ?? "not found"}); no containers to remove`;
  return `${[
    `Cancelled run ${result.runId}.`,
    `  cancelled jobs: ${result.cancelledJobs.join(", ") || "none"}`,
    `  processes stopped: ${result.processes.terminated.length + result.processes.killed.length}; ${docker}`,
    `  observations kept: ${result.observationsKept} ledger events`,
  ].join("\n")}\n`;
}

export function formatExtend(result: {
  runId: string;
  maxTechniques: number;
  wallClockMinutes: number;
}): string {
  return `Run ${result.runId}: budget raised to ${result.maxTechniques} techniques, ${result.wallClockMinutes} min.\n`;
}

export function formatDoctor(report: DoctorReport): string {
  const from = {
    "ufo.yaml": "tools from ufo.yaml",
    draft: "tools from the draft ufo init writes",
    none: "",
  }[report.source];
  const stacks = report.stacks.length > 0 ? report.stacks.join(", ") : "none detected";
  const lines = [
    report.repoRoot === undefined
      ? "ufo doctor: no repository"
      : `ufo doctor: ${report.repoRoot} (stacks: ${stacks}; ${from})`,
  ];
  for (const found of report.found) {
    const version = found.version === undefined ? "" : ` ${found.version}`;
    const where = found.path === undefined ? "" : ` (${found.path})`;
    lines.push(`  ok   ${found.tool}${version}${where}: ${found.neededBy.join("; ")}`);
  }
  for (const gap of report.gaps) {
    lines.push(
      `  gap  ${gap.tool}: ${gap.problem}`,
      `         needed by: ${gap.neededBy.join("; ")}`,
      `         fix: ${gap.hint}`,
    );
  }
  const count = report.gaps.length;
  lines.push(count === 0 ? "No gaps." : `${count} gap${count === 1 ? "" : "s"}.`);
  return `${lines.join("\n")}\n`;
}
