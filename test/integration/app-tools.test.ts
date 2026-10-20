import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelRun,
  checkCapabilities,
  DRAFT_CONFIG,
  finishRun,
  getJob,
  getRun,
  inspectTarget,
  JOB_KINDS,
  listTechniques,
  profileTarget,
  readAppState,
  resolveRepo,
  startRun,
  status,
} from "../../src/app/index.js";
import { ensureWorker } from "../../src/app/launch.js";
import { enqueueJob, readRun, updateRun } from "../../src/core/jobs/index.js";
import {
  approveToy,
  git,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

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

// Code review R4: a caller that pinned the repository (ufo mcp) gets its workflows acting on that
// one resolution, wherever its working directory is.
describe("a pinned repository", { timeout: TIMEOUT_MS }, () => {
  it("is the one the workflows act on", async () => {
    const pinned = { ...toy.context, cwd: os.tmpdir(), repo: await resolveRepo(toy.repo) };
    expect((await inspectTarget(pinned)).repoRoot).toBe(toy.repo);
    expect((await status(pinned)).repoRoot).toBe(toy.repo);
  });
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
          detail:
            "ufo.yaml has not been approved; a person must run `ufo approve` in their own terminal; an agent must not run it",
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
        // Code review R7: the draft to fill in, since the agent may have no ufo on its PATH.
        draftConfig: DRAFT_CONFIG,
      });
      writeFileSync(path.join(other.repo, "ufo.yaml"), "version: [\n");
      const invalid = await inspectTarget(other.context);
      expect(invalid.config).toMatchObject({ present: true, valid: false });
      expect(invalid).not.toHaveProperty("draftConfig");
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
      expect(report.docker).toEqual({ found: false, error: "not installed (not on PATH)" });
      // Code review CR-N9: installed but its daemon stopped, and running.
      const stopped = {
        ...other.context,
        exec: async () => {
          throw Object.assign(new Error("Command failed: docker version"), {
            code: 1,
            stderr: "\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.\nmore\n",
          });
        },
      };
      expect((await checkCapabilities(stopped)).docker).toEqual({
        found: true,
        reachable: false,
        error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      });
      const running = { ...other.context, exec: async () => ({ stdout: "29.7.2\n" }) };
      expect((await checkCapabilities(running)).docker).toEqual({
        found: true,
        reachable: true,
        version: "29.7.2",
      });
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

      // Security N4: a relative path that leaves the repository is not looked up, even when a
      // file is there.
      const escaping = makeToy({ config: lightWorkload("../escape/tool --version") });
      try {
        mkdirSync(path.join(escaping.root, "escape"));
        writeFileSync(path.join(escaping.root, "escape", "tool"), "#!/bin/sh\n");
        expect((await checkCapabilities(escaping.context)).programs[0]).toMatchObject({
          program: "../escape/tool",
          found: false,
          where: "outside_repository",
        });
      } finally {
        await escaping.cleanup();
      }

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

const FAKE_KEY = `sk-proj-${"Z9y8X7w6".repeat(6)}`;

// M2 B3d: these views reach an agent's model provider, so they go through the redactor too.
describe("the views behind the read-only tools", { timeout: TIMEOUT_MS }, () => {
  it("name the home as ~ and replace secrets", async () => {
    const other = makeToy({
      config: (yaml) => `${lightWorkload(`mytool --key ${FAKE_KEY}`)(yaml)}cardDirs:\n  - cards\n`,
    });
    try {
      // A card of the repository whose text carries the key.
      mkdirSync(path.join(other.repo, "cards", "secret"), { recursive: true });
      writeFileSync(
        path.join(other.repo, "cards", "secret", "leak.yaml"),
        [
          "id: secret.leak",
          "domain: secret",
          "title: A card that quotes a key",
          "kind: guided",
          "riskClass: lossless",
          "signals:",
          `  - the profile shows ${FAKE_KEY} in every request`,
          "verifiedIn: unverified",
          "",
        ].join("\n"),
      );
      // A program under the home, on the PATH the commands get.
      const bin = path.join(other.root, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "mytool"), "#!/bin/sh\n");
      chmodSync(path.join(bin, "mytool"), 0o755);
      const context = {
        ...other.context,
        workerEnv: {
          ...other.context.workerEnv,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        },
      };
      const homedir = vi.spyOn(os, "homedir").mockReturnValue(other.root);
      try {
        const inspected = await inspectTarget(context);
        expect(inspected.repoRoot).toBe("~/repo");
        expect(inspected.commands).toContainEqual({
          what: "workload setup",
          command: "mytool --key <redacted:api_key>",
        });
        const capabilities = await checkCapabilities(context);
        expect(capabilities.programs[0]).toMatchObject({
          program: "mytool",
          found: true,
          path: "~/bin/mytool",
        });
        const listed = await listTechniques(context, { domain: "secret" });
        expect(listed.cards[0]?.signals).toEqual([
          "the profile shows <redacted:api_key> in every request",
        ]);
        for (const view of [inspected, capabilities, listed]) {
          expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
          expect(JSON.stringify(view)).not.toContain(other.root);
        }
      } finally {
        homedir.mockRestore();
      }
    } finally {
      await other.cleanup();
    }
  });
});

