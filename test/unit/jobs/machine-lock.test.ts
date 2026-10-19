import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireMachineLock,
  createRunState,
  machineLockPath,
  RUN_FILE,
  readMachineLock,
  releaseMachineLock,
  runDirFor,
  updateRun,
} from "../../../src/core/jobs/index.js";

// Code review #4: the machine lock belongs to a run for its whole life, not to a process. It is
// stale only once the holding run is no longer running or its state is gone.

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-home-")));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function runState(runId: string, repoId = "repo"): Promise<string> {
  return (await createRunState(home, { runId, repoId })).runDir;
}

async function plantLock(lock: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(machineLockPath(home)), { recursive: true });
  await writeFile(machineLockPath(home), JSON.stringify(lock));
}

describe("machine lock", () => {
  it("acquires for a run, blocks a second run, and releases only for the holder", async () => {
    await runState("run-a");
    await runState("run-b");
    const first = await acquireMachineLock({ home, runId: "run-a", repoId: "repo" });
    expect(first).toMatchObject({ acquired: true, lock: { runId: "run-a", repoId: "repo" } });
    expect(machineLockPath(home)).toBe(path.join(home, "private", "lock"));

    const second = await acquireMachineLock({ home, runId: "run-b", repoId: "repo" });
    expect(second).toMatchObject({ acquired: false, holder: { runId: "run-a" } });

    expect(await releaseMachineLock({ home, runId: "run-b" })).toBe(false);
    expect(await releaseMachineLock({ home, runId: "run-a" })).toBe(true);
    expect(await readMachineLock({ home })).toBeUndefined();
    expect((await acquireMachineLock({ home, runId: "run-b", repoId: "repo" })).acquired).toBe(
      true,
    );
  });

  it("stays held by a running run whatever happens to its processes", async () => {
    const runDir = await runState("run-a");
    await acquireMachineLock({ home, runId: "run-a", repoId: "repo" });
    // A dead worker, or none at all, does not free the lock: the run is still running.
    await updateRun(runDir, (run) => ({
      ...run,
      worker: { pid: 999_999, startTime: "Thu Jan  1 00:00:00 1970", launchedAt: run.createdAt },
    }));
    await runState("run-b");
    expect(await acquireMachineLock({ home, runId: "run-b", repoId: "repo" })).toMatchObject({
      acquired: false,
      holder: { runId: "run-a" },
    });
  });

  it("clears the lock of a run that finished, was cancelled, or failed", async () => {
    for (const status of ["finished", "cancelled", "failed"] as const) {
      const holder = `run-${status}`;
      const runDir = await runState(holder);
      await acquireMachineLock({ home, runId: holder, repoId: "repo" });
      await updateRun(runDir, (run) => ({ ...run, status }));
      const next = `run-after-${status}`;
      await runState(next);
      expect(await acquireMachineLock({ home, runId: next, repoId: "repo" })).toMatchObject({
        acquired: true,
        lock: { runId: next },
        cleared: { runId: holder },
      });
      await releaseMachineLock({ home, runId: next });
    }
  });

  it("clears the lock of a run whose state is gone", async () => {
    await plantLock({ runId: "run-gone", repoId: "repo", acquiredAt: "2026-10-17T10:00:00Z" });
    await runState("run-new");
    expect(await acquireMachineLock({ home, runId: "run-new", repoId: "repo" })).toMatchObject({
      acquired: true,
      cleared: { runId: "run-gone" },
    });
  });

  it("keeps a lock whose run state cannot be read", async () => {
    const runDir = await runState("run-broken");
    await writeFile(path.join(runDir, RUN_FILE), "{");
    await plantLock({ runId: "run-broken", repoId: "repo", acquiredAt: "2026-10-17T10:00:00Z" });
    expect((await acquireMachineLock({ home, runId: "run-new", repoId: "repo" })).acquired).toBe(
      false,
    );
    expect(runDirFor(home, "repo", "run-broken")).toBe(runDir);
  });

  it("waits out a lock that is still being written, then clears it once abandoned", async () => {
    await plantLock({});
    await writeFile(machineLockPath(home), "");
    expect((await acquireMachineLock({ home, runId: "run-new", repoId: "repo" })).acquired).toBe(
      false,
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(machineLockPath(home), old, old);
    expect((await acquireMachineLock({ home, runId: "run-new", repoId: "repo" })).acquired).toBe(
      true,
    );
  });

  it("refuses a symlink planted in place of the lock", async () => {
    await mkdir(path.join(home, "private"), { recursive: true });
    const target = path.join(home, "target.json");
    await writeFile(
      target,
      JSON.stringify({ runId: "run-x", repoId: "repo", acquiredAt: "2026-10-17T10:00:00Z" }),
    );
    await symlink(target, machineLockPath(home));
    await expect(
      acquireMachineLock({ home, runId: "run-new", repoId: "repo" }),
    ).rejects.toMatchObject({ code: "unsafe_state" });
  });
});
