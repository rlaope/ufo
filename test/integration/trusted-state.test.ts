import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalSubject, loadCards } from "../../src/app/cards.js";
import {
  APP_STATE_FILE,
  cancelRun,
  describeFailure,
  finishRun,
  getJob,
  getRun,
  loadConfig,
  profileTarget,
  report,
  resumeRun,
  startRun,
  status,
  submitChange,
} from "../../src/app/index.js";
import { readRun } from "../../src/core/jobs/index.js";
import { recordApproval } from "../../src/core/policy/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  expectKeep,
  git,
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
  // Security N1: runs are found by the repository id, which comes from the git directory `.git`
  // names. Another work tree whose `.git` names this repository's git directory gets the same id,
  // and an agent that can edit `.git` could point its own work tree there.
  it("acts on a run only from the work tree that started it (N1)", async () => {
    await approveToy(toy, { allowLossy: true });
    const run = await startRun(toy.context);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    const imposter = path.join(toy.root, "imposter");
    mkdirSync(imposter);
    writeFileSync(path.join(imposter, ".git"), `gitdir: ${path.join(toy.repo, ".git")}\n`);
    // The same ufo.yaml, so a start would get as far as the git directory (code review R6).
    writeFileSync(path.join(imposter, "ufo.yaml"), readFileSync(path.join(toy.repo, "ufo.yaml")));
    const context = { ...toy.context, cwd: imposter };
    const scoped = { runId: run.runId };
    const change = {
      ...scoped,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      hypothesis: "Removing the sleep cuts latency.",
    };
    for (const [name, call] of [
      ["getRun", () => getRun(context, scoped)],
      ["getJob", () => getJob(context, { ...scoped, jobId: run.baselineJobId })],
      ["report", () => report(context, scoped)],
      ["submitChange", () => submitChange(context, change)],
      ["profileTarget", () => profileTarget(context, scoped)],
      ["finishRun", () => finishRun(context, scoped)],
      ["resumeRun", () => resumeRun(context, scoped)],
      ["cancelRun", () => cancelRun(context, scoped)],
      ["startRun", () => startRun(context)],
    ] as const) {
      const failure = await refusal(call());
      expect(failure, name).toMatchObject({ exitCode: 1, code: "unsafe_state" });
      expect(failure.message, name).toBe(
        `${imposter} uses the git directory ${path.join(toy.repo, ".git")}, not its own .git, and is no linked worktree or submodule of it`,
      );
    }
    expect((await readRun(toy.runDir(run.runId))).status).toBe("running");
    // A finished run's report too.
    const finish = await finishRun(toy.context, scoped);
    expect((await waitDone(toy, run.runId, finish.jobId)).status).toBe("succeeded");
    expect(await refusal(report(context, scoped))).toMatchObject({ code: "unsafe_state" });
    expect((await report(toy.context, scoped)).finished).toBe(true);
  });

  // Code review R1: linked worktrees share the repository id, so each sees the other's runs; each
  // acts on its own, lists the other's marked, and says where to end one that blocks a start.
  it("keeps each linked worktree to its own runs (R1)", async () => {
    await approveToy(toy, { allowLossy: true });
    const linked = path.join(toy.root, "linked");
    git(toy.repo, "worktree", "add", "--quiet", "--detach", linked);
    const here = { ...toy.context, cwd: toy.repo };
    const there = { ...toy.context, cwd: linked };
    const first = await startRun(here);
    try {
      expect((await waitDone(toy, first.runId, first.baselineJobId)).status).toBe("succeeded");
      expect(await refusal(getRun(there))).toMatchObject({
        exitCode: 2,
        code: "no_run",
        message:
          "this work tree has no UFO runs; other work trees of the repository have (`ufo status` lists them)",
      });
      const scoped = { runId: first.runId };
      const elsewhere = `run ${first.runId} was started in the work tree at ${toy.repo}; act on it from there`;
      for (const [name, call] of [
        ["getRun", () => getRun(there, scoped)],
        ["getJob", () => getJob(there, { ...scoped, jobId: first.baselineJobId })],
        ["cancelRun", () => cancelRun(there, scoped)],
      ] as const) {
        expect(await refusal(call()), name).toMatchObject({
          exitCode: 1,
          code: "run_other_work_tree",
          message: elsewhere,
          retryable: false,
        });
      }
      const listed = await status(there);
      // The earlier tests' runs too, all started in the main work tree.
      expect(listed.runs.at(-1)).toMatchObject({ runId: first.runId, workTree: toy.repo });
      expect(listed.runs.every((run) => run.workTree === toy.repo)).toBe(true);
      expect(listed.current).toBeUndefined();
      // Code review F5: named, it is listed too, with where to act on it, and nothing fails.
      const named = await status(there, scoped);
      expect(named.runs).toEqual(listed.runs);
      expect(named.current).toBeUndefined();
      expect(named.note).toBe(elsewhere);
      expect(await refusal(startRun(there))).toMatchObject({
        code: "run_in_progress",
        message: `run ${first.runId} of this repository, started in the work tree at ${toy.repo}, is still running; finish it, or stop it with \`ufo cancel --run ${first.runId}\` there`,
      });
    } finally {
      await cancelRun(here, { runId: first.runId });
    }
    const second = await startRun(there);
    try {
      expect((await getRun(there)).runId).toBe(second.runId);
      expect((await getRun(here)).runId).toBe(first.runId);
      expect((await status(here)).runs.at(-1)).toMatchObject({
        runId: second.runId,
        workTree: linked,
      });
    } finally {
      await cancelRun(there, { runId: second.runId });
    }
  });

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
      // A ufo.yaml that is not the approved one its hash names (M2 A2).
      { ...state, configText: `${state.configText}# edited\n` },
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
      hypothesis: "The handler sleeps 20 ms per request; removing it cuts latency.",
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
