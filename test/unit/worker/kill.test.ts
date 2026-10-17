import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRun,
  isProcessGroupAlive,
  readRun,
  updateRun,
} from "../../../src/core/jobs/index.js";
import {
  type Exec,
  killRunProcesses,
  runContainerLabel,
  trackChildGroup,
  trackContainerLabel,
  trackPort,
  untrackChildGroup,
} from "../../../src/worker/index.js";

const RUN_ID = "run-kill";
const ID_1 = "0123456789ab";
const ID_2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const OTHER_RUNS_CONTAINER = "aaaaaaaaaaaa";

let root: string;
let runDir: string;
const leftovers: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-kill-"));
  ({ runDir } = await createRun(root, { runId: RUN_ID, repoId: "repo" }));
});

afterEach(async () => {
  for (const pgid of leftovers.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
});

function fakeDocker(containers: Record<string, string[]>) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "version") return { stdout: "29.0.0\n" };
    if (args[0] === "ps") {
      const label = String(args[3]).replace(/^label=/, "");
      return { stdout: `${(containers[label] ?? []).join("\n")}\nnot-an-id\n` };
    }
    return { stdout: "" };
  };
  return { exec, calls };
}

function spawnGroup(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid === undefined) throw new Error("no pid");
  leftovers.push(child.pid);
  return child.pid;
}

describe("killRunProcesses", () => {
  it("removes only containers labeled for this run", async () => {
    await trackContainerLabel(runDir, `${runContainerLabel(RUN_ID)}.b`);
    const { exec, calls } = fakeDocker({
      [runContainerLabel(RUN_ID)]: [ID_1],
      [`${runContainerLabel(RUN_ID)}.b`]: [ID_2, ID_1],
      [runContainerLabel("run-other")]: [OTHER_RUNS_CONTAINER],
    });
    const report = await killRunProcesses(runDir, { exec });
    expect(report.containers).toEqual({ dockerAvailable: true, removed: [ID_1, ID_2] });
    expect(calls).toContainEqual(["docker", "ps", "-aq", "--filter", `label=ufo.run=${RUN_ID}`]);
    expect(calls).toContainEqual(["docker", "rm", "-f", ID_1, ID_2]);
    expect(calls.flat()).not.toContain(OTHER_RUNS_CONTAINER);
  });

  it("reports a missing Docker without failing", async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    };
    const report = await killRunProcesses(runDir, { exec });
    expect(report.containers).toEqual({
      dockerAvailable: false,
      removed: [],
      error: "spawn docker ENOENT",
    });
  });

  it("reports a failed docker command without failing", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[0] === "version") return { stdout: "29.0.0" };
      throw new Error("permission denied");
    };
    const report = await killRunProcesses(runDir, { exec });
    expect(report.containers).toEqual({
      dockerAvailable: true,
      removed: [],
      error: "permission denied",
    });
  });

  it("does not signal itself, exited groups, or a PID that was reused", async () => {
    const reused = spawnGroup();
    const exited = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    await once(exited, "exit");
    await updateRun(runDir, (run) => ({
      ...run,
      childGroups: [
        { pgid: process.pid },
        { pgid: exited.pid as number },
        { pgid: reused, startTime: "Thu Jan  1 00:00:00 1970" },
      ],
    }));
    const report = await killRunProcesses(runDir, { exec: fakeDocker({}).exec });
    expect(report.terminated).toEqual([]);
    expect(report.skipped).toEqual([
      { pgid: process.pid, reason: "self" },
      { pgid: exited.pid, reason: "not_running" },
      { pgid: reused, reason: "pid_reused" },
    ]);
    expect(isProcessGroupAlive(reused)).toBe(true);
  });

  it("terminates a tracked group that exits on SIGTERM", async () => {
    const pgid = spawnGroup();
    const group = await trackChildGroup(runDir, pgid);
    expect(group.startTime).toBeDefined();
    const report = await killRunProcesses(runDir, { exec: fakeDocker({}).exec });
    expect(report).toMatchObject({ terminated: [pgid], killed: [], survivors: [] });
    expect(isProcessGroupAlive(pgid)).toBe(false);
  });
});

describe("tracking", () => {
  it("records child groups, ports, and labels once each", async () => {
    const pgid = spawnGroup();
    await trackChildGroup(runDir, pgid);
    await trackChildGroup(runDir, pgid);
    await trackPort(runDir, 18080);
    await trackPort(runDir, 18080);
    await trackContainerLabel(runDir, runContainerLabel(RUN_ID));
    await trackContainerLabel(runDir, runContainerLabel(RUN_ID));
    let run = await readRun(runDir);
    expect(run.childGroups.map((g) => g.pgid)).toEqual([pgid]);
    expect(run.ports).toEqual([18080]);
    expect(run.containerLabels).toEqual([`ufo.run=${RUN_ID}`]);

    await untrackChildGroup(runDir, pgid);
    run = await readRun(runDir);
    expect(run.childGroups).toEqual([]);
  });

  it("refuses ids and labels that are not this run's", async () => {
    await expect(trackChildGroup(runDir, 1)).rejects.toThrow();
    await expect(trackPort(runDir, 70_000)).rejects.toThrow();
    await expect(trackContainerLabel(runDir, runContainerLabel("run-other"))).rejects.toThrow(
      /does not belong/,
    );
    await expect(trackContainerLabel(runDir, `${runContainerLabel(RUN_ID)}x`)).rejects.toThrow();
    await expect(trackContainerLabel(runDir, "com.example=1")).rejects.toThrow();
  });
});
