import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../../src/app/index.js";
import { LockTimeoutError } from "../../../src/core/jobs/index.js";
import { PolicyError, violation } from "../../../src/core/policy/index.js";
import {
  ERROR_PREAMBLE,
  failure,
  MAX_RESULT_BYTES,
  RESULT_PREAMBLE,
  respond,
  success,
  withinBudget,
} from "../../../src/mcp/results.js";

const HOME = os.homedir();

/** structuredContent, checked to be the same JSON as the one text block. */
function body(result: Awaited<ReturnType<typeof respond>>): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  const [text] = result.content as { type: string; text: string }[];
  expect(text?.type).toBe("text");
  const [preamble, json, ...rest] = (text?.text ?? "").split("\n");
  expect(preamble).toBe(result.isError === true ? ERROR_PREAMBLE : RESULT_PREAMBLE);
  expect(rest).toEqual([]);
  expect(JSON.parse(json ?? "")).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

describe("a tool result", () => {
  // M2 B3c: text from the repository can never start the text block's first line, nor any line.
  it("is the workflow's result as structured content, and as a static line and the same JSON", async () => {
    const result = await respond(async () => ({ runId: "run-1", jobId: "job-000001" }));
    expect(result.isError).toBeUndefined();
    expect(body(result)).toEqual({ runId: "run-1", jobId: "job-000001" });
  });

  // M2 decision: arm paths stay absolute for the agent; every other field is redacted.
  it("names the home as ~ everywhere but in the arm paths", () => {
    const arms = {
      a: path.join(HOME, ".ufo/arms/r/run-1/a"),
      b: path.join(HOME, ".ufo/arms/r/run-1/b"),
    };
    const result = body(success({ repoRoot: path.join(HOME, "repo"), arms }));
    expect(result).toEqual({ repoRoot: "~/repo", arms });
  });

  // M2 B2: a failure the model can act on, not a protocol error.
  it("is a failure with code, message, retryable, and hint, marked isError", () => {
    const busy = failure(
      new LockTimeoutError(path.join(HOME, ".ufo/private/runs/r/run-1/control.lock")),
    );
    expect(busy.isError).toBe(true);
    expect(body(busy)).toEqual({
      code: "busy",
      message: "timed out waiting for ~/.ufo/private/runs/r/run-1/control.lock",
      retryable: true,
      hint: "another UFO call is working on this run; try again in a few seconds",
    });
    const unapproved = failure(
      new PolicyError(violation("unapproved_config", "ufo.yaml has not been approved")),
    );
    expect(body(unapproved)).toEqual({
      code: "policy:unapproved_config",
      message: "ufo.yaml has not been approved",
      retryable: false,
    });
  });

  it("turns a thrown workflow error into a failure result", async () => {
    const result = await respond(async () => {
      throw new AppError("no_run", "this repository has no UFO runs");
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ code: "no_run", retryable: false });
  });
});

// M2 B2: every result stays well under the 25 000 tokens a host accepts from one call.
describe("withinBudget", () => {
  it("leaves a small result alone", () => {
    const value = { jobs: [{ jobId: "job-000001", error: "x".repeat(4000) }] };
    expect(withinBudget(value)).toBe(value);
  });

  it("cuts long strings and lists of a large result, keeps the latest entries, and says so", () => {
    const jobs = Array.from({ length: 200 }, (_, i) => ({
      jobId: `job-${String(i + 1).padStart(6, "0")}`,
      error: "e".repeat(4000),
    }));
    const arms = { a: `/${"d".repeat(2000)}/a`, b: `/${"d".repeat(2000)}/b` };
    const fitted = withinBudget({ runId: "run-1", arms, jobs });
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(fitted.arms).toEqual(arms);
    const kept = fitted.jobs as { jobId: string; error: string }[];
    expect(kept.at(-1)?.jobId).toBe("job-000200");
    expect(kept.length).toBeLessThan(200);
    expect(kept[0]?.error.endsWith("…")).toBe(true);
    expect(fitted.truncated).toEqual({ strings: kept.length, items: 200 - kept.length });
  });

  // Code review CR-N3: the budget is in bytes, ordered lists keep their head, and paths stay whole.
  it("counts bytes, keeps the head of ordered lists, and never cuts a path", () => {
    const repoRoot = `/${"r".repeat(3000)}`;
    const values = Array.from({ length: 200 }, (_, i) => ({ name: `metric_${i}`, value: i }));
    // Two bytes a character: under the budget in characters, over it in bytes.
    const notes = Array.from({ length: 4 }, () => "é".repeat(6000));
    const fitted = withinBudget({ repoRoot, values, notes, bundleDir: `/${"b".repeat(3000)}` });
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(JSON.stringify({ notes }).length).toBeLessThan(MAX_RESULT_BYTES);
    expect(fitted.repoRoot).toBe(repoRoot);
    expect(fitted.bundleDir).toBe(`/${"b".repeat(3000)}`);
    expect((fitted.values as { name: string }[])[0]?.name).toBe("metric_0");
    expect((fitted.notes as string[])[0]?.endsWith("…")).toBe(true);
  });
});
