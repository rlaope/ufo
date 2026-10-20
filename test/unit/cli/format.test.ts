import { describe, expect, it } from "vitest";
import type { MeasureResult } from "../../../src/app/index.js";
import { formatMeasure } from "../../../src/cli/format.js";

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
