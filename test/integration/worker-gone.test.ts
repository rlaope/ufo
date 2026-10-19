import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeFailure,
  getJob,
  JOB_KINDS,
  measure,
  resumeRun,
  startRun,
  waitForJobDone,
} from "../../src/app/index.js";
import {
  enqueueJob,
  isPidAlive,
  readJob,
  readMachineLock,
  readRun,
} from "../../src/core/jobs/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  expectKeep,
  git,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// A wait must not hang on a job no worker will run. The worker dies between jobs (after the
// baseline, before it claims the next change): the CLI's wait and a get_job long poll end
// within seconds with `worker_not_running`, and resume starts a worker that runs the change.

const PROMPTLY_MS = 10_000;

let toy: Toy;

beforeAll(() => {
  toy = makeToy();
});

afterAll(async () => {
  await toy.cleanup();
});

/** The error `promise` rejects with, or a failure once `ms` pass without one. */
async function rejection(promise: Promise<unknown>, ms: number): Promise<unknown> {
  const outcome = promise.then(
    () => new Error("resolved instead of rejecting"),
    (reason: unknown) => reason,
  );
  const timeout = delay(ms).then(() => new Error(`still waiting after ${ms} ms`));
  return Promise.race([outcome, timeout]);
}

describe("a dead worker", { timeout: TIMEOUT_MS }, () => {
  it("ends the wait with worker_not_running, and resume runs the queued change", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");

    // Between jobs: the idle worker is killed (it may already have exited after idling).
    const { worker } = await readRun(runDir);
    if (worker === undefined) throw new Error("the run has no worker");
    try {
      process.kill(worker.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 100 && isPidAlive(worker.pid); i++) await delay(20);
    expect(isPidAlive(worker.pid)).toBe(false);

    // A change queued as submit_change queues it, but with no worker left to claim it.
    const change = await enqueueJob(runDir, {
      kind: JOB_KINDS.change,
      input: {
        changeId: randomUUID(),
        cardId: "toy.fast-path",
        hypothesis: "The handler sleeps 20 ms per request; removing it cuts latency.",
        source: "agent",
        diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      },
    });

    const waited = Date.now();
    const failure = describeFailure(
      await rejection(waitForJobDone(toy.context, run.runId, change.jobId), PROMPTLY_MS),
    );
    expect(failure).toMatchObject({ exitCode: 1, code: "worker_not_running" });
    expect(failure.message).toContain("ufo resume");
    expect(Date.now() - waited).toBeLessThan(PROMPTLY_MS);

    // One get_job long poll ends early the same way, long before its 25 s.
    const polled = Date.now();
    const poll = getJob(toy.context, { runId: run.runId, jobId: change.jobId, waitS: 25 });
    expect(describeFailure(await rejection(poll, PROMPTLY_MS)).code).toBe("worker_not_running");
    expect(Date.now() - polled).toBeLessThan(PROMPTLY_MS);
    expect((await readJob(runDir, change.jobId)).status).toBe("queued");

    const resumed = await resumeRun(toy.context, { runId: run.runId });
    expect(resumed).toMatchObject({ requeued: [], failed: [], reconciled: [] });
    expect(resumed.workerPid).toBeDefined();
    expect(resumed.workerPid).not.toBe(worker.pid);
    const done = await waitForJobDone(toy.context, run.runId, change.jobId);
    expectKeep(decisionOf(done), done);
  });

  it("ends ufo measure with measurement_failed, since its run is closed, not resumable", async () => {
    const other = makeToy();
    try {
      await approveToy(other);
      const measuring = measure(other.context);
      // Kill the worker as soon as the baseline job is running.
      const runs = path.dirname(other.runDir("x"));
      let pid: number | undefined;
      for (let i = 0; i < 500 && pid === undefined; i++) {
        const [id] = existsSync(runs) ? readdirSync(runs) : [];
        const runDir = id === undefined ? undefined : path.join(runs, id);
        const job =
          runDir === undefined
            ? undefined
            : await readJob(runDir, "job-000001").catch(() => undefined);
        if (runDir !== undefined && job?.status === "running") {
          pid = (await readRun(runDir)).worker?.pid;
        } else {
          await delay(20);
        }
      }
      if (pid === undefined) throw new Error("the baseline never started");
      process.kill(pid, "SIGKILL");

      const failure = describeFailure(await rejection(measuring, PROMPTLY_MS));
      expect(failure).toEqual({
        exitCode: 1,
        code: "measurement_failed",
        message: "the worker stopped before the baseline finished; run ufo measure again",
      });
      expect(git(other.repo, "branch", "--list", "ufo/*")).toBe("");
      expect(await readMachineLock({ home: other.home })).toBeUndefined();
    } finally {
      await other.cleanup();
    }
  });
});
