import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelRun, listRunIds, measure } from "../../src/app/index.js";
import { CONTROL_LOCK_FILE, readJob, readRun } from "../../src/core/jobs/index.js";
import { approveToy, lightWorkload, makeToy, TIMEOUT_MS, type Toy } from "./helpers.js";

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
    expect((await readRun(runDir)).status).toBe("running");
    rmSync(path.join(runDir, CONTROL_LOCK_FILE));
    await cancelRun(current.context, { runId: path.basename(runDir) });
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
