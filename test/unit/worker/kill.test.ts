import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHILDREN_FILE,
  createRunState,
  isProcessGroupAlive,
  readProcessStartTime,
  readRun,
  updateRun,
  writeJsonAtomic,
} from "../../../src/core/jobs/index.js";
import {
  type Exec,
  killRunProcesses,
  readChildGroups,
  runContainerLabel,
  trackChildGroup,
  trackContainerLabel,
  trackPort,
  untrackChildGroup,
  workerArgv,
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
  ({ runDir } = await createRunState(root, { runId: RUN_ID, repoId: "repo" }));
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

function spawnGroup(...args: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], {
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
    await writeJsonAtomic(path.join(runDir, CHILDREN_FILE), [
      { pgid: process.pid, startTime: "Thu Jan  1 00:00:00 1970" },
      { pgid: exited.pid as number, startTime: "Thu Jan  1 00:00:00 1970" },
      { pgid: reused, startTime: "Thu Jan  1 00:00:00 1970" },
    ]);
    const report = await killRunProcesses(runDir, { exec: fakeDocker({}).exec });
    expect(report.terminated).toEqual([]);
    expect(report.skipped).toEqual([
      { pgid: process.pid, reason: "self" },
      { pgid: exited.pid, reason: "not_running" },
      { pgid: reused, reason: "pid_reused" },
    ]);
    expect(isProcessGroupAlive(reused)).toBe(true);
  });

  it("signals a recorded worker only while it still runs this run's worker command (F6)", async () => {
    // A live process with the recorded start time, but not `worker --run-dir <runDir>`.
    const impostor = spawnGroup();
    const startTime = await readProcessStartTime(impostor);
    if (startTime === undefined) throw new Error("no start time");
    const launchedAt = new Date().toISOString();
    await updateRun(runDir, (run) => ({
      ...run,
      worker: { pid: impostor, startTime, launchedAt },
    }));
    const refused = await killRunProcesses(runDir, { exec: fakeDocker({}).exec });
    expect(refused.terminated).toEqual([]);
    expect(refused.skipped).toEqual([{ pgid: impostor, reason: "not_ufo_worker" }]);
    expect(isProcessGroupAlive(impostor)).toBe(true);

    // The same check passes for a process that runs this run's worker command line.
    const worker = spawnGroup(...workerArgv(runDir));
    const workerStart = await readProcessStartTime(worker);
    if (workerStart === undefined) throw new Error("no start time");
    await updateRun(runDir, (run) => ({
      ...run,
      worker: { pid: worker, startTime: workerStart, launchedAt },
    }));
    const report = await killRunProcesses(runDir, { exec: fakeDocker({}).exec, graceMs: 2000 });
    expect(report.terminated).toEqual([worker]);
    expect(isProcessGroupAlive(worker)).toBe(false);
  });

  it("filters recorded container labels to this run's own when it kills (F6)", async () => {
    // run.json names another run's label, as edited state could.
    await updateRun(runDir, (run) => ({
      ...run,
      containerLabels: [runContainerLabel("run-other"), `${runContainerLabel(RUN_ID)}.a`],
    }));
    const { exec, calls } = fakeDocker({
      [runContainerLabel("run-other")]: [OTHER_RUNS_CONTAINER],
      [`${runContainerLabel(RUN_ID)}.a`]: [ID_1],
    });
    const report = await killRunProcesses(runDir, { exec });
    expect(report.containers).toEqual({ dockerAvailable: true, removed: [ID_1] });
    expect(calls).not.toContainEqual([
      "docker",
      "ps",
      "-aq",
      "--filter",
      `label=${runContainerLabel("run-other")}`,
    ]);
    expect(calls.flat()).not.toContain(OTHER_RUNS_CONTAINER);
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
    const run = await readRun(runDir);
    expect((await readChildGroups(runDir)).map((g) => g.pgid)).toEqual([pgid]);
    expect(run.ports).toEqual([18080]);
    expect(run.containerLabels).toEqual([`ufo.run=${RUN_ID}`]);

    await untrackChildGroup(runDir, pgid);
    expect(await readChildGroups(runDir)).toEqual([]);
  });

  it("keeps child groups out of run.json, and reads an invalid or torn list as none (N5, F6)", async () => {
    await trackChildGroup(runDir, spawnGroup());
    expect(Object.keys(await readRun(runDir))).not.toContain("childGroups");
    // A group without a start time is not trusted to be signalled.
    await writeJsonAtomic(path.join(runDir, CHILDREN_FILE), [{ pgid: 4242 }]);
    expect(await readChildGroups(runDir)).toEqual([]);
    await writeFile(path.join(runDir, CHILDREN_FILE), '[{"pgid": 42');
    expect(await readChildGroups(runDir)).toEqual([]);
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
