import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ActiveRun, refuseIfFinishing, refuseUnstarted } from "../../../src/app/active.js";
import type { AppContext } from "../../../src/app/index.js";
import { ensureWorker } from "../../../src/app/launch.js";
import { type AppState, readAppState } from "../../../src/app/state.js";
import {
  createRunState,
  endRun,
  enqueueJob,
  readMachineLock,
  readRun,
} from "../../../src/core/jobs/index.js";

// Code review (round 2) #6: work that waited for the control lock while a cancel or finish held
// it is refused once the run ended, and no worker is launched for a run that is not running.

let root: string;
let home: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-active-")));
  home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a run that ended while a call waited for its control lock", () => {
  it("refuses new work, reading the status again", async () => {
    const { runDir } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    // Opened while the run was running, as `activeRun` does before the lock.
    const active = { runId: "run-1", runDir, home } as ActiveRun;
    await refuseIfFinishing(active);
    await endRun(runDir, "cancelled");
    await expect(refuseIfFinishing(active)).rejects.toMatchObject({
      code: "run_not_active",
      message: "run run-1 is cancelled",
    });
  });

  it("launches no worker and takes no machine lock", async () => {
    const { runDir } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    await endRun(runDir, "finished");
    const context = { cwd: root, home, workerEntry: path.join(root, "absent.js") } as AppContext;
    const state = { runId: "run-1", repoId: "repo", env: {}, gitEnv: {} } as unknown as AppState;
    await expect(ensureWorker(context, runDir, home, state)).rejects.toMatchObject({
      code: "run_not_active",
      message: "run run-1 is finished",
    });
    expect(await readMachineLock({ home })).toBeUndefined();
    expect((await readRun(runDir)).worker).toBeUndefined();
  });
});

// M2 A2: run state without app state is a run that never finished starting, not an internal error.
describe("a run without app state", () => {
  it("is not active", async () => {
    const { runDir } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    await expect(readAppState(runDir)).rejects.toMatchObject({
      code: "run_not_active",
      message: "run run-1 never finished starting (it has no app.json)",
    });
  });
});

// M2 A3: refusals an adapter acts on differently get codes of their own.
describe("a run that takes no work right now", () => {
  it("is run_finishing once its finish job is queued", async () => {
    const { runDir } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    await enqueueJob(runDir, { kind: "finish", input: {} });
    const active = { runId: "run-1", runDir, home } as ActiveRun;
    await expect(refuseIfFinishing(active)).rejects.toMatchObject({
      code: "run_finishing",
      message: "run run-1 is finishing; it takes no more work",
    });
  });

  it("is run_starting while its start runs, run_in_progress once cut short, run_not_active once ended", async () => {
    // Started by this process, which is still alive.
    const { run } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    await expect(refuseUnstarted("run-1", run)).rejects.toMatchObject({
      code: "run_starting",
      message: "run run-1 is still starting",
    });
    // Code review (step A) #4: cut short, it still holds the machine lock until cancelled.
    const { starter: _starter, ...cutShort } = run;
    await expect(refuseUnstarted("run-1", cutShort)).rejects.toMatchObject({
      code: "run_in_progress",
      message: "run run-1 did not finish starting; cancel it to end it",
    });
    await expect(refuseUnstarted("run-1", { ...run, status: "failed" })).rejects.toMatchObject({
      code: "run_not_active",
      message: "run run-1 never finished starting and has ended (failed)",
    });
    await expect(refuseUnstarted("run-1", { ...run, started: true })).resolves.toBeUndefined();
  });
});
