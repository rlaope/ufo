import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveWithGate } from "../../src/app/human-gate.js";
import {
  type AppContext,
  cancelRun,
  describeFailure,
  runRecipes,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { LOGS_DIR, readLedger } from "../../src/core/jobs/index.js";
import {
  decisionOf,
  diffOf,
  FIXTURE_CARDS,
  git,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// Plan §2.3 step 2: an approval covers every card ufo.yaml enables, not only ufo.yaml. The cards
// here live in the user's tree (`cards/`), where an agent can edit them. An enabled card changed
// after approval refuses the run start; one changed after the start has no effect, because the
// worker runs the cards captured at start; a card ufo.yaml does not enable needs no approval.

const SLEEP = "      await sleep(20);\n";

let toy: Toy;
let cardsDir: string;
let context: AppContext;

beforeEach(() => {
  toy = makeToy();
  cardsDir = path.join(toy.repo, "cards");
  cpSync(FIXTURE_CARDS, cardsDir, { recursive: true });
  context = { ...toy.context, cardDirs: [cardsDir] };
});

afterEach(async () => {
  await toy.cleanup();
});

const card = (name: string) => path.join(cardsDir, "toy", `${name}.yaml`);

/** Replaces `from` with `to` in `file`; returns a function that restores the original bytes. */
function edit(file: string, from: string, to: string): () => void {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(file, original.replace(from, to));
  return () => writeFileSync(file, original);
}

function approveHere() {
  return approveWithGate(context, {
    stdin: { isTTY: true },
    print: () => undefined,
    confirm: async () => "approve",
  });
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeDefined();
  return describeFailure(error);
}

describe("approval of technique cards", { timeout: TIMEOUT_MS }, () => {
  it("refuses to start once an enabled card changed after approval, naming the card", async () => {
    await approveHere();
    for (const [from, to] of [
      ["run: node --check server.mjs", "run: node --check server.mjs && echo not-approved"],
      ['value: "{{delay_ms}}"', 'value: "1"'],
    ] as const) {
      const restore = edit(card("no-delay"), from, to);
      const failure = await refusal(startRun(context));
      expect(failure).toMatchObject({ exitCode: 1, code: "policy:config_changed" });
      expect(failure.message).toContain("toy.no-delay");
      expect(failure.message).not.toContain("ufo.yaml changed");
      expect(git(toy.repo, "branch", "--list", "ufo/*")).toBe("");
      restore();
    }
    const run = await startRun(context);
    await cancelRun(context, { runId: run.runId });
  });

  it("needs no re-approval for cards ufo.yaml does not enable", async () => {
    await approveHere();
    edit(card("fewer-requests"), "default: 3", "default: 1");
    writeFileSync(
      card("unused"),
      [
        "id: toy.unused",
        "domain: toy",
        "title: Not enabled anywhere",
        "kind: guided",
        "riskClass: lossless",
        "signals:",
        "  - nothing",
        "verifiedIn: unverified",
        "",
      ].join("\n"),
    );
    const run = await startRun(context);
    await cancelRun(context, { runId: run.runId });
  });

  it("runs the cards captured at start, and stops once they are no longer the approved ones", async () => {
    await approveHere();
    const run = await startRun(context);
    const runDir = toy.runDir(run.runId);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");

    // Edited after the start: another reset command and another recipe value.
    edit(card("no-delay"), "run: node --check server.mjs", "run: echo edited-after-start");
    edit(card("no-delay"), 'value: "{{delay_ms}}"', 'value: "1"');

    // The recipe's diff comes from the captured card.
    const recipes = await runRecipes(context, { runId: run.runId });
    expect(recipes.jobs.map((job) => job.cardId)).toEqual(["toy.no-delay"]);
    const [recipe] = recipes.jobs;
    if (recipe === undefined) throw new Error("no recipe job");
    expect((await waitDone(toy, run.runId, recipe.jobId)).status).toBe("succeeded");
    const started = (await readLedger(runDir)).find(
      (e) => e.type === "change_started" && e.changeId === recipe.changeId,
    );
    const diff = (started?.data as { change?: { diff?: string } } | undefined)?.change?.diff;
    expect(diff).toContain("+items.extra_delay_ms=0");
    expect(diff).not.toMatch(/^\+items\.extra_delay_ms=1$/m);

    // A dropped change runs the reset hook of the captured card.
    const slower = await submitChange(context, {
      runId: run.runId,
      cardId: "toy.no-delay",
      diff: diffOf(toy, "server.mjs", (s) => s.replace(SLEEP, `${SLEEP}${SLEEP}`)),
      hypothesis: "A second sleep (control).",
    });
    const dropped = decisionOf(await waitDone(toy, run.runId, slower.jobId));
    expect(dropped.outcome, JSON.stringify(dropped)).not.toBe("keep");
    const log = readFileSync(path.join(runDir, LOGS_DIR, "commands.log"), "utf8");
    expect(log).toContain(
      "[b card toy.no-delay reset] `node --check server.mjs` exited with code 0",
    );
    expect(log).not.toContain("edited-after-start");

    // Approving the edited card leaves this run's captured cards unapproved: no more changes.
    await approveHere();
    const after = await submitChange(context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace(SLEEP, "")),
      hypothesis: "The handler sleeps 5 ms per request; removing it cuts latency.",
    });
    const refused = decisionOf(await waitDone(toy, run.runId, after.jobId));
    expect(refused).toMatchObject({ outcome: "drop", reason: "policy:config_changed" });
    expect(refused.detail).toContain("toy.no-delay");
  });
});
