import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRun, JOB_KINDS, resumeRun, startRun } from "../../src/app/index.js";
import {
  appendLedger,
  enqueueJob,
  isPidAlive,
  LOGS_DIR,
  readLedger,
  readRun,
  writeJob,
} from "../../src/core/jobs/index.js";
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

// Security F4: a decision recorded in the ledger is not trusted to carry code past the checks.
// A job that finds a recorded keep commits it only after the approval, card, opt-in, and
// protected-path checks a new change gets, and only for the change the job itself enqueued.

let toy: Toy;

beforeAll(() => {
  // Every job here fails before it measures anything.
  toy = makeToy({ config: lightWorkload() });
});

afterAll(async () => {
  await toy.cleanup();
});

const KEEP = {
  outcome: "keep",
  effect: 0.5,
  pairs: [1, 2, 3, 4, 5].map(() => ({ a: 10, b: 5 })),
};

/** Kills the run's idle worker so the next job waits for a worker `resumeRun` starts. */
async function stopWorker(runDir: string): Promise<void> {
  const { worker } = await readRun(runDir);
  if (worker === undefined) return;
  try {
    process.kill(worker.pid, "SIGKILL");
  } catch {
    // Already exited after idling.
  }
  for (let i = 0; i < 100 && isPidAlive(worker.pid); i++) await delay(20);
}

/** A change job as `submitChange` queues it, with a keep forged into the ledger first. */
async function forgedKeep(
  runDir: string,
  baseSha: string,
  recorded: { diff: string; cardId?: string },
  enqueued: { diff: string },
) {
  const changeId = randomUUID();
  const cardId = recorded.cardId ?? "toy.fast-path";
  const hypothesis = "A recorded keep that never reached the run branch.";
  await appendLedger(runDir, {
    type: "change_started",
    changeId,
    data: {
      change: { changeId, baseSha, cardId, diff: recorded.diff, hypothesis, evidenceRefs: [] },
      source: "agent",
    },
  });
  await appendLedger(runDir, {
    type: "decision",
    changeId,
    data: {
      decision: { changeId, ...KEEP },
      cardId,
      attempted: true,
      cleanupDue: false,
      samples: [],
      oracleResults: [],
      commands: [],
    },
  });
  return enqueueJob(runDir, {
    kind: JOB_KINDS.change,
    input: {
      changeId,
      cardId: "toy.fast-path",
      hypothesis,
      evidenceRefs: [],
      source: "agent",
      diff: enqueued.diff,
    },
  });
}

describe("a recorded keep", { timeout: TIMEOUT_MS }, () => {
  it("is not committed when it touches a protected path or is not what the job enqueued", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    await stopWorker(runDir);

    // A keep of a diff that rewrites the test suite: protected, so never committed.
    const testEdit = diffOf(toy, "test/server.test.mjs", (s) => `${s}// faster\n`);
    const protectedJob = await forgedKeep(
      runDir,
      run.baseSha,
      { diff: testEdit },
      { diff: testEdit },
    );
    // A keep whose recorded diff is not the diff the job enqueued.
    const fast = diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", ""));
    const swapped = diffOf(toy, "server.mjs", (s) => `${s}// swapped\n`);
    const swappedJob = await forgedKeep(runDir, run.baseSha, { diff: swapped }, { diff: fast });
    // A keep recorded under another card than the job's.
    const otherCard = await forgedKeep(
      runDir,
      run.baseSha,
      { diff: fast, cardId: "generic.code-change" },
      { diff: fast },
    );

    await resumeRun(toy.context, { runId: run.runId });
    const outcomes = [];
    for (const job of [protectedJob, swappedJob, otherCard]) {
      outcomes.push(await waitDone(toy, run.runId, job.jobId));
    }
    expect(outcomes.map((job) => job.status)).toEqual(["failed", "failed", "failed"]);
    expect(outcomes[0]?.error?.message).toMatch(
      /^not committing the recorded keep of [0-9a-f-]+: policy:protected_path: /,
    );
    expect(outcomes[1]?.error?.message).toContain("is not the one the job enqueued");
    expect(outcomes[2]?.error?.message).toContain("but the job enqueued toy.fast-path");
    // Nothing reached the run branch, and B is back at A.
    expect(git(toy.repo, "rev-parse", run.branch).trim()).toBe(run.baseSha);
    expect(git(run.arms.b, "status", "--porcelain")).toBe("");
    await cancelRun(toy.context, { runId: run.runId });
  });
});

