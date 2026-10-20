import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRun } from "../../src/app/index.js";
import { runLayout } from "../../src/core/git/index.js";
import { readMachineLock } from "../../src/core/jobs/index.js";
import { approveToy, git, lightWorkload, makeToy, TIMEOUT_MS, type Toy } from "./helpers.js";

// Code review (round 3) #5: a start that fails after it created the arms and the run branch
// leaves none of them behind, nor its run state or the machine lock. (The order, arms and branch
// before the run state, matters only for a crash in between, which this test does not cover.)

const removal = vi.hoisted(() => ({ fails: false }));

vi.mock("../../src/core/git/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/git/index.js")>();
  return {
    ...actual,
    removeRun: async (...args: Parameters<typeof actual.removeRun>) => {
      if (removal.fails) throw new Error("the removal failed");
      return actual.removeRun(...args);
    },
  };
});

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
  removal.fails = false;
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

  // Security W1 (M2 A10): once the run state is gone nothing finds the run branch again, so the
  // error names a branch the start could not remove, and how to delete it.
  it("names the run branch it could not remove, and how to delete it", async () => {
    const current = makeToy({ config: lightWorkload() });
    toy = current;
    await approveToy(current);
    removal.fails = true;
    const error = await startRun(current.context).catch((caught: unknown) => caught);
    const branch = git(
      current.repo,
      "branch",
      "--list",
      "ufo/*",
      "--format=%(refname:short)",
    ).trim();
    expect(branch).toMatch(/^ufo\/run-\S+$/);
    expect(error).toMatchObject({
      message: `the worker could not start; could not remove the run branch ${branch} (the removal failed); delete it with \`git branch -D ${branch}\``,
    });
    git(current.repo, "branch", "-D", branch);
    expect(git(current.repo, "branch", "--list", "ufo/*")).toBe("");
    expect(await readMachineLock({ home: current.home })).toBeUndefined();
  });
});
