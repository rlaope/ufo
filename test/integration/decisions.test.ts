import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRun,
  openRun,
  type StartRunResult,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { listChangeIds } from "../../src/core/git/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  git,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// One run, one baseline, many changes: each is decided by the real worker in arm B and must
// leave B back at A with nothing committed.

const SLEEP = "      await sleep(5);\n";
const withoutSleep = (s: string) => s.replace(SLEEP, "");

let toy: Toy;
let run: StartRunResult;

beforeAll(async () => {
  toy = makeToy();
  await approveToy(toy);
  run = await startRun(toy.context);
  const baseline = await waitDone(toy, run.runId, run.baselineJobId);
  expect(baseline.status).toBe("succeeded");
}, TIMEOUT_MS);

afterAll(async () => {
  await toy.cleanup();
});

async function decide(cardId: string, diff: string, hypothesis = "Makes GET /items faster.") {
  const queued = await submitChange(toy.context, { runId: run.runId, cardId, diff, hypothesis });
  return decisionOf(await waitDone(toy, run.runId, queued.jobId));
}

function expectBAtA() {
  expect(git(run.arms.b, "rev-parse", "HEAD")).toBe(git(run.arms.a, "rev-parse", "HEAD"));
  expect(git(run.arms.b, "status", "--porcelain")).toBe("");
  expect(git(run.arms.a, "rev-parse", "HEAD").trim()).toBe(run.baseSha);
}

describe("decisions on one run", { timeout: TIMEOUT_MS }, () => {
  it("AC 3: rejects a patch to a protected path before applying it", async () => {
    const tests = diffOf(toy, "test/server.test.mjs", (s) =>
      s.replace("formatItems counts items", "formatItems counts items quickly"),
    );
    expect(await decide("toy.fast-path", tests)).toMatchObject({
      outcome: "drop",
      reason: "policy:protected_path",
    });
    const config = diffOf(toy, "ufo.yaml", (s) =>
      s.replace("maxTechniques: 10", "maxTechniques: 50"),
    );
    expect(await decide("toy.fast-path", config)).toMatchObject({
      outcome: "drop",
      reason: "policy:protected_path",
    });
    const bench = diffOf(toy, "bench/latency.mjs", (s) =>
      s.replace("REQUESTS = 30", "REQUESTS = 3"),
    );
    expect((await decide("toy.fast-path", bench)).reason).toBe("policy:protected_path");
    expectBAtA();
  });

  it("refuses a lossy card without the opt-in, and unknown cards (risk class from the card)", async () => {
    const diff = diffOf(toy, "server.mjs", withoutSleep);
    expect(await decide("toy.cache-items", diff)).toMatchObject({
      outcome: "drop",
      reason: "policy:opt_in_required",
    });
    expect((await decide("toy.unknown", diff)).reason).toBe("policy:unknown_card");
    expectBAtA();
  });

  it("AC 4: rejects a faster patch that skips a test, or deletes one, as test_set_shrunk", async () => {
    const skip = diffOf(toy, "server.mjs", (s) =>
      withoutSleep(s).replace("RUN_SLOW_CHECKS = true", "RUN_SLOW_CHECKS = false"),
    );
    const skipped = await decide("toy.fast-path", skip);
    expect(skipped).toMatchObject({ outcome: "drop", reason: "policy:test_set_shrunk" });
    expect(skipped.detail).toContain("items payload is stable");
    const remove = diffOf(toy, "server.mjs", (s) =>
      withoutSleep(s).replace('ROUTES = ["/health", "/items"]', 'ROUTES = ["/health"]'),
    );
    const removed = await decide("toy.fast-path", remove);
    expect(removed).toMatchObject({ outcome: "drop", reason: "policy:test_set_shrunk" });
    expect(removed.detail).toContain("GET /items responds");
    expectBAtA();
  });

  it("drops a patch that does not apply or does not build", async () => {
    const stale = diffOf(toy, "server.mjs", withoutSleep).replace(
      ' if (req.url === "/items") {',
      ' if (req.url === "/things") {',
    );
    expect((await decide("toy.fast-path", stale)).reason).toBe("patch_failed");
    const broken = diffOf(toy, "server.mjs", (s) =>
      s.replace("export function formatItems(items) {", "export function formatItems(items) {{"),
    );
    expect(await decide("generic.code-change", broken)).toMatchObject({
      outcome: "drop",
      reason: "build_failed",
    });
    expectBAtA();
  });

  it("AC 5: drops a patch that answers with fast 500s (guardrail:error_rate)", async () => {
    const diff = diffOf(toy, "server.mjs", (s) =>
      withoutSleep(s).replace(
        'res.writeHead(200, { "content-type": "application/json" });',
        'res.writeHead(500, { "content-type": "application/json" });',
      ),
    );
    const decision = await decide("toy.fast-path", diff);
    expect(decision).toMatchObject({ outcome: "drop", reason: "guardrail:error_rate" });
    expect(decision.detail).toContain("100.00%");
    expectBAtA();
  });

  it("AC 2: drops a patch that adds a 5 ms sleep, resets B, and commits nothing", async () => {
    const diff = diffOf(toy, "server.mjs", (s) => s.replace(SLEEP, `${SLEEP}${SLEEP}`));
    const decision = await decide("toy.fast-path", diff, "A second sleep (control).");
    expect(decision).toMatchObject({ outcome: "drop" });
    expect(["regressed", "no_effect"]).toContain(decision.reason);
    expectBAtA();
    const open = await openRun(toy.home, toy.runDir(run.runId));
    expect(await listChangeIds(open.git)).toEqual([]);
    const view = await getRun(toy.context, { runId: run.runId });
    expect(view.decisions.every((d) => d.commit === undefined)).toBe(true);
    // Refusals before apply are not attempts; the four applied changes and the two measured
    // ones count against the technique cap.
    expect(view.budget.techniquesTried).toBe(6);
  });
});
