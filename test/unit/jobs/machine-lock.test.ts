import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireMachineLock,
  MACHINE_LOCK_FILE,
  readMachineLock,
  readProcessStartTime,
  releaseMachineLock,
  transferMachineLock,
} from "../../../src/core/jobs/index.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ufo-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

async function plantLock(lock: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(home, MACHINE_LOCK_FILE), JSON.stringify(lock));
}

describe("machine lock", () => {
  it("acquires, blocks a second run, and releases", async () => {
    const first = await acquireMachineLock({ home, runId: "run-a" });
    expect(first).toMatchObject({ acquired: true, lock: { pid: process.pid, runId: "run-a" } });
    expect(first.limitation).toBeUndefined();

    const second = await acquireMachineLock({ home, runId: "run-b" });
    expect(second).toMatchObject({ acquired: false, holder: { runId: "run-a" } });

    expect(await releaseMachineLock({ home, runId: "run-b" })).toBe(false);
    expect(await releaseMachineLock({ home, runId: "run-a" })).toBe(true);
    expect(await readMachineLock({ home })).toBeUndefined();
    expect((await acquireMachineLock({ home, runId: "run-b" })).acquired).toBe(true);
  });

  it("is blocked by a live holder", async () => {
    await plantLock({
      pid: process.pid,
      startTime: await readProcessStartTime(process.pid),
      runId: "run-live",
      acquiredAt: "2026-10-17T10:00:00Z",
    });
    const result = await acquireMachineLock({ home, runId: "run-new" });
    expect(result).toMatchObject({ acquired: false, holder: { runId: "run-live" } });
  });

  it("clears a lock whose PID is dead", async () => {
    await plantLock({
      pid: await deadPid(),
      runId: "run-dead",
      acquiredAt: "2026-10-17T10:00:00Z",
    });
    const result = await acquireMachineLock({ home, runId: "run-new" });
    expect(result).toMatchObject({
      acquired: true,
      lock: { runId: "run-new" },
      cleared: { runId: "run-dead" },
    });
    expect((await readMachineLock({ home }))?.runId).toBe("run-new");
  });

  it("clears a lock whose PID was reused by a process with another start time", async () => {
    await plantLock({
      pid: process.pid,
      startTime: "Thu Jan  1 00:00:00 1970",
      runId: "run-old",
      acquiredAt: "2026-10-17T10:00:00Z",
    });
    const result = await acquireMachineLock({ home, runId: "run-new" });
    expect(result).toMatchObject({ acquired: true, cleared: { runId: "run-old" } });
  });

  it("treats a live PID without a start time as held and says why", async () => {
    await plantLock({ pid: process.pid, runId: "run-old", acquiredAt: "2026-10-17T10:00:00Z" });
    const result = await acquireMachineLock({ home, runId: "run-new" });
    expect(result.acquired).toBe(false);
    expect(result.limitation).toMatch(/PID liveness only/);
  });

  it("waits out a lock that is still being written, then clears it once abandoned", async () => {
    const file = path.join(home, MACHINE_LOCK_FILE);
    await writeFile(file, "");
    expect((await acquireMachineLock({ home, runId: "run-new" })).acquired).toBe(false);
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    expect((await acquireMachineLock({ home, runId: "run-new" })).acquired).toBe(true);
  });

  it("hands the lock to the worker process", async () => {
    await acquireMachineLock({ home, runId: "run-a" });
    const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const pid = worker.pid as number;
      const lock = await transferMachineLock({ home, runId: "run-a", pid });
      expect(lock.pid).toBe(pid);
      expect(lock.startTime).toBe(await readProcessStartTime(pid));
      await expect(transferMachineLock({ home, runId: "run-b", pid })).rejects.toThrow();
      expect((await acquireMachineLock({ home, runId: "run-b" })).acquired).toBe(false);
    } finally {
      worker.kill("SIGKILL");
      await once(worker, "exit");
    }
    // The worker is gone, so the lock it held is stale.
    expect((await acquireMachineLock({ home, runId: "run-b" })).acquired).toBe(true);
  });
});
