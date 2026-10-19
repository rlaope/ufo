import { afterEach, describe, expect, it, vi } from "vitest";
import { measure } from "../../src/app/index.js";
import { readRun } from "../../src/core/jobs/index.js";
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
});
