import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelRun,
  finishRun,
  getRun,
  resumeRun,
  startRun,
  status,
  submitChange,
} from "../../src/app/index.js";
import { runLayout } from "../../src/core/git/index.js";
import {
  acquireMachineLock,
  createRunState,
  listJobs,
  readLedger,
  readMachineLock,
  readProcessStartTime,
  readRun,
  releaseMachineLock,
  updateRun,
} from "../../src/core/jobs/index.js";
import { newRunId } from "../../src/core/paths.js";
import { killRunProcesses, requestCancel } from "../../src/worker/index.js";
import {
  approveToy,
  diffOf,
  dockerAbsent,
  git,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// Code review #1: a run must always be closable. Cancel and finish write the run's final status
// before they remove its arms, a run whose arms are gone is refused by resume and ended by
// cancel, a cancel cut short is finished by cancelling again, and the next start removes the
// arms an ended run left on disk.

let toy: Toy;

beforeEach(async () => {
  toy = makeToy({ config: lightWorkload() });
  await approveToy(toy);
});

afterEach(async () => {
  await toy.cleanup();
});

async function startedRun() {
  const run = await startRun(toy.context);
  expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
  return run;
}

describe("closing a run after an interruption", { timeout: TIMEOUT_MS }, () => {
  it("refuses to resume a run whose arms are gone, and cancel still ends it", async () => {
    const run = await startedRun();
    await rm(path.dirname(run.arms.a), { recursive: true, force: true });

    await expect(resumeRun(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "arms_missing",
    });
    await cancelRun(toy.context, { runId: run.runId });
    expect((await readRun(toy.runDir(run.runId))).status).toBe("cancelled");
    expect(await readMachineLock({ home: toy.home })).toBeUndefined();
  });

  it("refuses to resume after a cancel that did not complete, and cancelling again ends it", async () => {
    const run = await startedRun();
    // The cancel was requested and then interrupted before it recorded anything.
    await requestCancel(toy.runDir(run.runId));
    await killRunProcesses(toy.runDir(run.runId), { exec: dockerAbsent, graceMs: 500 });

    await expect(resumeRun(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "cancel_pending",
    });
    await cancelRun(toy.context, { runId: run.runId });
    expect((await readRun(toy.runDir(run.runId))).status).toBe("cancelled");
    expect(existsSync(run.arms.a)).toBe(false);
    expect(existsSync(run.arms.b)).toBe(false);
  });

  it("removes the arms an ended run left behind when the next run starts", async () => {
    const first = await startedRun();
    // A crash right after the status was written: the arms and the machine lock are still there.
    await killRunProcesses(toy.runDir(first.runId), { exec: dockerAbsent, graceMs: 500 });
    await updateRun(toy.runDir(first.runId), (record) => ({ ...record, status: "cancelled" }));
    expect(existsSync(first.arms.a)).toBe(true);

    const second = await startedRun();
    expect(existsSync(path.dirname(first.arms.a))).toBe(false);
    expect(existsSync(second.arms.a)).toBe(true);
    await cancelRun(toy.context, { runId: second.runId });
  });
});

// Code review #3: a job queued for a worker that cannot start is cancelled, not left queued.
describe("queueing work no worker can take", { timeout: TIMEOUT_MS }, () => {
  it("cancels the queued job when another run holds the machine lock", async () => {
    const run = await startedRun();
    const runDir = toy.runDir(run.runId);
    // The worker is gone and another run took the machine lock meanwhile.
    await killRunProcesses(runDir, { exec: dockerAbsent, graceMs: 500 });
    expect(await releaseMachineLock({ runId: run.runId, home: toy.home })).toBe(true);
    const other = newRunId();
    expect(
      (await acquireMachineLock({ home: toy.home, runId: other, repoId: toy.repoId })).acquired,
    ).toBe(true);

    const change = {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      hypothesis: "Removing the sleep cuts latency.",
    };
    await expect(submitChange(toy.context, change)).rejects.toMatchObject({
      code: "run_in_progress",
    });
    await expect(finishRun(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "run_in_progress",
    });
    const jobs = await listJobs(runDir);
    expect(jobs.filter((job) => job.status === "queued")).toEqual([]);
    expect(jobs.filter((job) => job.kind !== "baseline").map((job) => job.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect((await getRun(toy.context, { runId: run.runId })).budget.techniquesTried).toBe(0);

    // Once the other run lets go, the cancelled finish job does not block the run.
    expect(await releaseMachineLock({ runId: other, home: toy.home })).toBe(true);
    const queued = await submitChange(toy.context, change);
    expect(queued.jobId).toMatch(/^job-/);
    await cancelRun(toy.context, { runId: run.runId });
  });
});

// Code review (round 2) HIGH: a start cut short between creating the run state and writing its app
// state leaves a `running` run without app state, holding the machine lock. It must not block
// the repository: a later start or a cancel ends it, and the views say what to do.
describe("a start cut short", { timeout: TIMEOUT_MS }, () => {
  /** Run state as a start leaves it when its process dies right after creating it. */
  async function cutShortStart(starter: { pid: number; startTime: string }) {
    const runId = newRunId();
    const { runDir } = await createRunState(toy.home, { runId, repoId: toy.repoId });
    await updateRun(runDir, (record) => ({ ...record, starter }));
    expect((await acquireMachineLock({ home: toy.home, runId, repoId: toy.repoId })).acquired).toBe(
      true,
    );
    const branch = `ufo/run-${runId}`;
    git(toy.repo, "branch", branch);
    const arms = path.dirname(runLayout(toy.home, toy.repoId, runId).armA);
    mkdirSync(path.join(arms, "a"), { recursive: true });
    return { runId, runDir, branch, arms };
  }

  async function deadStarter() {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    return { pid: child.pid as number, startTime: "Thu Jan  1 00:00:00 1970" };
  }

  it("is ended by the next start, and the views say what to do meanwhile", async () => {
    const left = await cutShortStart(await deadStarter());
    const view = await status(toy.context);
    expect(view.runs.map((r) => r.runId)).toContain(left.runId);
    await expect(getRun(toy.context, { runId: left.runId })).rejects.toMatchObject({
      code: "run_in_progress",
      message: expect.stringContaining("did not finish starting; cancel it to end it"),
    });

    const run = await startRun(toy.context);
    expect(run.warnings).toEqual([]);
    expect((await readRun(left.runDir)).status).toBe("failed");
    expect(git(toy.repo, "branch", "--list", left.branch).trim()).toBe("");
    expect(existsSync(left.arms)).toBe(false);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    await cancelRun(toy.context, { runId: run.runId });
  });

  it("is ended by cancel, which releases the machine lock", async () => {
    const left = await cutShortStart(await deadStarter());
    await cancelRun(toy.context, { runId: left.runId });
    expect((await readRun(left.runDir)).status).toBe("failed");
    expect(await readMachineLock({ home: toy.home })).toBeUndefined();
    expect(existsSync(left.arms)).toBe(false);
  });

  it("is ended once when two cancels race for it", async () => {
    const left = await cutShortStart(await deadStarter());
    const results = await Promise.allSettled([
      cancelRun(toy.context, { runId: left.runId }),
      cancelRun(toy.context, { runId: left.runId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "run_not_active" });
    const events = await readLedger(left.runDir);
    expect(events.filter((e) => e.type === "start_abandoned")).toHaveLength(1);
    expect((await readRun(left.runDir)).status).toBe("failed");
  });

  // M2 A3, A9: a start in progress is `run_starting` (try again shortly) for calls on it, never
  // advice to cancel or resume it. Another start is `run_in_progress` (code review, step A, #2):
  // trying again once this one started would be refused all the same.
  it("is left alone while its starter still runs", async () => {
    const startTime = await readProcessStartTime(process.pid);
    expect(startTime).toBeDefined();
    const left = await cutShortStart({ pid: process.pid, startTime: startTime as string });
    const starting = { code: "run_starting", message: `run ${left.runId} is still starting` };
    await expect(cancelRun(toy.context, { runId: left.runId })).rejects.toMatchObject(starting);
    await expect(getRun(toy.context, { runId: left.runId })).rejects.toMatchObject(starting);
    await expect(finishRun(toy.context, { runId: left.runId })).rejects.toMatchObject(starting);
    await expect(startRun(toy.context)).rejects.toMatchObject({
      code: "run_in_progress",
      message: `run ${left.runId} of this repository is still starting`,
    });
    // Clean up as the starter would have on failure.
    await updateRun(left.runDir, (record) => ({ ...record, status: "failed" }));
    await releaseMachineLock({ home: toy.home, runId: left.runId });
  });

  // M2 A9: a start cut short that the next start's cleanup cannot end refuses that start, saying
  // how to end it and why the cleanup failed.
  it("refuses the next start with the cleanup's warning when the cleanup cannot end it", async () => {
    const left = await cutShortStart(await deadStarter());
    const parent = path.dirname(left.arms);
    chmodSync(parent, 0o500);
    try {
      const refused = startRun(toy.context);
      await expect(refused).rejects.toMatchObject({
        code: "run_in_progress",
        message: expect.stringMatching(
          new RegExp(
            `^run ${left.runId} of this repository did not finish starting; end it with \`ufo cancel --run ${left.runId}\` \\(could not clean up run ${left.runId}: .+\\)$`,
          ),
        ),
      });
      expect((await readRun(left.runDir)).status).toBe("running");
    } finally {
      chmodSync(parent, 0o700);
    }
    await cancelRun(toy.context, { runId: left.runId });
    expect((await readRun(left.runDir)).status).toBe("failed");
  });
});

// Code review (round 2) #3: once a run's final status is written, a failure to remove its arms
// does not fail the command; it is recorded and the next start removes them.
describe("arms that cannot be removed yet", { timeout: TIMEOUT_MS }, () => {
  it("leave cancel successful, are recorded, and are removed by the next start", async () => {
    const run = await startedRun();
    const parent = path.dirname(path.dirname(run.arms.a));
    chmodSync(parent, 0o500);
    try {
      const result = await cancelRun(toy.context, { runId: run.runId });
      expect(result.runId).toBe(run.runId);
      expect((await readRun(toy.runDir(run.runId))).status).toBe("cancelled");
      const types = (await readLedger(toy.runDir(run.runId))).map((event) => event.type);
      expect(types).toContain("cleanup_failed");
      expect(existsSync(run.arms.a)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
    const next = await startedRun();
    expect(existsSync(path.dirname(run.arms.a))).toBe(false);
    await cancelRun(toy.context, { runId: next.runId });
  });
});
