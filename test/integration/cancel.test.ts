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
  updateRun,
} from "../../src/core/jobs/index.js";
import { newRunId } from "../../src/core/paths.js";
import { type Exec, trackContainerLabel } from "../../src/worker/index.js";
import {
  approveToy,
  diffOf,
  git,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

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

/**
 * Docker as `docker ps -aq --filter label=<key=value>` and `docker rm -f` see a fixed set of
 * containers: the filter matches a container carrying exactly that label.
 */
function fakeDocker(containers: Map<string, readonly string[]>, removed: string[]): Exec {
  return async (file, args) => {
    if (file !== "docker") throw new Error(`unexpected ${file}`);
    const [command, ...rest] = args;
    if (command === "version") return { stdout: "27.0.0\n" };
    if (command === "ps") {
      const label = rest[rest.indexOf("--filter") + 1]?.replace(/^label=/, "");
      const ids = [...containers]
        .filter(([, labels]) => labels.includes(label ?? ""))
        .map(([id]) => id);
      return { stdout: ids.map((id) => `${id}\n`).join("") };
    }
    if (command === "rm") {
      for (const id of rest.filter((arg) => arg !== "-f")) {
        containers.delete(id);
        removed.push(id);
      }
      return { stdout: "" };
    }
    throw new Error(`unexpected docker ${command}`);
  };
}

// Verifier V5 / security F6: with Docker present, cancel removes the run's labeled containers
// and nothing else, even when run.json was edited to name another run's label.
describe("cancel with Docker present", { timeout: TIMEOUT_MS }, () => {
  it("removes only the containers labeled for this run", async () => {
    const light = makeToy({ config: lightWorkload() });
    try {
      await approveToy(light);
      const run = await startRun(light.context);
      const runDir = light.runDir(run.runId);
      expect((await waitDone(light, run.runId, run.baselineJobId)).status).toBe("succeeded");
      const other = newRunId();
      const own = "a".repeat(12);
      const ownDb = "b".repeat(12);
      const foreign = "c".repeat(12);
      const unlabeled = "d".repeat(12);
      const containers = new Map<string, readonly string[]>([
        [own, [`ufo.run=${run.runId}`]],
        [ownDb, [`ufo.run=${run.runId}.db`]],
        [foreign, [`ufo.run=${other}`]],
        [unlabeled, []],
      ]);
      await trackContainerLabel(runDir, `ufo.run=${run.runId}.db`);
      // An edit of run.json that names another run's label, bypassing trackContainerLabel.
      await updateRun(runDir, (record) => ({
        ...record,
        containerLabels: [...record.containerLabels, `ufo.run=${other}`],
      }));
      const removed: string[] = [];
      const result = await cancelRun(
        { ...light.context, exec: fakeDocker(containers, removed) },
        { runId: run.runId },
      );
      expect(result.processes.containers).toMatchObject({ dockerAvailable: true });
      expect(removed.sort()).toEqual([own, ownDb].sort());
      expect([...containers.keys()].sort()).toEqual([foreign, unlabeled].sort());
    } finally {
      await light.cleanup();
    }
  });
});
