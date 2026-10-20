import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finishRun,
  getJob,
  getRun,
  JOB_KINDS,
  type RunReport,
  report,
  resumeRun,
  runRecipes,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { enqueueJob, readJob, readRun } from "../../src/core/jobs/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  expectKeep,
  git,
  gitDirListing,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  userState,
  waitDone,
} from "./helpers.js";

// The positive control (AC 16) on a dirty user tree (AC 6), exported with planted secrets
// (AC 10): removing the injected 20 ms sleep is kept as one commit, and finish_run publishes a
// headline from a fresh final check, after which the run is finished with B at the final SHA
// and takes no more changes (condition b).

const FAKE_KEY = `sk-proj-${"A1b2C3d4".repeat(6)}`;

let toy: Toy;

beforeAll(() => {
  toy = makeToy();
});

afterAll(async () => {
  await toy.cleanup();
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("positive control", { timeout: TIMEOUT_MS }, () => {
  it("keeps the sleep removal, publishes a headline, and leaves the user's tree untouched", async () => {
    // Uncommitted work in the user's tree: an edit, a staged file, an untracked file.
    writeFileSync(path.join(toy.repo, "server.mjs"), "// work in progress\n", { flag: "a" });
    writeFileSync(path.join(toy.repo, "toy.properties"), "items.extra_delay_ms=9\n");
    git(toy.repo, "add", "toy.properties");
    writeFileSync(path.join(toy.repo, "notes.txt"), "untracked notes\n");
    const before = userState(toy.repo);
    expect(before.status.split("\n")).toEqual(
      expect.arrayContaining([" M server.mjs", "M  toy.properties", "?? notes.txt"]),
    );
    expect(before.untracked).toEqual({ "notes.txt": "untracked notes\n" });
    const gitDirBefore = gitDirListing(toy.repo);

    await approveToy(toy);
    const run = await startRun(toy.context, { hostAgent: "claude-code", modelId: "test-model-1" });
    expect(run.userTreeDirty).toBe(true);
    expect(run.warnings.join(" ")).toContain("uncommitted changes");
    expect(run.branch).toBe(`ufo/run-${run.runId}`);
    // Run state lives in the trusted private root, the arms beside it; neither in the repo.
    const stateDir = path.join(toy.home, "private", "runs", toy.repoId, run.runId);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(stateDir, "run.json")).mode & 0o777).toBe(0o600);
    expect(run.arms.a).toBe(path.join(toy.home, "arms", toy.repoId, run.runId, "a"));
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");

    const diff = diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", ""));
    const hypothesis = [
      "The handler awaits sleep(20) on every request; removing it cuts latency.",
      `Found while profiling with OPENAI_API_KEY=${FAKE_KEY} under ${os.homedir()}/projects/toy.`,
    ].join("\n");
    const queued = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff,
      hypothesis,
    });
    const kept = await waitDone(toy, run.runId, queued.jobId);
    expectKeep(decisionOf(kept), kept);

    // One commit on the run branch with all four trailers.
    const log = git(toy.repo, "log", "--format=%H%x00%B%x00", `${run.baseSha}..${run.branch}`);
    const commits = log.split("\0\n").filter((entry) => entry.trim() !== "");
    expect(commits).toHaveLength(1);
    const trailers = git(toy.repo, "log", "-1", "--format=%(trailers:only,unfold)", run.branch);
    expect(trailers).toContain("Ufo-Technique: toy.fast-path");
    expect(trailers).toMatch(/Ufo-Metric: latency_ms [\d.]+ -> [\d.]+ \(-\d+\.\d%\)/);
    expect(trailers).toContain(`Ufo-Bundle: ufo-${run.runId}`);
    expect(trailers).toContain(`Ufo-Change-Id: ${queued.changeId}`);
    expect(git(toy.repo, "log", "-1", "--format=%an <%ae>", run.branch).trim()).toBe(
      "Test <test@example.invalid>",
    );

    const finish = await finishRun(toy.context, { runId: run.runId });
    // Condition (b): once the finish job is queued the run takes no more work...
    const more = { runId: run.runId, cardId: "toy.fast-path", diff, hypothesis: "Once more." };
    await expect(submitChange(toy.context, more)).rejects.toMatchObject({
      code: "run_finishing",
      message: expect.stringContaining("finishing"),
    });
    await expect(runRecipes(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "run_finishing",
    });
    await expect(finishRun(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "run_finishing",
    });
    // ...and a change that slipped into the queue anyway is cancelled, never run against B.
    const runDir = toy.runDir(run.runId);
    const stray = await enqueueJob(runDir, {
      kind: JOB_KINDS.change,
      input: {
        changeId: randomUUID(),
        cardId: more.cardId,
        hypothesis: more.hypothesis,
        source: "agent",
        diff,
      },
    });
    // run.json names B's position while the final check holds it at the base SHA.
    const bPositions = new Set<string | undefined>();
    for (;;) {
      bPositions.add((await readRun(runDir)).shas.b);
      if ((await getJob(toy.context, { runId: run.runId, jobId: finish.jobId })).finishedAt) break;
      await delay(20);
    }
    expect(bPositions).toContain(run.baseSha);
    const finished = await waitDone(toy, run.runId, finish.jobId);
    expect(finished.status).toBe("succeeded");
    const finalSha = git(toy.repo, "rev-parse", run.branch).trim();
    expect(await readRun(runDir)).toMatchObject({
      status: "finished",
      shas: { baseline: run.baseSha, a: finalSha, b: finalSha },
    });
    expect(await readJob(runDir, stray.jobId)).toMatchObject({
      status: "cancelled",
      error: { message: "the run finished before this job started" },
    });
    await expect(submitChange(toy.context, more)).rejects.toMatchObject({
      code: "run_not_active",
      message: expect.stringContaining("finished"),
    });
    await expect(resumeRun(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "run_not_active",
    });
    expect(git(toy.repo, "rev-parse", run.branch).trim()).toBe(finalSha);
    const result = (await report(toy.context, { runId: run.runId })) as RunReport;
    expect(result.headline).toMatch(
      /^toy-http GET \/items, 15 sequential requests on loopback: latency_ms [\d.]+ → [\d.]+ ms \([\d.]+×, range [\d.]+×–[\d.]+×, 5 pairs, .+, claude-code \+ test-model-1 \(self-reported\)\)$/,
    );
    expect(result.finalCheck?.medianImprovement).toBeGreaterThan(0.3);
    expect(result.finalCheck?.pairs).toHaveLength(5);
    expect(result.decisions).toMatchObject([{ outcome: "keep", cardId: "toy.fast-path" }]);

    // AC 10: the exported bundle has neither the planted key nor the home path.
    const bundleFiles = filesUnder(result.bundleDir);
    expect(bundleFiles.map((f) => path.basename(f)).sort()).toEqual(
      ["bundle.json", `${queued.changeId}.diff`, "manifest.json"].sort(),
    );
    for (const file of bundleFiles) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(os.homedir());
    }
    const bundle = JSON.parse(readFileSync(path.join(result.bundleDir, "bundle.json"), "utf8"));
    expect(bundle).toMatchObject({
      hostAgent: "claude-code",
      modelId: "test-model-1",
      modelIdSource: "self_reported",
      shas: { baseline: run.baseSha },
    });
    expect(bundle.changes[0].hypothesis).toContain("<redacted:");
    expect(bundle.samples.filter((s: { phase: string }) => s.phase === "final_check")).toHaveLength(
      10,
    );
    expect(bundle.commands).toContain("node bench/latency.mjs");

    // The run is finished: lock released, arms gone, the branch stays for review.
    const view = await getRun(toy.context, { runId: run.runId });
    expect(view.status).toBe("finished");
    expect(view.headline).toBe(result.headline);
    expect(git(toy.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(readdirSync(path.join(toy.home, "private"))).not.toContain("lock");
    expect(existsSync(path.dirname(run.arms.a))).toBe(false);

    // AC 6: the user's HEAD, branch, and porcelain status are exactly as before, and the git
    // directory gained only the run branch and its objects: no worktree admin data, no
    // FETCH_HEAD, no config, no run state.
    expect(userState(toy.repo)).toEqual(before);
    expect(existsSync(path.join(toy.repo, ".git", "worktrees"))).toBe(false);
    expect(existsSync(path.join(toy.repo, ".git", "ufo"))).toBe(false);
    expect(gitDirListing(toy.repo)).toEqual(gitDirBefore);
    expect(readFileSync(path.join(toy.repo, "server.mjs"), "utf8")).toContain("work in progress");
  });
});
