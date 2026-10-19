import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalSubject, loadCards } from "../../src/app/cards.js";
import {
  APP_STATE_FILE,
  cancelRun,
  describeFailure,
  getRun,
  loadConfig,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { recordApproval } from "../../src/core/policy/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  expectKeep,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// Security F1, F2, F5, F15 through the app: UFO's trusted state lives under its own home, never
// in the repository; what run state names is checked against trusted inputs; opt-ins come from
// the approved ufo.yaml and the approval record, never from run state.

let toy: Toy;
let other: Toy;

beforeAll(() => {
  // The toy's ufo.yaml requests the lossy opt-in, which approve confirms below. Only the F11
  // test measures, on a toy of its own.
  toy = makeToy({ config: (yaml) => `${lightWorkload()(yaml)}optIns:\n  - lossy\n` });
  other = makeToy();
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

describe("trusted run state", { timeout: TIMEOUT_MS }, () => {
  it("refuses a UFO home inside the repository or its git directory (F15)", async () => {
    for (const home of [path.join(toy.repo, ".ufo"), path.join(toy.repo, ".git", "ufo")]) {
      const failure = await refusal(startRun({ ...toy.context, home }));
      expect(failure).toMatchObject({ exitCode: 2, code: "unsafe_home" });
      expect(failure.message).toContain("inside the target repository");
      expect(existsSync(home)).toBe(false);
    }
  });

  it("derives everything it trusts, and refuses edited run state (F1, F2)", async () => {
    await approveToy(toy, { allowLossy: true });
    const run = await startRun(toy.context);
    const runDir = toy.runDir(run.runId);
    expect(existsSync(path.join(toy.repo, ".git", "ufo"))).toBe(false);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");

    const file = path.join(runDir, APP_STATE_FILE);
    const original = readFileSync(file, "utf8");
    const state = JSON.parse(original);
    // Run state names no home, arm path, or branch to trust.
    expect(Object.keys(state)).not.toEqual(expect.arrayContaining(["home"]));
    expect(original).not.toContain(run.arms.a);
    for (const edited of [
      // Another repository: its id does not match the run directory's.
      { ...state, repoRoot: other.repo },
      // A home, arm paths, or opt-ins planted in the state are not part of its schema.
      { ...state, home: other.home },
      { ...state, git: { armA: toy.repo, armB: toy.repo } },
      { ...state, optIns: ["lossy", "upgrade"] },
      // Another run's or repository's ids.
      { ...state, runId: "20261017-000000-aaaaaa" },
    ]) {
      writeFileSync(file, JSON.stringify(edited));
      const failure = await refusal(getRun(toy.context, { runId: run.runId }));
      expect(failure).toMatchObject({ exitCode: 1, code: "unsafe_state" });
    }
    writeFileSync(file, original);
    expect((await getRun(toy.context, { runId: run.runId })).status).toBe("running");
    await cancelRun(toy.context, { runId: run.runId });
  });

  it("measures arm A exactly at its commit, whatever was written into it (F11)", async () => {
    const real = makeToy();
    try {
      await measuresAtCommit(real);
    } finally {
      await real.cleanup();
    }
  });

  async function measuresAtCommit(toy: Toy): Promise<void> {
    await approveToy(toy);
    const run = await startRun(toy.context);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    // Edits in A after the baseline (an agent with write access to the arms) would break A's
    // setup and bias the comparison; the change job discards them first.
    writeFileSync(path.join(run.arms.a, "server.mjs"), "this is not javascript (\n");
    writeFileSync(path.join(run.arms.a, "stray.mjs"), "export {};\n");
    const queued = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      hypothesis: "The handler sleeps 5 ms per request; removing it cuts latency.",
    });
    const keptJob = await waitDone(toy, run.runId, queued.jobId);
    expectKeep(decisionOf(keptJob), keptJob);
    expect(existsSync(path.join(run.arms.a, "stray.mjs"))).toBe(false);
    await cancelRun(toy.context, { runId: run.runId });
  }

  it("takes opt-ins from the approved ufo.yaml and the approval record (F5)", async () => {
    await approveToy(toy, { allowLossy: true });
    const run = await startRun(toy.context);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    // A newer approval of the same ufo.yaml and cards that does not grant lossy.
    const loaded = await loadConfig(toy.repo);
    const cards = await loadCards(toy.repo, toy.context);
    await recordApproval(
      toy.repoId,
      { ...approvalSubject(loaded.hash, loaded.config, cards), optIns: [] },
      { home: toy.home },
    );
    const queued = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.cache-items",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      hypothesis: "Caching items skips the delay.",
    });
    expect(decisionOf(await waitDone(toy, run.runId, queued.jobId))).toMatchObject({
      outcome: "drop",
      reason: "policy:config_changed",
    });
    await cancelRun(toy.context, { runId: run.runId });
  });
});
