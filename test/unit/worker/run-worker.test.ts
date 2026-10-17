import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRun,
  enqueueJob,
  listJobs,
  readJob,
  readRun,
  updateRun,
} from "../../../src/core/jobs/index.js";
import {
  isCancelRequested,
  readHeartbeat,
  requestCancel,
  runWorker,
} from "../../../src/worker/index.js";

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-loop-"));
  ({ runDir } = await createRun(root, { runId: "run-loop", repoId: "repo" }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fast = { heartbeatMs: 20, idleExitMs: 0 };

describe("runWorker", () => {
  it("runs queued jobs in sequence order and records results and failures", async () => {
    await enqueueJob(runDir, { kind: "add", input: [1, 2] });
    await enqueueJob(runDir, { kind: "boom", input: null });
    await enqueueJob(runDir, { kind: "missing", input: null });
    await enqueueJob(runDir, { kind: "bad_result", input: null });
    await enqueueJob(runDir, { kind: "add", input: [3, 4] });
    const order: string[] = [];

    const summary = await runWorker({
      runDir,
      ...fast,
      handlers: {
        add: (job) => {
          order.push(job.jobId);
          const [x, y] = job.input as [number, number];
          return { sum: x + y };
        },
        boom: () => {
          throw new Error("the build failed");
        },
        bad_result: () => ({ when: new Date() }),
      },
    });

    expect(summary).toEqual({ processed: 5, cancelled: false });
    expect(order).toEqual(["job-000001", "job-000005"]);
    const jobs = await listJobs(runDir);
    expect(jobs.map((job) => job.status)).toEqual([
      "succeeded",
      "failed",
      "failed",
      "failed",
      "succeeded",
    ]);
    expect(jobs[0]).toMatchObject({ result: { sum: 3 }, workerPid: process.pid });
    expect(jobs[1]?.error?.message).toBe("the build failed");
    expect(jobs[2]?.error?.message).toMatch(/no handler for job kind missing/);
    expect(jobs[4]?.result).toEqual({ sum: 7 });
    for (const job of jobs) {
      expect(job.startedAt).toBeDefined();
      expect(job.finishedAt).toBeDefined();
    }
  });

  it("keeps the terminal status when progress is reported right before returning", async () => {
    const job = await enqueueJob(runDir, { kind: "steps", input: null });
    await runWorker({
      runDir,
      ...fast,
      handlers: {
        steps: (_job, context) => {
          for (let done = 1; done <= 20; done++) context.setProgress({ done, total: 20 });
          return "ok";
        },
      },
    });
    expect(await readJob(runDir, job.jobId)).toMatchObject({
      status: "succeeded",
      result: "ok",
      progress: { done: 20, total: 20 },
    });
  });

  it("stops writing the heartbeat once it returns, however short the interval", async () => {
    await enqueueJob(runDir, { kind: "slow", input: null });
    await runWorker({
      runDir,
      heartbeatMs: 1,
      idleExitMs: 0,
      handlers: { slow: () => new Promise((resolve) => setTimeout(() => resolve(null), 30)) },
    });
    const before = await readHeartbeat(runDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readHeartbeat(runDir)).toEqual(before);
  });

  it("picks up a job enqueued while it waits, then marks itself exited", async () => {
    await updateRun(runDir, (run) => ({
      ...run,
      worker: { pid: process.pid, launchedAt: new Date().toISOString() },
    }));
    setTimeout(() => {
      void enqueueJob(runDir, { kind: "noop", input: null });
    }, 100);
    const summary = await runWorker({
      runDir,
      heartbeatMs: 20,
      idleExitMs: 1000,
      handlers: { noop: () => null },
    });
    expect(summary.processed).toBe(1);
    expect((await readRun(runDir)).worker?.exitedAt).toBeDefined();
  });

  it("aborts the running job on cancel and cancels the rest", async () => {
    const running = await enqueueJob(runDir, { kind: "wait", input: null });
    const queued = await enqueueJob(runDir, { kind: "wait", input: null });
    const summary = await runWorker({
      runDir,
      ...fast,
      handlers: {
        wait: async (_job, context) => {
          await requestCancel(runDir);
          await new Promise((_, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      },
    });
    expect(summary).toEqual({ processed: 1, cancelled: true });
    expect(await isCancelRequested(runDir)).toBe(true);
    expect((await readJob(runDir, running.jobId)).status).toBe("cancelled");
    expect((await readJob(runDir, queued.jobId)).status).toBe("cancelled");
  });

  it("claims nothing when a cancel was requested before it started", async () => {
    const job = await enqueueJob(runDir, { kind: "noop", input: null });
    await requestCancel(runDir);
    const summary = await runWorker({ runDir, ...fast, handlers: { noop: () => null } });
    expect(summary).toEqual({ processed: 0, cancelled: true });
    expect((await readJob(runDir, job.jobId)).status).toBe("cancelled");
  });
});
