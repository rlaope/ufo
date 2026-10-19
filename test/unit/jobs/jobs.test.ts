import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampWaitS,
  createRunState,
  enqueueJob,
  JOBS_DIR,
  listJobs,
  MAX_WAIT_S,
  readJob,
  waitForJob,
  writeJob,
} from "../../../src/core/jobs/index.js";

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-jobs-"));
  ({ runDir } = await createRunState(root, { runId: "run-jobs", repoId: "repo" }));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("jobs", () => {
  it("enqueues jobs with increasing sequence numbers", async () => {
    const first = await enqueueJob(runDir, { kind: "baseline", input: { pairs: 5 } });
    const second = await enqueueJob(runDir, { kind: "finish", input: null });
    expect(first).toMatchObject({ jobId: "job-000001", seq: 1, status: "queued" });
    expect(second).toMatchObject({ jobId: "job-000002", seq: 2 });
    expect(await readJob(runDir, "job-000001")).toEqual(first);
  });

  it("assigns distinct sequence numbers to concurrent enqueues", async () => {
    const jobs = await Promise.all(
      Array.from({ length: 10 }, () => enqueueJob(runDir, { kind: "noop", input: {} })),
    );
    expect(new Set(jobs.map((job) => job.seq)).size).toBe(10);
    expect((await listJobs(runDir)).map((job) => job.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("lists jobs in order and skips temp files of interrupted writes", async () => {
    await enqueueJob(runDir, { kind: "noop", input: 1 });
    await enqueueJob(runDir, { kind: "noop", input: 2 });
    await writeFile(path.join(runDir, JOBS_DIR, "job-000003.json.1.ab.tmp"), '{"jobId":');
    expect((await listJobs(runDir)).map((job) => job.input)).toEqual([1, 2]);
  });

  it("rejects job ids that are not job ids", async () => {
    await expect(readJob(runDir, "../run")).rejects.toThrow();
    await expect(readJob(runDir, "job-000009")).rejects.toThrow(/unknown job/);
  });
});

describe("waitForJob", () => {
  it("clamps the wait to 0..25 seconds", () => {
    expect(MAX_WAIT_S).toBe(25);
    expect(clampWaitS(10)).toBe(10);
    expect(clampWaitS(25)).toBe(25);
    expect(clampWaitS(3600)).toBe(25);
    expect(clampWaitS(-5)).toBe(0);
    expect(clampWaitS(Number.NaN)).toBe(0);
    expect(clampWaitS(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("returns as soon as the job finishes", async () => {
    const job = await enqueueJob(runDir, { kind: "noop", input: null });
    setTimeout(() => {
      void writeJob(runDir, { ...job, status: "succeeded", result: 42 });
    }, 100);
    const started = Date.now();
    const done = await waitForJob(runDir, job.jobId, 10, { pollMs: 20 });
    expect(done).toMatchObject({ status: "succeeded", result: 42 });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("returns the current record when the wait runs out", async () => {
    const job = await enqueueJob(runDir, { kind: "noop", input: null });
    const started = Date.now();
    expect((await waitForJob(runDir, job.jobId, 0.2, { pollMs: 20 })).status).toBe("queued");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("never waits longer than 25 seconds, whatever was asked", async () => {
    const job = await enqueueJob(runDir, { kind: "noop", input: null });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const startedAt = Date.now();
    let settled = false;
    const waiting = waitForJob(runDir, job.jobId, 3600, { pollMs: 1000 }).then((result) => {
      settled = true;
      return result;
    });
    // Step fake time from poll to poll; between polls the job file read is real I/O.
    for (let step = 0; !settled && step < 100_000; step++) {
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
      else await new Promise((resolve) => setImmediate(resolve));
    }
    await expect(waiting).resolves.toMatchObject({ status: "queued" });
    expect(Date.now() - startedAt).toBe(MAX_WAIT_S * 1000);
  });
});
