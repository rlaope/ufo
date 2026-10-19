import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveWithGate } from "../../src/app/human-gate.js";
import {
  type AppContext,
  getRun,
  type StartRunResult,
  type SubmitChangeOptions,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { readLedger } from "../../src/core/jobs/index.js";
import {
  decisionOf,
  diffOf,
  FIXTURE_CARDS,
  git,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// What a change costs and what is recorded: a diff against an older arm A is refused without
// being an attempt (code review #14), an agent change needs a diff when it is submitted (#15),
// and a measured drop is recorded before its cleanup, so a failing reset hook loses nothing and
// still counts against the budget (#7).

const SLEEP = "      await sleep(20);\n";

let toy: Toy;
let context: AppContext;
let run: StartRunResult;

beforeAll(async () => {
  toy = makeToy({
    config: (yaml) => lightWorkload()(yaml).replace(/^cards:\n/m, "cards:\n  - toy.reset-fails\n"),
  });
  const extra = path.join(toy.root, "extra-cards", "toy");
  mkdirSync(extra, { recursive: true });
  writeFileSync(
    path.join(extra, "reset-fails.yaml"),
    [
      "id: toy.reset-fails",
      "domain: toy",
      "title: A change whose reset hook fails",
      "kind: guided",
      "riskClass: lossless",
      "commandTemplates:",
      "  - id: reset",
      `    run: node -e "process.exit(3)"`,
      "signals:",
      "  - Used by the integration tests",
      "verifiedIn: unverified",
      "",
    ].join("\n"),
  );
  context = { ...toy.context, cardDirs: [FIXTURE_CARDS, path.dirname(extra)] };
  await approveWithGate(context, {
    stdin: { isTTY: true },
    print: () => undefined,
    confirm: async () => "approve",
  });
  run = await startRun(context);
  expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
}, TIMEOUT_MS);

afterAll(async () => {
  await toy.cleanup();
});

const tried = async () => (await getRun(context, { runId: run.runId })).budget.techniquesTried;

describe("change accounting", { timeout: TIMEOUT_MS }, () => {
  it("refuses an agent change without a diff when it is submitted", async () => {
    const options = {
      runId: run.runId,
      cardId: "toy.fast-path",
      hypothesis: "No diff at all.",
    } as unknown as SubmitChangeOptions;
    await expect(submitChange(context, options)).rejects.toMatchObject({ code: "usage" });
  });

  it("refuses a diff written against an older arm A, without counting it", async () => {
    const aHead = git(run.arms.a, "rev-parse", "HEAD").trim();
    const older = "0".repeat(40);
    expect(older).not.toBe(aHead);
    const queued = await submitChange(context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace(SLEEP, "")),
      hypothesis: "Written against an old A.",
      baseSha: older,
    });
    const decision = decisionOf(await waitDone(toy, run.runId, queued.jobId));
    expect(decision).toMatchObject({ outcome: "drop", reason: "policy:stale_base" });
    expect(decision.detail).toContain(aHead.slice(0, 12));
    expect(await tried()).toBe(0);
    // Nothing ran in B, so nothing is to be cleaned up after a crash either.
    const recorded = (await readLedger(toy.runDir(run.runId))).find(
      (e) => e.type === "decision" && e.changeId === queued.changeId,
    );
    expect(recorded?.data).toMatchObject({ attempted: false, cleanupDue: false });
  });

  it("records a measured drop before a failing reset hook, and counts it", async () => {
    const queued = await submitChange(context, {
      runId: run.runId,
      cardId: "toy.reset-fails",
      diff: diffOf(toy, "server.mjs", (s) => s.replace(SLEEP, `${SLEEP}${SLEEP}`)),
      hypothesis: "A second sleep; the constant workload sees no effect.",
    });
    const job = await waitDone(toy, run.runId, queued.jobId);
    expect(job.status).toBe("failed");
    expect(job.error?.message).toContain("reset hook of toy.reset-fails failed");
    const events = await readLedger(toy.runDir(run.runId));
    const decided = events.findIndex(
      (e) => e.type === "decision" && e.changeId === queued.changeId,
    );
    expect(decided).toBeGreaterThanOrEqual(0);
    expect(events[decided]?.data).toMatchObject({
      decision: { outcome: "drop" },
      cleanupDue: true,
    });
    const failed = events.findIndex(
      (e) => e.type === "reset_failed" && e.changeId === queued.changeId,
    );
    expect(failed).toBeGreaterThan(decided);
    expect(await tried()).toBe(1);
  });
});

// Code review (round 2) #2: a metric whose samples at A have median 0 has no noise floor; a change
// is refused as inconclusive and uncharged instead of failing its job.
describe("no noise floor at the current A", { timeout: TIMEOUT_MS }, () => {
  it("refuses a change as inconclusive when the samples at A have median 0", async () => {
    const zero = makeToy({
      config: (yaml) =>
        lightWorkload()(yaml).replace(
          /^ {2}command: .*$/m,
          `  command: 'node -e "console.log(JSON.stringify({ latency_ms: 0, error_rate: 0 }))"'`,
        ),
    });
    try {
      await approveWithGate(zero.context, {
        stdin: { isTTY: true },
        print: () => undefined,
        confirm: async () => "approve",
      });
      const started = await startRun(zero.context);
      expect((await waitDone(zero, started.runId, started.baselineJobId)).status).toBe("succeeded");
      const queued = await submitChange(zero.context, {
        runId: started.runId,
        cardId: "toy.fast-path",
        diff: diffOf(zero, "server.mjs", (s) => s.replace(SLEEP, "")),
        hypothesis: "Removing the sleep.",
      });
      const job = await waitDone(zero, started.runId, queued.jobId);
      expect(job.status).toBe("succeeded");
      expect(decisionOf(job)).toMatchObject({
        outcome: "inconclusive",
        reason: "policy:noise_floor",
        detail: expect.stringContaining("no noise floor"),
      });
      expect((await getRun(zero.context, { runId: started.runId })).budget.techniquesTried).toBe(0);
    } finally {
      await zero.cleanup();
    }
  });
});
