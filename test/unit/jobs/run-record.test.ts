import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRun,
  newRunId,
  RUN_FILE,
  RUN_LOCK_FILE,
  readJsonIfExists,
  readRun,
  resolveGitCommonDir,
  runDirFor,
  ufoHome,
  updateRun,
  withRunLock,
  writeJsonAtomic,
} from "../../../src/core/jobs/index.js";

const execFileAsync = promisify(execFile);
const SHA = "0123456789abcdef0123456789abcdef01234567";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-run-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

describe("paths", () => {
  it("uses UFO_HOME, else ~/.ufo", () => {
    expect(ufoHome({ UFO_HOME: path.join(root, "home") })).toBe(path.join(root, "home"));
    expect(ufoHome({})).toBe(path.join(os.homedir(), ".ufo"));
  });

  it("resolves the shared git dir from the main worktree, a subdirectory, and a linked worktree", async () => {
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, "sub"), { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileAsync("git", args, { cwd });
    await git(repo, "init", "-q");
    await git(
      repo,
      "-c",
      "user.name=ufo-test",
      "-c",
      "user.email=ufo-test@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    await git(repo, "worktree", "add", "-q", path.join(root, "linked"));
    const expected = path.join(repo, ".git");
    expect(await resolveGitCommonDir(repo)).toBe(expected);
    expect(await resolveGitCommonDir(path.join(repo, "sub"))).toBe(expected);
    expect(await realpath(await resolveGitCommonDir(path.join(root, "linked")))).toBe(expected);
  });

  it("rejects run ids that could escape the runs directory", () => {
    expect(() => runDirFor(root, "../escape")).toThrow();
    expect(() => runDirFor(root, "a/b")).toThrow();
    expect(runDirFor(root, "run-1")).toBe(path.join(root, "ufo", "runs", "run-1"));
  });

  it("generates sortable, path-safe run ids", () => {
    const id = newRunId(new Date("2026-10-17T15:30:00.123Z"));
    expect(id).toMatch(/^20261017-153000-[0-9a-f]{6}$/);
    expect(() => runDirFor(root, id)).not.toThrow();
  });
});

describe("run record", () => {
  it("creates the run directory layout", async () => {
    const { runDir, run } = await createRun(root, {
      runId: "run-1",
      repoId: "repo",
      branch: "ufo/run-20261017",
      shas: { baseline: SHA, a: SHA },
    });
    expect(runDir).toBe(path.join(root, "ufo", "runs", "run-1"));
    expect((await readdir(runDir)).sort()).toEqual(
      ["artifacts", "jobs", "logs", RUN_FILE, "samples"].sort(),
    );
    expect(run).toMatchObject({ status: "running", childGroups: [], ports: [] });
    expect(await readRun(runDir)).toEqual(run);
  });

  it("refuses to create a run that exists", async () => {
    await createRun(root, { runId: "run-1", repoId: "repo" });
    await expect(createRun(root, { runId: "run-1", repoId: "repo" })).rejects.toThrow();
  });

  it("keeps every concurrent update", async () => {
    const { runDir } = await createRun(root, { runId: "run-1", repoId: "repo" });
    const ports = Array.from({ length: 20 }, (_, i) => 9000 + i);
    await Promise.all(
      ports.map((port) => updateRun(runDir, (run) => ({ ...run, ports: [...run.ports, port] }))),
    );
    expect((await readRun(runDir)).ports.sort()).toEqual(ports);
  });

  it("rejects an update that breaks the schema", async () => {
    const { runDir } = await createRun(root, { runId: "run-1", repoId: "repo" });
    await expect(updateRun(runDir, (run) => ({ ...run, ports: [0] }))).rejects.toThrow();
    expect((await readRun(runDir)).ports).toEqual([]);
    await expect(stat(path.join(runDir, RUN_LOCK_FILE))).rejects.toThrow();
  });

  it("takes over a run lock whose holder died", async () => {
    const { runDir } = await createRun(root, { runId: "run-1", repoId: "repo" });
    await writeFile(path.join(runDir, RUN_LOCK_FILE), String(await deadPid()));
    expect(await withRunLock(runDir, async () => "ran")).toBe("ran");
  });
});

describe("writeJsonAtomic", () => {
  it("leaves the previous content intact when a write died before its rename", async () => {
    const file = path.join(root, "state.json");
    await writeJsonAtomic(file, { version: 1, items: [1, 2, 3] });
    // What a crash between writing the temp file and renaming it leaves behind.
    await writeFile(`${file}.12345.deadbeef.tmp`, '{"version": 2, "ite');
    expect(await readJsonIfExists(file)).toEqual({ version: 1, items: [1, 2, 3] });

    await writeJsonAtomic(file, { version: 2, items: [] });
    expect(await readJsonIfExists(file)).toEqual({ version: 2, items: [] });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 2, items: [] });
  });

  it("does not touch the target when serialization fails", async () => {
    const file = path.join(root, "state.json");
    await writeJsonAtomic(file, { version: 1 });
    await expect(writeJsonAtomic(file, { big: 1n })).rejects.toThrow();
    expect(await readJsonIfExists(file)).toEqual({ version: 1 });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
