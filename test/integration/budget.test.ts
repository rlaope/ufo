import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extendBudgetWithGate } from "../../src/app/human-gate.js";
import {
  describeFailure,
  getRun,
  openRun,
  runRecipes,
  type StartRunResult,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { listChangeIds } from "../../src/core/git/index.js";
import { appendLedger, readLedger } from "../../src/core/jobs/index.js";
import { MAX_WALL_CLOCK_MINUTES } from "../../src/domain/index.js";
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

// One run with a technique cap of 1 and the toy.fewer-requests recipe, which edits the
// benchmark. Condition (a): the diff UFO computes from a recipe meets the same protected-path
// check as an agent's diff, before anything is applied. AC 21: the cap stops the run until a
// human extends the budget at a terminal; then it continues.

const SLEEP = "      await sleep(20);\n";
const withoutSleep = (s: string) => s.replace(SLEEP, "");

let toy: Toy;
let run: StartRunResult;
let runDir: string;

beforeAll(async () => {
  toy = makeToy({
    config: (yaml) =>
      yaml
        .replace("maxTechniques: 10", "maxTechniques: 1")
        .replace(
          /^cards:\n(?: {2}- .+\n)+/m,
          "cards:\n  - generic.code-change\n  - toy.fast-path\n  - toy.fewer-requests\n",
        ),
  });
  await approveToy(toy);
  run = await startRun(toy.context);
  runDir = toy.runDir(run.runId);
  expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
}, TIMEOUT_MS);

afterAll(async () => {
  await toy.cleanup();
});

async function decide(cardId: string, diff: string, hypothesis = "Makes GET /items faster.") {
  const queued = await submitChange(toy.context, { runId: run.runId, cardId, diff, hypothesis });
  return { ...decisionOf(await waitDone(toy, run.runId, queued.jobId)), queued };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeDefined();
  return describeFailure(error);
}

function expectBAtA() {
  expect(git(run.arms.b, "rev-parse", "HEAD")).toBe(git(run.arms.a, "rev-parse", "HEAD"));
  expect(git(run.arms.b, "status", "--porcelain")).toBe("");
}

describe("recipes and the technique cap", { timeout: TIMEOUT_MS }, () => {
  it("condition (a): refuses a recipe's own diff to a protected path, as it refuses an agent's", async () => {
    const recipes = await runRecipes(toy.context, { runId: run.runId });
    expect(recipes.skipped).toEqual([]);
    expect(recipes.jobs.map((job) => job.cardId)).toEqual(["toy.fewer-requests"]);
    const [job] = recipes.jobs;
    if (job === undefined) throw new Error("no recipe job");
    const fromRecipe = decisionOf(await waitDone(toy, run.runId, job.jobId));
    expect(fromRecipe).toMatchObject({
      outcome: "drop",
      reason: "policy:protected_path",
      detail: "the patch touches protected paths: bench/latency.mjs",
    });

    // UFO computed the diff from the card's edit and recorded it; that diff is what was refused.
    const events = await readLedger(runDir);
    const started = events.find((e) => e.type === "change_started" && e.changeId === job.changeId);
    expect(started?.data).toMatchObject({
      source: "recipe",
      change: {
        cardId: "toy.fewer-requests",
        diff: expect.stringContaining("+const REQUESTS = 3;"),
      },
    });
    const recipeDiff =
      (started?.data as { change: { diff: string } } | undefined)?.change.diff ?? "";
    const decided = events.find((e) => e.type === "decision" && e.changeId === job.changeId);
    expect(decided?.data).toMatchObject({ attempted: false, samples: [], oracleResults: [] });

    // Nothing reached B or the run branch.
    expectBAtA();
    expect(readFileSync(path.join(run.arms.b, "bench/latency.mjs"), "utf8")).toContain(
      "const REQUESTS = 15;",
    );
    const open = await openRun(toy.home, runDir);
    expect(await listChangeIds(open.git)).toEqual([]);

    // The same diff from an agent meets the same check with the same result.
    const fromAgent = await decide("toy.fast-path", recipeDiff, "Fewer requests per sample.");
    expect(fromAgent).toMatchObject({
      outcome: fromRecipe.outcome,
      reason: fromRecipe.reason,
      detail: fromRecipe.detail,
    });
    expectBAtA();
    expect((await getRun(toy.context, { runId: run.runId })).budget.techniquesTried).toBe(0);
  });

  it("AC 21: stops at the cap until a human extends the budget, then continues", async () => {
    // A patch that no longer applies was attempted, so it uses the one technique of the cap.
    const stale = diffOf(toy, "server.mjs", withoutSleep).replace(
      ' if (req.url === "/items") {',
      ' if (req.url === "/things") {',
    );
    expect((await decide("toy.fast-path", stale)).reason).toBe("patch_failed");
    expect((await getRun(toy.context, { runId: run.runId })).budget).toMatchObject({
      maxTechniques: 1,
      techniquesTried: 1,
      exhausted: true,
      detail: "1 of 1 techniques tried; run ufo extend-budget to continue",
    });

    const change = {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", withoutSleep),
      hypothesis: "The handler sleeps 5 ms per request; removing it cuts latency.",
    };
    expect(await refusal(submitChange(toy.context, change))).toMatchObject({
      exitCode: 1,
      code: "policy:budget_exceeded",
    });
    expect(await runRecipes(toy.context, { runId: run.runId })).toMatchObject({
      jobs: [],
      skipped: ["toy.fewer-requests"],
    });

    // Only a human at a terminal raises the cap.
    const print = () => undefined;
    const ask = { runId: run.runId, techniques: 1, print };
    expect(
      await refusal(
        extendBudgetWithGate(toy.context, {
          ...ask,
          stdin: { isTTY: false },
          confirm: async () => "extend",
        }),
      ),
    ).toMatchObject({ exitCode: 1, code: "policy:non_tty_approval" });
    expect(
      await refusal(
        extendBudgetWithGate(toy.context, {
          ...ask,
          stdin: { isTTY: true },
          confirm: async () => "no",
        }),
      ),
    ).toMatchObject({ exitCode: 1, code: "approval_declined" });
    expect((await getRun(toy.context, { runId: run.runId })).budget.exhausted).toBe(true);
    expect((await readLedger(runDir)).some((e) => e.type === "budget_extended")).toBe(false);

    const printed: string[] = [];
    const extended = await extendBudgetWithGate(toy.context, {
      ...ask,
      stdin: { isTTY: true },
      print: (text) => printed.push(text),
      confirm: async () => "extend",
    });
    expect(extended).toMatchObject({ maxTechniques: 2 });
    expect(printed.join("")).toContain("techniques: 1 tried of 1 -> new cap 2");

    // The run continues: the next change is measured and kept, which reaches the new cap.
    const kept = await decide(change.cardId, change.diff, change.hypothesis);
    expectKeep(kept);
    const open = await openRun(toy.home, runDir);
    expect((await listChangeIds(open.git)).map((c) => c.changeId)).toEqual([kept.queued.changeId]);
    expect((await getRun(toy.context, { runId: run.runId })).budget).toMatchObject({
      maxTechniques: 2,
      techniquesTried: 2,
      exhausted: true,
    });
    expect((await refusal(submitChange(toy.context, change))).code).toBe("policy:budget_exceeded");
  });

  it("caps a wall-clock raise at the schema limit, and an unreadable raise changes nothing", async () => {
    const extended = await extendBudgetWithGate(toy.context, {
      runId: run.runId,
      techniques: 0,
      minutes: 20_000,
      print: () => undefined,
      stdin: { isTTY: true },
      confirm: async () => "extend",
    });
    expect(extended.wallClockMinutes).toBe(MAX_WALL_CLOCK_MINUTES);
    // A raise out of range that did not come through the gate: the run stays usable.
    await appendLedger(runDir, {
      type: "budget_extended",
      data: { maxTechniques: 5, wallClockMinutes: 20_000 },
    });
    expect((await getRun(toy.context, { runId: run.runId })).budget).toMatchObject({
      maxTechniques: 2,
      wallClockMinutes: MAX_WALL_CLOCK_MINUTES,
    });
  });
});