// Code review #12: a change job interrupted twice is failed, unless its decision is recorded;
// then it is requeued and only finishes what the decision says.
describe("a change job interrupted twice", { timeout: TIMEOUT_MS }, () => {
  it("is requeued, not failed, when its decision is already recorded", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    await stopWorker(runDir);

    const fast = diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", ""));
    const job = await forgedKeep(runDir, run.baseSha, { diff: fast }, { diff: fast });
    // The worker that ran it died, and so did the worker of the earlier resume.
    const now = new Date().toISOString();
    await writeJob(runDir, { ...job, status: "running", startedAt: now, updatedAt: now });
    await appendLedger(runDir, { type: "job_requeued", data: { jobId: job.jobId } });

    const resumed = await resumeRun(toy.context, { runId: run.runId });
    expect(resumed.failed).toEqual([]);
    expect(resumed.requeued).toEqual([job.jobId]);
    const done = await waitDone(toy, run.runId, job.jobId);
    expect(done.status).toBe("succeeded");
    expect((done.result as { commit?: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    await cancelRun(toy.context, { runId: run.runId });
  });
});

// Code review (round 2) #4: a measured drop recorded right before a crash has its cleanup (the
// card's reset hook) run when the job runs again; a drop that never measured has none to run
// (review round 3 #1), and the hook runs only while the run's cards are still approved.
describe("a drop recorded right before a crash", { timeout: TIMEOUT_MS }, () => {
  /** A recipe job of toy.no-delay whose drop is already in the ledger. */
  async function forgedDrop(runDir: string, cleanupDue: boolean) {
    const changeId = randomUUID();
    await appendLedger(runDir, {
      type: "decision",
      changeId,
      data: {
        decision: cleanupDue
          ? { changeId, outcome: "drop", reason: "no_effect" }
          : { changeId, outcome: "drop", reason: "patch_failed" },
        cardId: "toy.no-delay",
        attempted: true,
        cleanupDue,
        samples: [],
        oracleResults: [],
        commands: [],
      },
    });
    const job = await enqueueJob(runDir, {
      kind: JOB_KINDS.change,
      input: {
        changeId,
        cardId: "toy.no-delay",
        hypothesis: "Recipe toy.no-delay",
        evidenceRefs: [],
        source: "recipe",
      },
    });
    return { changeId, job };
  }

  async function stoppedRun() {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    await stopWorker(runDir);
    return { run, runDir };
  }

  const resetRan = (runDir: string) =>
    readFileSync(path.join(runDir, LOGS_DIR, "commands.log"), "utf8").includes(
      "card toy.no-delay reset",
    );

  it("runs the card's reset hook when the job runs again", async () => {
    const { run, runDir } = await stoppedRun();
    const { changeId, job } = await forgedDrop(runDir, true);
    await resumeRun(toy.context, { runId: run.runId });
    expect((await waitDone(toy, run.runId, job.jobId)).status).toBe("succeeded");
    const events = await readLedger(runDir);
    expect(events.some((e) => e.type === "reset_done" && e.changeId === changeId)).toBe(true);
    expect(resetRan(runDir)).toBe(true);
    await cancelRun(toy.context, { runId: run.runId });
  });

  it("runs no reset hook for a drop that never measured", async () => {
    const { run, runDir } = await stoppedRun();
    const { changeId, job } = await forgedDrop(runDir, false);
    await resumeRun(toy.context, { runId: run.runId });
    expect((await waitDone(toy, run.runId, job.jobId)).status).toBe("succeeded");
    const events = await readLedger(runDir);
    expect(events.some((e) => e.changeId === changeId && e.type.startsWith("reset_"))).toBe(false);
    expect(resetRan(runDir)).toBe(false);
    await cancelRun(toy.context, { runId: run.runId });
  });

  it("refuses the reset hook once the run's ufo.yaml is no longer the approved one", async () => {
    const { run, runDir } = await stoppedRun();
    const { changeId, job } = await forgedDrop(runDir, true);
    const config = path.join(toy.repo, "ufo.yaml");
    const original = readFileSync(config, "utf8");
    writeFileSync(config, `${original}# edited after the start\n`);
    try {
      await approveToy(toy);
      await resumeRun(toy.context, { runId: run.runId });
      const done = await waitDone(toy, run.runId, job.jobId);
      expect(done.status).toBe("failed");
      expect(done.error?.message).toContain(
        "not running the reset hook of toy.no-delay: policy:config_changed",
      );
      const events = await readLedger(runDir);
      expect(events.some((e) => e.type === "reset_failed" && e.changeId === changeId)).toBe(true);
      expect(resetRan(runDir)).toBe(false);
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      writeFileSync(config, original);
    }
  });
});
