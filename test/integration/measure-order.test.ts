import { chmodSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelRun, listRunIds, measure, startRun } from "../../src/app/index.js";
import { CONTROL_LOCK_FILE, readJob, readRun, updateRun } from "../../src/core/jobs/index.js";
import { killRunProcesses } from "../../src/worker/index.js";
import {
  approveToy,
  dockerAbsent,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// Code review (round 2) #7: `ufo measure` records its final status before it removes its arms
// and branch, so a crash during the removal leaves an ended run that the next start cleans up,
// never a `running` one that refuses every later start. The removal is wrapped to read the run's
// status at the moment it begins.

const probe = vi.hoisted(() => ({
  statusOf: undefined as ((runId: string) => Promise<string>) | undefined,
  seen: [] as string[],
}));

vi.mock("../../src/core/git/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/git/index.js")>();
  return {
    ...actual,
    removeRun: async (...args: Parameters<typeof actual.removeRun>) => {
      if (probe.statusOf !== undefined) probe.seen.push(await probe.statusOf(args[0].runId));
      return actual.removeRun(...args);
    },
  };
});

let toy: Toy | undefined;

afterEach(async () => {
  probe.statusOf = undefined;
  probe.seen.length = 0;
  await toy?.cleanup();
  toy = undefined;
});

describe("ufo measure", { timeout: TIMEOUT_MS }, () => {
  it("records the final status before it removes the arms and the branch", async () => {
    const current = makeToy({ config: lightWorkload() });
    toy = current;
    await approveToy(current);
    probe.statusOf = async (runId) => (await readRun(current.runDir(runId))).status;
    const { runId } = await measure(current.context);
    expect(probe.seen).toEqual(["finished"]);
    expect((await readRun(current.runDir(runId))).status).toBe("finished");
  });

  // M2 (review of 3b35b6c): a call that holds the run's control lock longer than measure waits
  // (an outside cancel) is ending the run; measure leaves the run to it instead of failing busy.
  it("leaves its run to a call that holds the run's control lock past its wait", async () => {
    const current = makeToy({ config: lightWorkload("sleep 2") });
    toy = current;
    await approveToy(current);
    const measuring = measure({ ...current.context, controlLockWaitMs: 300 }).then(
      (result) => result,
      (error: unknown) => error,
    );
    // Once the baseline runs, another call takes the run's control lock: a live process, this one.
    let runDir: string | undefined;
    while (runDir === undefined) {
      const [runId] = await listRunIds(current.home, { repoId: current.repoId });
      const dir = runId === undefined ? undefined : current.runDir(runId);
      const job =
        dir === undefined ? undefined : await readJob(dir, "job-000001").catch(() => undefined);
      if (dir !== undefined && job?.status === "running") {
        try {
          writeFileSync(path.join(dir, CONTROL_LOCK_FILE), String(process.pid), { flag: "wx" });
          runDir = dir;
        } catch {
          // The start still holds it.
        }
      }
      if (runDir === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = await measuring;
    expect(result).toMatchObject({ baseline: { values: [1, 1, 1, 1, 1] } });
    // Code review CR-N7: and says so, with how to end the run if nothing else does.
    const runId = path.basename(runDir);
    expect((result as { warnings: string[] }).warnings).toContain(
      `measure run ${runId} was left to the call holding its control lock; if nothing ends it, run \`ufo cancel --run ${runId}\``,
    );
    expect((await readRun(runDir)).status).toBe("running");
    rmSync(path.join(runDir, CONTROL_LOCK_FILE));
    await cancelRun(current.context, { runId: path.basename(runDir) });
  });

  // M2 B3d: the result names the home as ~, its start's warnings included.
  it("redacts its result", async () => {
    const current = makeToy({ config: lightWorkload() });
    toy = current;
    await approveToy(current);
    // An ended run whose arms cannot be removed, so the start warns with their path.
    const ended = await startRun(current.context);
    expect((await waitDone(current, ended.runId, ended.baselineJobId)).status).toBe("succeeded");
    await killRunProcesses(current.runDir(ended.runId), { exec: dockerAbsent, graceMs: 500 });
    await updateRun(current.runDir(ended.runId), (record) => ({ ...record, status: "cancelled" }));
    // Its own directory, not the parent the new run's arms go in.
    const parent = path.dirname(ended.arms.a);
    chmodSync(parent, 0o500);
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(current.root);
    try {
      const result = await measure(current.context);
      expect(result.warnings).toEqual([
        expect.stringMatching(
          new RegExp(`^could not clean up run ${ended.runId}: .*~/ufo-home/arms/`),
        ),
      ]);
      expect(JSON.stringify(result)).not.toContain(current.root);
    } finally {
      homedir.mockRestore();
      chmodSync(parent, 0o700);
    }
  });

  // M2 A9: what the start warned about reaches the caller of measure too.
  it("returns the start's warnings", async () => {
    const current = makeToy({ config: lightWorkload() });
    toy = current;
    await approveToy(current);
    writeFileSync(path.join(current.repo, "server.mjs"), "// work in progress\n", { flag: "a" });
    const result = await measure(current.context);
    expect(result.warnings).toEqual([
      "the working tree has uncommitted changes; they are not part of the run",
    ]);
  });
});
