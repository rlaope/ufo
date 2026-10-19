import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRun, getJob, getRun, startRun, submitChange } from "../../src/app/index.js";
import {
  isProcessGroupAlive,
  readJob,
  readLedger,
  readMachineLock,
  readRun,
  TERMINAL_JOB_STATUSES,
} from "../../src/core/jobs/index.js";
import { approveToy, diffOf, git, makeToy, TIMEOUT_MS, type Toy, waitDone } from "./helpers.js";

// AC 22: cancel during a measurement stops the worker and its process groups, resets and
// removes the worktrees, reports the missing Docker without failing, and keeps the baseline
// already observed.

let toy: Toy;

beforeAll(() => {
  toy = makeToy();
});

afterAll(async () => {
  await toy.cleanup();
});

describe("cancel", { timeout: TIMEOUT_MS }, () => {
  it("stops a measuring run and keeps its completed observations", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    const queued = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      hypothesis: "The handler sleeps 20 ms per request; removing it cuts latency.",
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = await getJob(toy.context, { runId: run.runId, jobId: queued.jobId });
      if (job.progress?.message === "measuring") break;
      if (TERMINAL_JOB_STATUSES.has(job.status) || Date.now() > deadline) {
        throw new Error(`the change never started measuring: ${JSON.stringify(job)}`);
      }
      await delay(50);
    }
    const { worker } = await readRun(runDir);
    const later = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("sleep(20)", "sleep(19)")),
      hypothesis: "A shorter sleep.",
    });

    const result = await cancelRun(toy.context, { runId: run.runId });
    expect(result.cancelledJobs.sort()).toEqual([queued.jobId, later.jobId].sort());
    expect(result.processes.containers).toMatchObject({ dockerAvailable: false });
    expect(result.processes.containers.error).toContain("ENOENT");
    expect(result.processes.survivors).toEqual([]);
    expect(isProcessGroupAlive(worker?.pid ?? 0)).toBe(false);
    const after = await readRun(runDir);
    expect(after.status).toBe("cancelled");
    for (const group of after.childGroups) expect(isProcessGroupAlive(group.pgid)).toBe(false);
    expect((await readJob(runDir, queued.jobId)).status).toBe("cancelled");
    expect(await readMachineLock({ home: toy.home })).toBeUndefined();

    // Worktrees reset and removed; the run branch stays at the base SHA (nothing was kept).
    expect(existsSync(run.arms.a)).toBe(false);
    expect(existsSync(run.arms.b)).toBe(false);
    expect(git(toy.repo, "rev-parse", run.branch).trim()).toBe(run.baseSha);

    // The baseline observation survives the cancel.
    const types = (await readLedger(runDir)).map((event) => event.type);
    expect(types).toContain("baseline_measured");
    expect(types).toContain("change_started");
    expect(types.at(-1)).toBe("run_cancelled");
    const view = await getRun(toy.context, { runId: run.runId });
    expect(view.baseline?.median).toBeGreaterThan(0);
    await expect(cancelRun(toy.context, { runId: run.runId })).rejects.toMatchObject({
      code: "run_not_active",
    });
  });
});
