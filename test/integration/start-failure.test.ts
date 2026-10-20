import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRun } from "../../src/app/index.js";
import { runLayout } from "../../src/core/git/index.js";
import {
  CONTROL_LOCK_FILE,
  endRun,
  readLedger,
  readMachineLock,
  readRun,
} from "../../src/core/jobs/index.js";
import { approveToy, git, lightWorkload, makeToy, TIMEOUT_MS, type Toy } from "./helpers.js";

// Code review (round 3) #5: a start that fails after it created the arms and the run branch
// leaves none of them behind, nor its run state or the machine lock. (The order, arms and branch
// before the run state, matters only for a crash in between, which this test does not cover.)
// The worker never launches here; git commands fail where a test says so.

const fault = vi.hoisted(() => ({
  /** Runs inside the worker launch, before it fails. */
  onLaunch: undefined as ((runDir: string) => Promise<void>) | undefined,
  /** Runs before each `git branch -D` of a run branch. */
  onBranchDelete: undefined as (() => Promise<void>) | undefined,
  /** Git commands, by their arguments, that fail. */
  failGit: undefined as ((args: readonly string[]) => boolean) | undefined,
}));

vi.mock("../../src/core/git/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/git/exec.js")>();
  return {
    ...actual,
    git: async (...args: Parameters<typeof actual.git>) => {
      const [gitArgs] = args;
      if (gitArgs[0] === "branch" && gitArgs[1] === "-D") await fault.onBranchDelete?.();
      if (fault.failGit?.(gitArgs) === true) {
        throw new actual.GitError("git_failed", `git ${gitArgs[0]} failed (test)`);
      }
      return actual.git(...args);
    },
  };
});

vi.mock("../../src/worker/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/worker/index.js")>();
  return {
    ...actual,
    launchWorker: async (runDir: string) => {
      await fault.onLaunch?.(runDir);
      throw new Error("the worker could not start");
    },
  };
});

let toy: Toy | undefined;

afterEach(async () => {
  fault.onLaunch = undefined;
  fault.onBranchDelete = undefined;
  fault.failGit = undefined;
  await toy?.cleanup();
  toy = undefined;
});

async function approvedToy(): Promise<Toy> {
  const current = makeToy({ config: lightWorkload() });
  toy = current;
  await approveToy(current);
  return current;
}

function runIds(current: Toy): string[] {
  const runs = path.dirname(current.runDir("x"));
  return existsSync(runs) ? readdirSync(runs) : [];
}

function runBranches(current: Toy): string {
  return git(current.repo, "branch", "--list", "ufo/*", "--format=%(refname:short)").trim();
}

