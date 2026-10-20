import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelRun,
  describeFailure,
  finishRun,
  resumeRun,
  runRecipes,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import { CONTROL_LOCK_FILE } from "../../src/core/jobs/index.js";
import {
  approveToy,
  diffOf,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// What an adapter (the MCP server) relies on from the app layer, on a run that costs almost
// nothing to measure.

let toy: Toy;

beforeAll(async () => {
  toy = makeToy({ config: lightWorkload() });
  await approveToy(toy);
});

afterAll(async () => {
  await toy.cleanup();
});

async function startedRun() {
  const run = await startRun(toy.context);
  expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
  return run;
}

// M2 A1: a call that waits for a run's control lock waits only as long as its context says, so
// an MCP server can answer within its host's tool timeout; the timeout is reported as `busy`.
describe("a run whose control lock another call holds", { timeout: TIMEOUT_MS }, () => {
  it("fails each control call busy within the context's wait", async () => {
    const run = await startedRun();
    const lock = path.join(toy.runDir(run.runId), CONTROL_LOCK_FILE);
    const context = { ...toy.context, controlLockWaitMs: 200 };
    const scoped = { runId: run.runId };
    const change = {
      ...scoped,
      cardId: "toy.fast-path",
      diff: diffOf(toy, "server.mjs", (s) => s.replace("      await sleep(20);\n", "")),
      hypothesis: "Removing the sleep cuts latency.",
    };
    // Held by a live process: this one.
    writeFileSync(lock, String(process.pid));
    try {
      for (const call of [
        () => submitChange(context, change),
        () => runRecipes(context, scoped),
        () => finishRun(context, scoped),
        () => resumeRun(context, scoped),
        () => cancelRun(context, scoped),
      ]) {
        const started = Date.now();
        const failure = describeFailure(await call().catch((error: unknown) => error));
        expect(failure).toMatchObject({ exitCode: 1, code: "busy" });
        expect(Date.now() - started).toBeLessThan(10_000);
      }
    } finally {
      rmSync(lock, { force: true });
    }
    await cancelRun(toy.context, scoped);
  });
});
