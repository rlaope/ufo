import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppError,
  type DetectedStack,
  DRAFT_CONFIG,
  draftConfigFor,
} from "../../../src/app/index.js";
import { LockTimeoutError } from "../../../src/core/jobs/index.js";
import { PolicyError, violation } from "../../../src/core/policy/index.js";
import {
  heaviestFiles,
  MAX_FILES_SUMMARIZED,
  STACK_FRAMES,
  summarizeProfile,
  TOP_FRAMES,
  TOP_STACKS,
} from "../../../src/core/profile/index.js";
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

  // Code review R7 nit: UFO's draft ufo.yaml goes whole, even past a secret that matches a word
  // in it; any other draftConfig is redacted like every field.
  it("keeps the draft ufo.yaml whole, and only that text", () => {
    process.env.UFO_PROBE_TOKEN = "lower_is_better";
    try {
      expect(body(success({ draftConfig: DRAFT_CONFIG }))).toEqual({ draftConfig: DRAFT_CONFIG });
      expect(body(success({ draftConfig: `${DRAFT_CONFIG}# ${HOME}/x\n` }))).toEqual({
        draftConfig: `${DRAFT_CONFIG.replace("lower_is_better", "<redacted:secret>")}# ~/x\n`,
      });
    } finally {
      delete process.env.UFO_PROBE_TOKEN;
    }
  });

  // M3 P3: the draft built from the detected stacks is exempt, and only when it is the draft for
  // the stacks the same result reports.
  it("keeps the draft built for the stacks it reports, and no other text", () => {
    process.env.UFO_PROBE_TOKEN = "lower_is_better";
    try {
      const stacks: DetectedStack[] = [
        { id: "node", evidence: ["package.json"], suggestions: { testCommand: "npm test" } },
      ];
      const draft = draftConfigFor(stacks);
      expect(body(success({ stacks, draftConfig: draft })).draftConfig).toBe(draft);
      // A draft for other stacks, a draft with a line added, and a draft with no stacks beside
      // it are redacted like any field.
      for (const other of [
        { stacks: [], draftConfig: draft },
        { stacks, draftConfig: `${draft}# extra\n` },
        { draftConfig: draft },
        { stacks: "node", draftConfig: draft },
      ]) {
        expect(body(success(other)).draftConfig).toContain("<redacted:secret>");
      }
    } finally {
      delete process.env.UFO_PROBE_TOKEN;
    }
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

// M4 E3: a profile job with hot spots at every cap still fits in one result, nothing cut.
describe("a profile job's result", () => {
  it("fits within the budget with every list full and every name at its longest", () => {
    // Every frame its own, three bytes a character, so each name is cut to its longest.
    const name = (file: number, line: number, depth: number) =>
      `f${file}.${line}.${depth}${"語".repeat(100)}`;
    const files = Array.from({ length: MAX_FILES_SUMMARIZED + 2 }, (_, file) => {
      const lines = Array.from({ length: TOP_FRAMES + TOP_STACKS }, (_, line) => {
        const stack = Array.from({ length: STACK_FRAMES + 2 }, (_, depth) =>
          name(file, line, depth),
        );
        return `${stack.join(";")} ${1000 + line}`;
      });
      const summary = summarizeProfile(
        `${"語".repeat(200)}.${file}`,
        lines.join("\n"),
        "collapsed",
      );
      return {
        ...summary,
        unit: "microseconds",
        note: "99 of 100 profiles are in another unit and left out",
      };
    });
    const hotspots = {
      format: "speedscope",
      dir: "artifacts/profile-job-000002",
      ...heaviestFiles(files, 99),
    };
    for (const file of hotspots.files) {
      if (!file.valid) throw new Error(file.reason);
      expect(file.self).toHaveLength(TOP_FRAMES);
      expect(file.total).toHaveLength(TOP_FRAMES);
      expect(file.stacks).toHaveLength(TOP_STACKS);
      expect(file.stacks.every((stack) => stack.frames.length === STACK_FRAMES)).toBe(true);
    }
    expect(hotspots.files).toHaveLength(MAX_FILES_SUMMARIZED);
    const at = "2026-10-21T00:00:00.000Z";
    const job = {
      jobId: "job-000002",
      seq: 2,
      kind: "profile",
      input: {},
      status: "succeeded",
      progress: { done: 2, total: 3, message: "sample" },
      result: {
        sha: "0".repeat(40),
        phases: (["setup", "start", "sample", "teardown"] as const).map((phase) => ({
          phase,
          ms: 1_234_567_890,
        })),
        // The primary metric, error_rate, rss_bytes, and 16 reported-only metrics.
        sample: {
          valid: true,
          values: Array.from({ length: 19 }, (_, i) => ({
            name: `m${i}_${"x".repeat(60)}`,
            value: 1.2345678901234568e21,
          })),
        },
        artifact: "artifacts/profile-job-000002.json",
        hotspots,
      },
      workerPid: 4_194_304,
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      finishedAt: at,
    };
    const shown = body(success(job));
    const size = Buffer.byteLength(JSON.stringify(shown));
    expect(size).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(shown).not.toHaveProperty("truncated");
    expect(shown).toEqual(job);
  });
});
