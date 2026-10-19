import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAppWorker, trustedRunDir } from "../../../src/app/index.js";
import { createRunState, RUN_FILE, writeJsonAtomic } from "../../../src/core/jobs/index.js";

// Security F12: `ufo worker --run-dir` works only on a run directory under its own trusted
// home, with a run record naming that run.

let root: string;
let home: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-worker-dir-")));
  home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("trustedRunDir", () => {
  it("accepts a run directory of the home, also through a symlink to it", async () => {
    const { runDir } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    expect(await trustedRunDir(home, runDir)).toBe(runDir);
    await symlink(runDir, path.join(root, "alias"));
    expect(await trustedRunDir(home, path.join(root, "alias"))).toBe(runDir);
  });

  it("refuses directories outside the runs root, inside a run, or with another run's record", async () => {
    const { runDir } = await createRunState(home, { runId: "run-1", repoId: "repo" });
    const elsewhere = path.join(root, "elsewhere", "private", "runs", "repo", "run-1");
    await mkdir(elsewhere, { recursive: true });
    for (const dir of [elsewhere, path.join(runDir, "jobs"), path.dirname(runDir), root]) {
      await expect(trustedRunDir(home, dir)).rejects.toMatchObject({ code: "unsafe_state" });
    }
    // A record copied from another run does not make this directory that run's.
    const { run } = await createRunState(home, { runId: "run-2", repoId: "repo" });
    await writeJsonAtomic(path.join(runDir, RUN_FILE), { ...run });
    await expect(trustedRunDir(home, runDir)).rejects.toMatchObject({
      code: "unsafe_state",
      message: expect.stringContaining("names another run"),
    });
  });

  it("refuses a run directory reached through a symlinked component of the home", async () => {
    const real = path.join(root, "real-runs");
    await mkdir(path.join(real, "repo", "run-1"), { recursive: true });
    await mkdir(path.join(home, "private"), { mode: 0o700 });
    await symlink(real, path.join(home, "private", "runs"));
    const given = path.join(home, "private", "runs", "repo", "run-1");
    await expect(trustedRunDir(home, given)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("is checked before the worker loop starts", async () => {
    const saved = process.env.UFO_HOME;
    process.env.UFO_HOME = home;
    try {
      await expect(
        runAppWorker(["worker", "--run-dir", path.join(root, "elsewhere")]),
      ).rejects.toMatchObject({ code: "unsafe_state" });
    } finally {
      if (saved === undefined) delete process.env.UFO_HOME;
      else process.env.UFO_HOME = saved;
    }
  });
});
