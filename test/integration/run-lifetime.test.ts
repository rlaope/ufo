import { readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveWithGate } from "../../src/app/human-gate.js";
import {
  type AppContext,
  cancelRun,
  describeFailure,
  measure,
  readAppState,
  resumeRun,
  startRun,
} from "../../src/app/index.js";
import { readLedger, readMachineLock, readRun } from "../../src/core/jobs/index.js";
import { isWorkerAlive } from "../../src/worker/index.js";
import {
  approveToy,
  git,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// Code review #4: the machine lock belongs to the run for its whole life. A worker that idles
// out does not free it; a new start refuses, naming the active run and how to end it, instead
// of clearing it; finish, cancel, and a failed start release it. Code review #11: resume and
// cancel of one run take turns.

let toy: Toy;
let other: Toy;
let shared: AppContext;

beforeAll(() => {
  // Nothing here is about measurement.
  toy = makeToy({ config: lightWorkload() });
  other = makeToy({ config: lightWorkload() });
  // A second repository on the same machine and the same UFO home.
  shared = { ...other.context, home: toy.home };
});

afterAll(async () => {
  await toy.cleanup();
  await other.cleanup();
});

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeDefined();
  return describeFailure(error);
}

async function workerGone(runDir: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!(await isWorkerAlive(await readRun(runDir)))) return;
    await delay(25);
  }
  throw new Error("the worker did not idle out");
}

describe("the machine lock and the run's lifetime", { timeout: TIMEOUT_MS }, () => {
  it("stays with a running run whose worker idled out, and starts refuse naming it", async () => {
    await approveToy(toy);
    await approveWithGate(shared, {
      stdin: { isTTY: true },
      print: () => undefined,
      confirm: async () => "approve",
    });
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    await workerGone(runDir);
    expect(await readMachineLock({ home: toy.home })).toMatchObject({
      runId: run.runId,
      repoId: toy.repoId,
    });

    // The same repository: the abandoned run is named with both ways out.
    const again = await refusal(startRun(toy.context));
    expect(again).toMatchObject({ exitCode: 1, code: "run_in_progress" });
    expect(again.message).toContain(`run ${run.runId} of this repository is still running`);
    expect(again.message).toContain(`ufo resume --run ${run.runId}`);
    expect(again.message).toContain(`ufo cancel --run ${run.runId}`);
    // Another repository: the lock names the run that holds it.
    for (const attempt of [() => startRun(shared), () => measure(shared)]) {
      const blocked = await refusal(attempt());
      expect(blocked).toMatchObject({ exitCode: 1, code: "run_in_progress" });
      expect(blocked.message).toContain(`UFO run ${run.runId} is still active`);
      expect(blocked.message).toContain(`ufo cancel --run ${run.runId}`);
    }
    expect(readdirSync(path.join(toy.home, "private", "runs", other.repoId))).toEqual([]);
    expect((await readMachineLock({ home: toy.home }))?.runId).toBe(run.runId);

    // Resume and two cancels at once take turns: whichever goes first, the run is cancelled
    // exactly once, a resume runs only before it, and every other call sees the run ended.
    const [resumed, ...cancels] = await Promise.allSettled([
      resumeRun(toy.context, { runId: run.runId }),
      cancelRun(toy.context, { runId: run.runId }),
      cancelRun(toy.context, { runId: run.runId }),
    ]);
    expect(cancels.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    for (const outcome of [resumed, ...cancels]) {
      if (outcome.status === "rejected") {
        expect(describeFailure(outcome.reason)).toMatchObject({ code: "run_not_active" });
      }
    }
    const events = (await readLedger(runDir)).map((e) => e.type);
    expect(events.filter((type) => type === "run_cancelled")).toHaveLength(1);
    expect(events.filter((type) => type === "run_resumed")).toHaveLength(
      resumed.status === "fulfilled" ? 1 : 0,
    );
    expect(events.at(-1)).toBe("run_cancelled");
    expect(await readMachineLock({ home: toy.home })).toBeUndefined();

    // With the lock free, the other repository starts.
    const next = await startRun(shared);
    expect((await readMachineLock({ home: toy.home }))?.runId).toBe(next.runId);
    await cancelRun(shared, { runId: next.runId });
  });

  it("releases the lock and leaves nothing behind when a start fails after taking it", async () => {
    // Refused by the git config preflight, which runs once the run holds the lock.
    git(toy.repo, "config", "filter.toy.clean", "cat");
    try {
      expect(await refusal(startRun(toy.context))).toMatchObject({
        exitCode: 1,
        code: "policy:unsafe_repo_config",
      });
    } finally {
      git(toy.repo, "config", "--unset", "filter.toy.clean");
    }
    expect(await readMachineLock({ home: toy.home })).toBeUndefined();
    const states = readdirSync(path.dirname(toy.runDir("x")));
    for (const id of states) {
      expect((await readRun(toy.runDir(id))).status).not.toBe("running");
      expect((await readAppState(toy.runDir(id))).repoId).toBe(toy.repoId);
    }
    expect(git(toy.repo, "branch", "--list", "ufo/*").split("\n").filter(Boolean)).toHaveLength(
      states.length,
    );
  });
});
