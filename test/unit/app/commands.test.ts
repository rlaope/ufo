import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../../src/app/index.js";
import { createRunState, readRun } from "../../../src/core/jobs/index.js";

// Code review #16: once a stopped command's group is gone, nothing signals its id again.

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-commands-")));
  ({ runDir } = await createRunState(root, { runId: "run-cmd", repoId: "repo" }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("clears the delayed SIGKILL once a timed-out command exited", async () => {
    const kill = vi.spyOn(process, "kill");
    const result = await runCommand("sleep 30", {
      runDir,
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      label: "a test",
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    const group = kill.mock.calls.find(([, signal]) => signal === "SIGTERM")?.[0];
    expect(typeof group === "number" && group < 0).toBe(true);
    const signalledBefore = kill.mock.calls.filter(([target]) => target === group).length;
    // Past the grace period after which the delayed SIGKILL would have fired.
    await delay(2500);
    expect(kill.mock.calls.filter(([target]) => target === group).length).toBe(signalledBefore);
    expect((await readRun(runDir)).childGroups).toEqual([]);
  });

  it("runs with exactly the given environment", async () => {
    const result = await runCommand("env", {
      runDir,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", ONLY_THIS: "1" },
      label: "a env",
    });
    const names = result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))
      .sort();
    expect(names).toEqual(["ONLY_THIS", "PATH"]);
  });
});
