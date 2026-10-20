import { describe, expect, it } from "vitest";
import type { FinishedReport, MeasureResult, RunView } from "../../../src/app/index.js";
import { formatMeasure, formatReport, formatStatus } from "../../../src/cli/format.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A running run's view, as `getRun` returns it. */
function runView(fields: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    status: "running",
    purpose: "run",
    branch: "ufo/run-run-1",
    createdAt: "2026-10-20T00:00:00.000Z",
    arms: { a: "/state/arms/repo/run-1/a", b: "/state/arms/repo/run-1/b" },
    shas: { baseline: SHA, a: SHA },
    worker: { alive: false },
    jobs: [],
    usable: true,
    decisions: [],
    budget: {
      maxTechniques: 10,
      techniquesTried: 0,
      wallClockMinutes: 120,
      elapsedMinutes: 0,
      exhausted: false,
    },
    ...fields,
  };
}

function statusLines(view: RunView): string[] {
  const text = formatStatus({ repoRoot: "/repo", runs: [{ ...view }], current: view });
  return text.split("\n");
}

describe("formatMeasure", () => {
  // M2 A9: the start's warnings are printed with the baseline.
  it("prints the start's warnings", () => {
    const result: MeasureResult = {
      runId: "run-1",
      baseline: { sha: SHA, values: [1, 1, 1, 1, 1], median: 1, oracles: [], limitations: [] },
      warnings: ["the working tree has uncommitted changes; they are not part of the run"],
    };
    expect(formatMeasure(result).split("\n")).toContain(
      "Warning: the working tree has uncommitted changes; they are not part of the run",
    );
  });
});

describe("formatReport", () => {
  // M2 A5: told apart by `finished`, which both kinds of result carry.
  it("prints a finished run's report", () => {
    const report: FinishedReport = {
      finished: true,
      runId: "run-1",
      branch: "ufo/run-run-1",
      baselineSha: SHA,
      finalSha: SHA,
      noHeadline: "no change was kept, so there is nothing to compare",
      decisions: [],
      bundleId: "ufo-run-1",
      bundleDir: "~/.ufo/bundles/ufo-run-1",
      limitations: [],
    };
    expect(formatReport(report)).toBe(
      [
        "Run run-1: 0123456 -> 0123456 on ufo/run-run-1",
        "No headline: no change was kept, so there is nothing to compare",
        "Evidence bundle: ~/.ufo/bundles/ufo-run-1",
        "",
      ].join("\n"),
    );
  });
});

describe("formatStatus", () => {
  // M2 A7: a run that cannot decide anything says so.
  it("says when the run is not usable, and why", () => {
    const reason = "the baseline was refused (policy:noise_floor: noise floor 20.0% exceeds 10.0%)";
    expect(statusLines(runView({ usable: false, unusableReason: reason }))).toContain(
      `  not usable: ${reason}`,
    );
    expect(statusLines(runView()).some((line) => line.includes("not usable"))).toBe(false);
  });
});