describe("profiling the target", { timeout: TIMEOUT_MS }, () => {
  it("runs the workload once in arm A, times its steps, and is no technique but wall clock", async () => {
    const run = await startRun(toy.context);
    try {
      expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
      // Something wrote into arm A since its last job: the profile measures A at its commit.
      writeFileSync(path.join(run.arms.a, "server.mjs"), "// written into the arm\n", {
        flag: "a",
      });
      const queued = await profileTarget(toy.context, { runId: run.runId });
      const job = await waitDone(toy, run.runId, queued.jobId);
      expect(job.status, job.error?.message).toBe("succeeded");
      expect(git(run.arms.a, "status", "--porcelain")).toBe("");
      const profile = job.result as {
        sha: string;
        phases: { phase: string; ms: number }[];
        sample: unknown;
        artifact: string;
      };
      expect(profile.sha).toBe(run.baseSha);
      expect(profile.phases.map((p) => p.phase)).toEqual(["setup", "sample", "teardown"]);
      expect(profile.phases.every((p) => Number.isInteger(p.ms) && p.ms >= 0)).toBe(true);
      expect(profile.sample).toEqual({
        valid: true,
        values: [
          { name: "latency_ms", value: 1 },
          { name: "error_rate", value: 0 },
        ],
      });
      const artifact = path.join(toy.runDir(run.runId), profile.artifact);
      expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual(profile);
      const view = await getRun(toy.context, { runId: run.runId });
      expect(view.budget.techniquesTried).toBe(0);
      expect(view.decisions).toEqual([]);

      // Security N2: no technique, but only within the run's wall-clock budget (30 min here).
      const started = (await readRun(toy.runDir(run.runId))).createdAt;
      await updateRun(toy.runDir(run.runId), (record) => ({
        ...record,
        createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }));
      await expect(profileTarget(toy.context, { runId: run.runId })).rejects.toMatchObject({
        violation: { rule: "budget_exceeded", detail: "31 of 30 minutes used" },
      });
      // Security S2-4: and one queued before the clock ran out (the queue looks the same) is
      // refused when it starts.
      const runDir = toy.runDir(run.runId);
      const late = await enqueueJob(runDir, { kind: JOB_KINDS.profile, input: {} });
      await ensureWorker(toy.context, runDir, toy.home, await readAppState(runDir));
      expect(await waitDone(toy, run.runId, late.jobId)).toMatchObject({
        status: "failed",
        error: { message: "policy:budget_exceeded: 31 of 30 minutes used" },
      });
      await updateRun(toy.runDir(run.runId), (record) => ({ ...record, createdAt: started }));

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
