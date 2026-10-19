import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, startRun, submitChange } from "../../src/app/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

let toy: Toy;

beforeAll(() => {
  toy = makeToy();
});

afterAll(async () => {
  await toy.cleanup();
});

describe("smoke", { timeout: TIMEOUT_MS }, () => {
  it("runs a baseline and decides a change", async () => {
    await approveToy(toy);
    const started = await startRun(toy.context);
    const baseline = await waitDone(toy, started.runId, started.baselineJobId);
    console.log(JSON.stringify(baseline, null, 2));
    expect(baseline.status).toBe("succeeded");
    const diff = diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(5);\n", ""));
    const queued = await submitChange(toy.context, {
      runId: started.runId,
      cardId: "toy.fast-path",
      diff,
      hypothesis: "The handler sleeps 5 ms on every request; removing it cuts latency.",
    });
    const done = await waitDone(toy, started.runId, queued.jobId);
    console.log(JSON.stringify(done, null, 2));
    expect(decisionOf(done)).toMatchObject({ outcome: "keep" });
    console.log(JSON.stringify(await getRun(toy.context, { runId: started.runId }), null, 2));
  });
});
