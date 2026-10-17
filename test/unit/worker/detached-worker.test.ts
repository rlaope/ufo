import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRun,
  enqueueJob,
  isPidAlive,
  isProcessGroupAlive,
  LOGS_DIR,
  readJob,
  readRun,
  waitForJob,
} from "../../../src/core/jobs/index.js";
import {
  isWorkerAlive,
  killRunProcesses,
  launchWorker,
  readHeartbeat,
  requestCancel,
  WORKER_ERR_LOG,
} from "../../../src/worker/index.js";

const ENTRY = fileURLToPath(new URL("./fixtures/worker-entry.mjs", import.meta.url));
const dockerAbsent = async () => {
  throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
};

let root: string;
let runDir: string;
const leftovers: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-worker-"));
  ({ runDir } = await createRun(root, { runId: "run-worker", repoId: "repo" }));
});

afterEach(async () => {
  for (const pgid of leftovers.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function waitUntil(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      const log = await readFile(path.join(runDir, LOGS_DIR, WORKER_ERR_LOG), "utf8").catch(
        () => "",
      );
      throw new Error(`timed out waiting for ${what}\n${log}`);
    }
    await delay(25);
  }
}

describe("detached worker", () => {
  it("runs a job to completion, records its PID, and exits when idle", async () => {
    const job = await enqueueJob(runDir, { kind: "echo", input: { hello: "world" } });
    const worker = await launchWorker(runDir, { entry: ENTRY });
    leftovers.push(worker.pid);

    expect((await readRun(runDir)).worker?.pid).toBe(worker.pid);
    const done = await waitForJob(runDir, job.jobId, 15, { pollMs: 25 });
    expect(done).toMatchObject({
      status: "succeeded",
      result: { hello: "world" },
      workerPid: worker.pid,
    });

    await waitUntil(() => !isPidAlive(worker.pid), "the worker to exit");
    const run = await readRun(runDir);
    expect(run.worker?.exitedAt).toBeDefined();
    expect(await isWorkerAlive(run)).toBe(false);
    expect(await readHeartbeat(runDir)).toMatchObject({ pid: worker.pid });
  });

  it("is stopped with its long-running child group by killRunProcesses", async () => {
    const readyFile = path.join(root, "child-ready");
    await enqueueJob(runDir, { kind: "stubborn_child", input: { readyFile } });
    const worker = await launchWorker(runDir, { entry: ENTRY });
    leftovers.push(worker.pid);
    await waitUntil(
      async () => existsSync(readyFile) && (await readRun(runDir)).childGroups.length === 1,
      "the child group",
    );
    const [group] = (await readRun(runDir)).childGroups;
    if (group === undefined) throw new Error("no child group");
    leftovers.push(group.pgid);
    expect(group.startTime).toBeDefined();
    expect(isProcessGroupAlive(group.pgid)).toBe(true);
    expect(await isWorkerAlive(await readRun(runDir))).toBe(true);

    const report = await killRunProcesses(runDir, { graceMs: 300, exec: dockerAbsent });

    expect(report.terminated).toEqual([worker.pid, group.pgid]);
    // The child ignores SIGTERM, so it needed SIGKILL.
    expect(report.killed).toEqual([group.pgid]);
    expect(report.survivors).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(isProcessGroupAlive(worker.pid)).toBe(false);
    expect(isProcessGroupAlive(group.pgid)).toBe(false);
    expect(report.containers).toMatchObject({ dockerAvailable: false, removed: [] });
  });

  it("stops at a cancel request and cancels the running and queued jobs", async () => {
    const waiting = await enqueueJob(runDir, { kind: "wait_for_cancel", input: null });
    const queued = await enqueueJob(runDir, { kind: "echo", input: 1 });
    const worker = await launchWorker(runDir, {
      entry: ENTRY,
      extraArgs: ["--heartbeat-ms", "50"],
    });
    leftovers.push(worker.pid);
    await waitUntil(
      async () => (await readJob(runDir, waiting.jobId)).progress?.message === "waiting",
      "the first job to start",
    );

    await requestCancel(runDir);

    expect(await waitForJob(runDir, waiting.jobId, 10, { pollMs: 25 })).toMatchObject({
      status: "cancelled",
    });
    expect(await waitForJob(runDir, queued.jobId, 10, { pollMs: 25 })).toMatchObject({
      status: "cancelled",
    });
    await waitUntil(() => !isPidAlive(worker.pid), "the worker to exit");
    expect((await readRun(runDir)).worker?.exitedAt).toBeDefined();
  });
});