describe("a start that fails after it created the arms", { timeout: TIMEOUT_MS }, () => {
  it("removes the arms, the run branch, and the run state, and releases the machine lock", async () => {
    const current = await approvedToy();
    await expect(startRun(current.context)).rejects.toThrow("the worker could not start");
    expect(runBranches(current)).toBe("");
    expect(runIds(current)).toEqual([]);
    const arms = path.dirname(path.dirname(runLayout(current.home, current.repoId, "x").armA));
    expect(existsSync(arms) ? readdirSync(arms) : []).toEqual([]);
    expect(await readMachineLock({ home: current.home })).toBeUndefined();
  });

  // Code review (step A) #5: no cancel acts on a run while it starts, so none can end it between
  // `started` and the worker launch and then lose its ledger to the start's cleanup.
  it("holds the run's control lock from before it is started through the worker launch", async () => {
    const current = await approvedToy();
    const seen: unknown[] = [];
    fault.onLaunch = async (runDir) => {
      seen.push(existsSync(path.join(runDir, CONTROL_LOCK_FILE)), (await readRun(runDir)).started);
    };
    await expect(startRun(current.context)).rejects.toThrow("the worker could not start");
    expect(seen).toEqual([true, true]);
  });

  // M2 B3e: a cleanup cut short leaves an ended run, never one that looks like a start in progress
  // for as long as a long-lived starter (an MCP server) runs.
  it("records the run as failed before it cleans up", async () => {
    const current = await approvedToy();
    const statuses: string[] = [];
    fault.onBranchDelete = async () => {
      for (const id of runIds(current)) statuses.push((await readRun(current.runDir(id))).status);
    };
    await expect(startRun(current.context)).rejects.toThrow("the worker could not start");
    expect(statuses).toEqual(["failed"]);
  });

  it("leaves a run that another call ended to that call", async () => {
    const current = await approvedToy();
    fault.onLaunch = async (runDir) => {
      expect(await endRun(runDir, "cancelled")).toBe(true);
    };
    await expect(startRun(current.context)).rejects.toThrow("the worker could not start");
    const [runId] = runIds(current);
    expect(runId).toBeDefined();
    const runDir = current.runDir(runId as string);
    expect((await readRun(runDir)).status).toBe("cancelled");
    expect((await readLedger(runDir)).map((event) => event.type)).toContain("run_started");
  });

  // Security W1 (M2 A10): once the run state is gone nothing finds the run branch again, so the
  // error names a branch the start could not remove, and how to delete it.
  it("names the run branch it could not remove, and how to delete it", async () => {
    const current = await approvedToy();
    fault.failGit = (args) => args[0] === "branch" && args[1] === "-D";
    const error = await startRun(current.context).catch((caught: unknown) => caught);
    const branch = runBranches(current);
    expect(branch).toMatch(/^ufo\/run-\S+$/);
    expect(error).toMatchObject({
      message: `the worker could not start; could not remove the run branch ${branch} (git branch failed (test)); delete it with \`git branch -D ${branch}\``,
    });
    git(current.repo, "branch", "-D", branch);
    expect(runBranches(current)).toBe("");
    expect(await readMachineLock({ home: current.home })).toBeUndefined();
  });

  // Code review (step A) #1: the arms are created after the branch; when that fails, the cleanup
  // inside the arm setup says what it left too, the arms directory included.
  it("names the branch when creating the arms fails and the branch cannot be deleted", async () => {
    const current = await approvedToy();
    fault.failGit = (args) =>
      (args[0] === "clone" && String(args.at(-1)).endsWith("/b")) ||
      (args[0] === "branch" && args[1] === "-D");
    const error = await startRun(current.context).catch((caught: unknown) => caught);
    const branch = runBranches(current);
    expect(branch).toMatch(/^ufo\/run-\S+$/);
    expect(error).toMatchObject({
      message: `git clone failed (test); could not remove the run branch ${branch} (git branch failed (test)); delete it with \`git branch -D ${branch}\``,
    });
    expect(runIds(current)).toEqual([]);
    expect(await readMachineLock({ home: current.home })).toBeUndefined();
  });

  it("names the arms directory when creating the arms fails and it cannot be removed", async () => {
    const current = await approvedToy();
    let locked: string | undefined;
    fault.failGit = (args) => {
      const target = String(args.at(-1));
      if (args[0] !== "clone" || !target.endsWith("/b")) return false;
      // The arms directory's parent stops taking deletions, so the cleanup cannot remove it.
      locked = path.dirname(path.dirname(target));
      chmodSync(locked, 0o500);
      return true;
    };
    try {
      const error = await startRun(current.context).catch((caught: unknown) => caught);
      const armsDir = path.dirname(runLayout(current.home, current.repoId, "x").armA);
      const left = path.join(path.dirname(armsDir), readdirSync(path.dirname(armsDir))[0] ?? "");
      expect(existsSync(path.join(left, "a"))).toBe(true);
      expect((error as Error).message).toMatch(
        new RegExp(
          `^git clone failed \\(test\\); could not remove the arms directory ${left} \\(.+\\); remove it with \`rm -rf ${left}\`$`,
        ),
      );
      expect(runBranches(current)).toBe("");
    } finally {
      if (locked !== undefined) chmodSync(locked, 0o700);
    }
  });
});
