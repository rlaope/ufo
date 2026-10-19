import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelRun,
  finishRun,
  getRun,
  resumeRun,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import {
  acquireMachineLock,
  listJobs,
  readMachineLock,
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
