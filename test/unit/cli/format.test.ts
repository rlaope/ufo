import { describe, expect, it } from "vitest";
import type { FinishedReport, MeasureResult } from "../../../src/app/index.js";
import { formatMeasure, formatReport } from "../../../src/cli/format.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

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
