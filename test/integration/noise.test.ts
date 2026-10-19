import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BaselineResult,
  getRun,
  openRun,
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

// AC 17: TOY_NOISE=0.4 scales the toy's samples by 0.6, 1.4, 0.8, 1.2, 1.0, a noise floor
// near 20%. The baseline records the refusal, and a change that would otherwise be kept is not
// decided: inconclusive `policy:noise_floor`, naming the likely cause.

const CAUSE =
  "likely cause: no battery, load average, or sleep/wake issue detected; check background apps, or use a deterministic proxy metric";

let toy: Toy;

beforeAll(() => {
  // The workload sees TOY_NOISE only because ufo.yaml lists it in `env:`.
  toy = makeToy({
    env: { TOY_NOISE: "0.4" },
    config: (yaml) => `${yaml}env:\n  - TOY_NOISE\n`,
  });
});

afterAll(async () => {
  await toy.cleanup();
});

describe("noise floor above 10%", { timeout: TIMEOUT_MS }, () => {
  it("refuses to decide and names the likely cause", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    const job = await waitDone(toy, run.runId, run.baselineJobId);
    expect(job.status).toBe("succeeded");
    const baseline = job.result as unknown as BaselineResult;
    expect(baseline.noiseFloor).toBeGreaterThan(0.1);
    expect(baseline.refusal?.reason).toBe("policy:noise_floor");
    expect(baseline.refusal?.detail).toMatch(/^noise floor \d+\.\d% exceeds 10\.0%; /);
    expect(baseline.refusal?.detail).toContain(CAUSE);

    // Removing the 5 ms sleep is kept on a quiet machine (positive control); here it is refused.
    const queued = await submitChange(toy.context, {
      runId: run.runId,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(5);\n", "")),
      hypothesis: "The handler sleeps 5 ms per request; removing it cuts latency.",
    });
    const decision = decisionOf(await waitDone(toy, run.runId, queued.jobId));
    expect(decision).toMatchObject({ outcome: "inconclusive", reason: "policy:noise_floor" });
    expect(decision.detail).toMatch(/^noise floor \d+\.\d% exceeds 10\.0%; /);
    expect(decision.detail).toContain(CAUSE);

    const open = await openRun(toy.home, toy.runDir(run.runId));
    expect(await listChangeIds(open.git)).toEqual([]);
    expect(git(run.arms.b, "rev-parse", "HEAD")).toBe(git(run.arms.a, "rev-parse", "HEAD"));
    expect(git(run.arms.b, "status", "--porcelain")).toBe("");
    const view = await getRun(toy.context, { runId: run.runId });
    expect(view.baseline?.refusal).toMatchObject({ reason: "policy:noise_floor" });
    expect(view.decisions).toMatchObject([
      { outcome: "inconclusive", reason: "policy:noise_floor" },
    ]);
  });
});
