import type {
  ApproveResult,
  CancelResult,
  MeasureResult,
  ResumeResult,
  RunReport,
  RunView,
  StatusView,
} from "../app/index.js";

// Human-readable output of each command. `--json` prints the result objects instead.

const short = (sha: string | undefined) => (sha === undefined ? "-" : sha.slice(0, 7));
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
    `  arm A: ${view.arms.a}`,
    `  arm B: ${view.arms.b}`,
    `  worker: ${view.worker.alive ? `running (pid ${view.worker.pid})` : "not running"}`,
    `  budget: ${view.budget.techniquesTried} of ${view.budget.maxTechniques} techniques, ${view.budget.elapsedMinutes} of ${view.budget.wallClockMinutes} min${view.budget.exhausted ? " (exhausted: run ufo extend-budget)" : ""}`,
  ];
  if (view.baseline !== undefined) {
    const floor = view.baseline.noiseFloor;
    lines.push(
      `  baseline median ${view.baseline.median}, noise floor ${floor === undefined ? "unknown" : percent(floor)}`,
    );
  }
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
  const lines = result.runs.map((run) => `${run.runId}  ${run.status}  ${run.createdAt}`);
  if (result.lock !== undefined) {
    lines.push(
      `Machine lock: run ${result.lock.runId}${result.lock.thisRepository ? "" : " (another repository)"}`,
    );
  }
  if (result.current !== undefined) lines.push("", ...formatView(result.current));
  return `${lines.join("\n")}\n`;
}

export function formatReport(result: RunReport | (RunView & { finished: false })): string {
  if ("finished" in result) {
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
