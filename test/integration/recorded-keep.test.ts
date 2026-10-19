import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRun, JOB_KINDS, resumeRun, startRun } from "../../src/app/index.js";
import { appendLedger, enqueueJob, isPidAlive, readRun } from "../../src/core/jobs/index.js";
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
    const fast = diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(5);\n", ""));
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
