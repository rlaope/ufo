import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ActiveRun, refuseIfFinishing } from "../../../src/app/active.js";
import type { AppContext } from "../../../src/app/index.js";
import { ensureWorker } from "../../../src/app/launch.js";
import type { AppState } from "../../../src/app/state.js";
import { createRunState, endRun, readMachineLock, readRun } from "../../../src/core/jobs/index.js";

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
