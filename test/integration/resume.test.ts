import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finishRun,
  getJob,
  type RunReport,
  report,
  resumeRun,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import {
  isPidAlive,
  LEDGER_FILE,
  LOGS_DIR,
  readJob,
  readRun,
  writeJob,
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

// AC 7: kill -9 of the worker in the middle of a measurement; resume resets the arms, requeues
// the interrupted change, and the run finishes with exactly one commit for it.

let toy: Toy;

beforeAll(() => {
  toy = makeToy();
});

afterAll(async () => {
  await toy.cleanup();
});

describe("resume after kill -9", { timeout: TIMEOUT_MS }, () => {
  it("finishes the interrupted change once, with no duplicate Ufo-Change-Id", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");

    const diff = diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", ""));
    const queued = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff,
      hypothesis: "The handler sleeps 20 ms per request; removing it cuts latency.",
    });
    // Wait until the worker is measuring, then until two more samples are logged.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const job = await getJob(toy.context, { runId: run.runId, jobId: queued.jobId });
      if (job.progress?.message === "measuring") break;
      expect(Date.now()).toBeLessThan(deadline);
      await delay(50);
    }
    const commandsLog = path.join(runDir, LOGS_DIR, "commands.log");
    const samplesLogged = () =>
      (readFileSync(commandsLog, "utf8").match(/\[[ab] sample \d+\]/g) ?? []).length;
    const atMeasuring = samplesLogged();
    while (samplesLogged() < atMeasuring + 2) {
      expect(Date.now()).toBeLessThan(deadline);
      await delay(50);
    }
    const { worker } = await readRun(runDir);
    expect(worker).toBeDefined();
    process.kill(worker?.pid ?? 0, "SIGKILL");
    for (let i = 0; i < 100 && isPidAlive(worker?.pid ?? 0); i++) await delay(20);
    expect((await readJob(runDir, queued.jobId)).status).toBe("running");

    const resumed = await resumeRun(toy.context, { runId: run.runId });
    expect(resumed.requeued).toEqual([queued.jobId]);
    expect(resumed.reconciled).toEqual([]);
    expect(resumed.armSha).toBe(run.baseSha);
    expect(resumed.workerPid).not.toBe(worker?.pid);

    const done = await waitDone(toy, run.runId, queued.jobId);
    expectKeep(decisionOf(done), done);
    const finish = await finishRun(toy.context, { runId: run.runId });
    expect((await waitDone(toy, run.runId, finish.jobId)).status).toBe("succeeded");
    expect(((await report(toy.context, { runId: run.runId })) as RunReport).headline).toBeDefined();

    const ids = git(
      toy.repo,
      "log",
      "--format=%(trailers:key=Ufo-Change-Id,valueonly)",
      `${run.baseSha}..${run.branch}`,
    )
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(ids).toEqual([queued.changeId]);
  });

  it("recovers a commit whose ledger entry was lost, without committing it again", async () => {
    const other = makeToy();
    try {
      await approveToy(other);
      const run = await startRun(other.context);
      const runDir = other.runDir(run.runId);
      expect((await waitDone(other, run.runId, run.baselineJobId)).status).toBe("succeeded");
      const queued = await submitChange(other.context, {
        runId: run.runId,
        cardId: "toy.fast-path",
        diff: diffOf(other, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
        hypothesis: "The handler sleeps 20 ms per request; removing it cuts latency.",
      });
      const kept = await waitDone(other, run.runId, queued.jobId);
      expectKeep(decisionOf(kept), kept);

      // The crash case of the recovery rule: the commit landed, its ledger event did not, and
      // the job still looks like it was running.
      const ledger = path.join(runDir, LEDGER_FILE);
      const lines = readFileSync(ledger, "utf8").split("\n");
      writeFileSync(ledger, lines.filter((l) => !l.includes('"change_committed"')).join("\n"));
      const { startedAt: _s, finishedAt: _f, result: _r, ...job } = kept;
      await writeJob(runDir, { ...job, status: "running", startedAt: kept.createdAt });

      const resumed = await resumeRun(other.context, { runId: run.runId });
      expect(resumed.reconciled).toEqual([queued.changeId]);
      expect(resumed.requeued).toEqual([queued.jobId]);
      const again = await waitDone(other, run.runId, queued.jobId);
      expect(again.result).toMatchObject({ commit: (kept.result as { commit: string }).commit });
      const ids = git(
        other.repo,
        "log",
        "--format=%(trailers:key=Ufo-Change-Id,valueonly)",
        `${run.baseSha}..${run.branch}`,
      )
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(ids).toEqual([queued.changeId]);
    } finally {
      await other.cleanup();
    }
  });
});
