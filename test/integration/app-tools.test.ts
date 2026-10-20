import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelRun,
  checkCapabilities,
  finishRun,
  getJob,
  getRun,
  inspectTarget,
  listTechniques,
  profileTarget,
  startRun,
} from "../../src/app/index.js";
import { approveToy, lightWorkload, makeToy, TIMEOUT_MS, type Toy, waitDone } from "./helpers.js";

// M2 B2: the app workflows behind the MCP tools inspect_target, check_capabilities,
// list_techniques, profile_target, and a get_job wait an MCP client cancels.

let toy: Toy;

beforeAll(async () => {
  toy = makeToy({ config: lightWorkload() });
  await approveToy(toy);
});

afterAll(async () => {
  await toy.cleanup();
});

describe("inspecting the target", { timeout: TIMEOUT_MS }, () => {
  it("reports the stack, the approved ufo.yaml, its objective, cards, and commands", async () => {
    const view = await inspectTarget(toy.context);
    expect(view).toMatchObject({
      repoRoot: toy.repo,
      stack: ["package.json"],
      config: { present: true, valid: true },
      approval: { approved: true },
      objective: { primary: { name: "latency_ms", direction: "lower_is_better" } },
      optIns: [],
    });
    expect(view.cards).toEqual([
      { id: "generic.code-change", known: true },
      { id: "toy.fast-path", known: true },
      { id: "toy.cache-items", known: true },
      { id: "toy.no-delay", known: true },
    ]);
    expect(view.commands).toEqual(
      expect.arrayContaining([
        { what: "workload setup", command: "node --check server.mjs" },
        expect.objectContaining({ what: "workload command" }),
      ]),
    );
  });

  it("says when ufo.yaml is not approved, and when there is none", async () => {
    const other = makeToy({ config: lightWorkload() });
    try {
      expect(await inspectTarget(other.context)).toMatchObject({
        config: { present: true, valid: true },
        approval: {
          approved: false,
          reason: "policy:unapproved_config",
          detail: "ufo.yaml has not been approved; run `ufo approve` in a terminal",
        },
      });
      rmSync(path.join(other.repo, "ufo.yaml"));
      const missing = await inspectTarget(other.context);
      expect(missing).toEqual({
        repoRoot: other.repo,
        stack: ["package.json"],
        config: {
          present: false,
          valid: false,
          error: "config_missing: no ufo.yaml at the repository root; run ufo init",
        },
      });
    } finally {
      await other.cleanup();
    }
  });
});

describe("checking capabilities", { timeout: TIMEOUT_MS }, () => {
  it("finds git, Node.js, and each program the commands start, and runs none of them", async () => {
    const other = makeToy({ config: lightWorkload("touch ran-by-ufo && no-such-program-ufo") });
    try {
      const report = await checkCapabilities(other.context);
      expect(report.git).toMatchObject({
        found: true,
        version: expect.stringMatching(/^\d+\.\d+/),
      });
      expect(report.node).toEqual({ version: process.version });
      // The toy context's docker runner finds no Docker.
      expect(report.docker).toEqual({ found: false, error: "spawn docker ENOENT" });
      expect(report.programs).toEqual([
        expect.objectContaining({ program: "touch", found: true, where: "path" }),
        {
          program: "node",
          found: true,
          where: "path",
          path: expect.stringMatching(/\/node$/),
          // The toy's cards run node too.
          usedBy: expect.arrayContaining(["workload command", "card toy.no-delay reset"]),
        },
      ]);
      expect(report.programs[0]?.usedBy).toEqual(["workload setup"]);
      expect(existsSync(path.join(other.repo, "ran-by-ufo"))).toBe(false);

      const missing = makeToy({ config: lightWorkload("no-such-program-ufo --version") });
      try {
        expect((await checkCapabilities(missing.context)).programs[0]).toEqual({
          program: "no-such-program-ufo",
          found: false,
          hint: "install no-such-program-ufo, or put it on PATH outside the repository and UFO's home",
          usedBy: ["workload setup"],
        });
      } finally {
        await missing.cleanup();
      }
    } finally {
      await other.cleanup();
    }
  });
});

describe("listing techniques", { timeout: TIMEOUT_MS }, () => {
  it("lists every known card with its signals and whether ufo.yaml enables it", async () => {
    const { cards } = await listTechniques(toy.context);
    expect(cards.map((card) => card.id)).toEqual(
      expect.arrayContaining(["generic.code-change", "toy.fast-path", "toy.no-delay"]),
    );
    expect(cards.map((card) => card.id)).toEqual([...cards.map((card) => card.id)].sort());
    const fastPath = cards.find((card) => card.id === "toy.fast-path");
    expect(fastPath).toMatchObject({ domain: "toy", enabled: true, kind: expect.any(String) });
    expect(fastPath?.signals.length).toBeGreaterThan(0);
    const toyOnly = await listTechniques(toy.context, { domain: "toy" });
    expect(toyOnly.cards.length).toBeGreaterThan(0);
    expect(toyOnly.cards.every((card) => card.domain === "toy")).toBe(true);
  });
});

describe("profiling the target", { timeout: TIMEOUT_MS }, () => {
  it("runs the workload once in arm A, times its steps, and counts against nothing", async () => {
    const run = await startRun(toy.context);
    try {
      expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
      const queued = await profileTarget(toy.context, { runId: run.runId });
      const job = await waitDone(toy, run.runId, queued.jobId);
      expect(job.status, job.error?.message).toBe("succeeded");
      const profile = job.result as {
        sha: string;
        phases: { phase: string; ms: number }[];
        sample: unknown;
        artifact: string;
      };
      expect(profile.sha).toBe(run.baseSha);
      expect(profile.phases.map((p) => p.phase)).toEqual(["setup", "sample", "teardown"]);
      expect(profile.phases.every((p) => Number.isInteger(p.ms) && p.ms >= 0)).toBe(true);
      expect(profile.sample).toEqual({ valid: true, line: { latency_ms: 1, error_rate: 0 } });
      const artifact = path.join(toy.runDir(run.runId), profile.artifact);
      expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual(profile);
      const view = await getRun(toy.context, { runId: run.runId });
      expect(view.budget.techniquesTried).toBe(0);
      expect(view.decisions).toEqual([]);

      await finishRun(toy.context, { runId: run.runId });
      await expect(profileTarget(toy.context, { runId: run.runId })).rejects.toMatchObject({
        code: "run_finishing",
      });
    } finally {
      await cancelRun(toy.context, { runId: run.runId }).catch(() => undefined);
    }
  });
});

describe("a get_job wait", { timeout: TIMEOUT_MS }, () => {
  it("ends at once with interrupted when its signal aborts", async () => {
    // The baseline's setup sleeps, so the job stays running with its worker alive.
    const slow = makeToy({ config: lightWorkload("sleep 30") });
    try {
      await approveToy(slow);
      const run = await startRun(slow.context);
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 300);
      await expect(
        getJob(slow.context, {
          runId: run.runId,
          jobId: run.baselineJobId,
          waitS: 25,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "interrupted", message: "the wait was cancelled" });
      expect(Date.now() - started).toBeLessThan(5000);
      await cancelRun(slow.context, { runId: run.runId });
    } finally {
      await slow.cleanup();
    }
  });
});
