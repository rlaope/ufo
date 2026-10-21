import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LockTimeoutError,
  readProcessStartTime,
  withLockFile,
} from "../../../src/core/jobs/index.js";

// M5 V4 (security-m2a L5): a lock names its holder by PID and start time, so a PID another
// process reused does not keep it busy, and one stale lock has one taker.

const fault = vi.hoisted(() => ({
  /** Runs before each `rm` of a path, which goes ahead when it resolves. */
  beforeRm: undefined as ((file: string) => Promise<void>) | undefined,
}));

const clock = vi.hoisted(() => ({
  /** Replaces the start time `ps` or /proc gives for a PID. */
  startTimeOf: undefined as ((pid: number) => Promise<string | undefined>) | undefined,
}));

vi.mock("../../../src/core/jobs/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/jobs/process.js")>();
  return {
    ...actual,
    readProcessStartTime: (pid: number) => (clock.startTimeOf ?? actual.readProcessStartTime)(pid),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await fault.beforeRm?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const options = { timeoutMs: 300, retryMs: 5 };
let root: string;
let file: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-lock-")));
  file = path.join(root, "a.lock");
});

afterEach(async () => {
  fault.beforeRm = undefined;
  clock.startTimeOf = undefined;
  await rm(root, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

describe("lock file", () => {
  it("records the holder's PID and start time, and removes the lock after", async () => {
    const seen = await withLockFile(file, options, async () => readFile(file, "utf8"));
    expect(JSON.parse(seen)).toEqual({
      pid: process.pid,
      startTime: await readProcessStartTime(process.pid),
    });
    await expect(stat(file)).rejects.toThrow();
  });

  it("takes over a lock whose PID is alive but started at another time (reused PID)", async () => {
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970" }),
    );
    expect(await withLockFile(file, options, async () => "ran")).toBe("ran");
    expect(await readdir(root)).toEqual([]);
  });

  it("waits for a lock whose holder is alive with the recorded start time", async () => {
    const held = JSON.stringify({
      pid: process.pid,
      startTime: await readProcessStartTime(process.pid),
    });
    await writeFile(file, held);
    const ran = vi.fn(async () => "ran");
    await expect(withLockFile(file, options, ran)).rejects.toBeInstanceOf(LockTimeoutError);
    expect(ran).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(held);
  });

  // M5 V4 review: a clock step moves what `ps` says a live process started at.
  it("waits for a live holder whose start time a clock step moved, and takes over a reused PID", async () => {
    for (const [recorded, now, stale] of [
      ["Wed Oct 22 00:21:24 2026", "Wed Oct 22 00:21:26 2026", false],
      ["ticks:555", "ticks:555", false],
      ["Wed Oct 22 00:21:24 2026", "Wed Oct 22 03:21:24 2026", true],
      ["ticks:555", "ticks:556", true],
    ] as const) {
      clock.startTimeOf = async () => now;
      const held = JSON.stringify({ pid: process.pid, startTime: recorded });
      await writeFile(file, held);
      const ran = vi.fn(async () => "ran");
      if (stale) {
        expect(await withLockFile(file, options, ran), recorded).toBe("ran");
        await expect(stat(file)).rejects.toThrow();
      } else {
        await expect(withLockFile(file, options, ran), recorded).rejects.toBeInstanceOf(
          LockTimeoutError,
        );
        expect(ran).not.toHaveBeenCalled();
        expect(await readFile(file, "utf8")).toBe(held);
        await rm(file);
      }
    }
  });

  it("still takes over a lock of the old shape (a bare PID) whose holder died", async () => {
    await writeFile(file, String(await deadPid()));
    expect(await withLockFile(file, options, async () => "ran")).toBe("ran");
  });

  it("clears the claim of a taker that died mid-takeover, after a while", async () => {
    await writeFile(file, String(await deadPid()));
    const { ino } = await stat(file);
    await link(file, `${file}.${ino}.takeover`);
    const started = Date.now();
    expect(await withLockFile(file, { timeoutMs: 5000, retryMs: 20 }, async () => "ran")).toBe(
      "ran",
    );
    expect(Date.now() - started).toBeGreaterThan(1500);
    expect(await readdir(root)).toEqual([]);
  });

  it("lets one taker of a stale lock in, even when another judged it stale first", async () => {
    await writeFile(file, String(await deadPid()));
    let inside = 0;
    let most = 0;
    let someoneInside: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      someoneInside = resolve;
    });
    let held = false;
    // The first removal of the stale lock stalls until another taker is inside, or 500 ms: a
    // taker that removed a lock it judged stale earlier would remove the new holder's lock.
    fault.beforeRm = async (target) => {
      if (target !== file || held) return;
      held = true;
      await Promise.race([entered, new Promise((resolve) => setTimeout(resolve, 500))]);
    };
    await Promise.all(
      Array.from({ length: 2 }, () =>
        withLockFile(file, { timeoutMs: 5000, retryMs: 5 }, async () => {
          most = Math.max(most, ++inside);
          someoneInside();
          await new Promise((resolve) => setTimeout(resolve, 50));
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });
});
