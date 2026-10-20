import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelRun,
  describeFailure,
  finishRun,
  report,
  resumeRun,
  runRecipes,
  startRun,
  status,
  submitChange,
} from "../../src/app/index.js";
import { main } from "../../src/cli/main.js";
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
      // M2 A4: the CLI prints the failure's hint after its message, which names the lock with
      // the home as ~ (code review, step A, #3).
      let stderr = "";
      const { cwd, ...rest } = context;
      const homedir = vi.spyOn(os, "homedir").mockReturnValue(toy.root);
      let code: number;
      try {
        code = await main(["cancel", "--run", run.runId], {
          stdout: () => undefined,
          stderr: (text) => {
            stderr += text;
          },
          cwd,
          context: rest,
          env: { ...process.env },
        });
      } finally {
        homedir.mockRestore();
      }
      expect(code).toBe(1);
      expect(stderr).toBe(
        `ufo cancel: busy: timed out waiting for ~${lock.slice(toy.root.length)}; another UFO call is working on this run; try again in a few seconds\n`,
      );
    } finally {
      rmSync(lock, { force: true });
    }
    await cancelRun(toy.context, scoped);
  });
});

// M2 A9: a run the repository does not have is `no_run`, as for every other command.
describe("status of a run that does not exist", () => {
  it("is no_run", async () => {
    for (const runId of ["20261020-000000-aaaaaa", "../outside"]) {
      await expect(status(toy.context, { runId })).rejects.toMatchObject({
        code: "no_run",
        message: `no run ${runId} in this repository`,
      });
    }
  });
});

// M2 A5: the two kinds of report result are told apart by `finished`, on both.
describe("the report of a run", { timeout: TIMEOUT_MS }, () => {
  it("is the view with finished false until the run finished, then the report with finished true", async () => {
    const run = await startedRun();
    const unfinished = await report(toy.context, { runId: run.runId });
    expect(unfinished).toMatchObject({ finished: false, runId: run.runId, status: "running" });
    // M2 A7: a run whose baseline was not refused is usable.
    expect(unfinished).toMatchObject({ usable: true });
    expect(unfinished).not.toHaveProperty("unusableReason");
    const finish = await finishRun(toy.context, { runId: run.runId });
    expect((await waitDone(toy, run.runId, finish.jobId)).status).toBe("succeeded");
    expect(await report(toy.context, { runId: run.runId })).toMatchObject({
      finished: true,
      runId: run.runId,
      noHeadline: "no change was kept, so there is nothing to compare",
    });
  });
});
