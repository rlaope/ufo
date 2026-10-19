import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRun } from "../../src/app/index.js";
import { runLayout } from "../../src/core/git/index.js";
import { readMachineLock } from "../../src/core/jobs/index.js";
import { approveToy, git, lightWorkload, makeToy, TIMEOUT_MS, type Toy } from "./helpers.js";

// Code review (round 3) #5: a start that fails after it created the arms and the run branch
// removes them before its run state, so nothing is left that no later start would find.

vi.mock("../../src/worker/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/worker/index.js")>();
  return {
    ...actual,
    launchWorker: async () => {
      throw new Error("the worker could not start");
    },
  };
});

let toy: Toy | undefined;

afterEach(async () => {
  await toy?.cleanup();
  toy = undefined;
});

describe("a start that fails after it created the arms", { timeout: TIMEOUT_MS }, () => {
  it("removes the arms, the run branch, and the run state, and releases the machine lock", async () => {
    const current = makeToy({ config: lightWorkload() });
    toy = current;
    await approveToy(current);
    await expect(startRun(current.context)).rejects.toThrow("the worker could not start");
    expect(git(current.repo, "branch", "--list", "ufo/*")).toBe("");
    const runs = path.dirname(current.runDir("x"));
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
    const arms = path.dirname(path.dirname(runLayout(current.home, current.repoId, "x").armA));
    expect(existsSync(arms) ? readdirSync(arms) : []).toEqual([]);
    expect(await readMachineLock({ home: current.home })).toBeUndefined();
  });
});
