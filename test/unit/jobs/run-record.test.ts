import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendLedger,
  createRunState,
  enqueueJob,
  JOBS_DIR,
  LEDGER_FILE,
  listJobs,
  newRunId,
  parseRunDir,
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
import {
  assertTrustedDir,
  ensureTrustedDir,
  TrustError,
  trustedHome,
} from "../../../src/core/paths.js";

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

  it("keys run state by repository under the private root, and rejects escaping ids", () => {
    expect(runDirFor(root, "0123456789abcdef", "run-1")).toBe(
      path.join(root, "private", "runs", "0123456789abcdef", "run-1"),
    );
    expect(() => runDirFor(root, "repo", "../escape")).toThrow();
    expect(() => runDirFor(root, "repo", "a/b")).toThrow();
    expect(() => runDirFor(root, "..", "run-1")).toThrow();
    expect(() => runDirFor(root, "a/b", "run-1")).toThrow();
  });

  it("parses only exact run directories of the home", () => {
    const runDir = runDirFor(root, "repo", "run-1");
    expect(parseRunDir(root, runDir)).toEqual({ repoId: "repo", runId: "run-1" });
    expect(parseRunDir(root, path.join(runDir, "jobs"))).toBeUndefined();
    expect(parseRunDir(root, path.dirname(runDir))).toBeUndefined();
    expect(parseRunDir(path.join(root, "other"), runDir)).toBeUndefined();
    expect(
      parseRunDir(root, path.join(root, "private", "runs", "repo", "..", "x")),
    ).toBeUndefined();
  });

  it("generates sortable, path-safe run ids", () => {
    const id = newRunId(new Date("2026-10-17T15:30:00.123Z"));
    expect(id).toMatch(/^20261017-153000-[0-9a-f]{6}$/);
    expect(() => runDirFor(root, "repo", id)).not.toThrow();
  });
});

describe("trusted home (F15)", () => {
  it("creates a missing home with mode 0700 and returns its real path", async () => {
    const home = path.join(root, "new-home");
    expect(await trustedHome(home)).toBe(home);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlink, a file, a group- or world-writable home, and one inside the repository", async () => {
    const real = path.join(root, "real");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, path.join(root, "link"));
    await expect(trustedHome(path.join(root, "link"))).rejects.toMatchObject({
      code: "unsafe_home",
      message: expect.stringContaining("symbolic link"),
    });
    await writeFile(path.join(root, "file"), "");
    await expect(trustedHome(path.join(root, "file"))).rejects.toMatchObject({
      code: "unsafe_home",
    });
    for (const mode of [0o770, 0o757, 0o777]) {
      await chmod(real, mode);
      await expect(trustedHome(real)).rejects.toMatchObject({
        code: "unsafe_home",
        message: expect.stringContaining("writable by group or others"),
      });
    }
    await chmod(real, 0o750);
    expect(await trustedHome(real)).toBe(real);
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    for (const inside of [path.join(repo, ".ufo"), path.join(repo, ".git", "ufo"), repo]) {
      await expect(
        trustedHome(inside, { outside: [repo, path.join(repo, ".git")] }),
      ).rejects.toMatchObject({ code: "unsafe_home", message: expect.stringContaining("inside") });
    }
    expect(await trustedHome(real, { outside: [repo] })).toBe(real);
  });

  it("refuses a home owned by another user", async () => {
    const home = path.join(root, "theirs");
    await mkdir(home, { mode: 0o700 });
    const uid = (await stat(home)).uid;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(trustedHome(home)).rejects.toMatchObject({
        code: "unsafe_home",
        message: expect.stringContaining("not owned by the current user"),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("creates state directories 0700 and refuses planted symlinks on the way (F7)", async () => {
    const dir = path.join(root, "private", "runs", "repo");
    await ensureTrustedDir(root, dir);
    for (const part of ["private", "private/runs", "private/runs/repo"]) {
      expect((await stat(path.join(root, part))).mode & 0o777).toBe(0o700);
    }
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(root, "private", "runs", "planted"));
    const planted = path.join(root, "private", "runs", "planted", "run-1");
    await expect(ensureTrustedDir(root, planted)).rejects.toBeInstanceOf(TrustError);
    await expect(assertTrustedDir(root, path.dirname(planted))).rejects.toMatchObject({
      code: "unsafe_state",
    });
    expect(await readdir(elsewhere)).toEqual([]);
    await expect(ensureTrustedDir(root, path.join(os.tmpdir(), "x"))).rejects.toMatchObject({
      code: "unsafe_state",
    });
  });
});

describe("run record", () => {
  it("creates the run directory layout under the private root, 0700 dirs and 0600 files", async () => {
    const { runDir, run } = await createRunState(root, {
      runId: "run-1",
      repoId: "repo",
      shas: { baseline: SHA, a: SHA },
    });
    expect(runDir).toBe(path.join(root, "private", "runs", "repo", "run-1"));
    expect((await readdir(runDir)).sort()).toEqual(
      ["artifacts", "jobs", "logs", RUN_FILE, "samples"].sort(),
    );
    expect(run).toMatchObject({ status: "running", childGroups: [], ports: [] });
    expect(await readRun(runDir)).toEqual(run);
    expect((await stat(runDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(runDir, JOBS_DIR))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(runDir, RUN_FILE))).mode & 0o777).toBe(0o600);
  });

  it("refuses planted symlinks instead of following them (F7)", async () => {
    const { runDir } = await createRunState(root, { runId: "run-1", repoId: "repo" });
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "victim"), "untouched\n");
    // A symlink in place of the ledger: the append must not write through it.
    await symlink(path.join(outside, "victim"), path.join(runDir, LEDGER_FILE));
    await expect(appendLedger(runDir, { type: "observation" })).rejects.toMatchObject({
      code: "unsafe_state",
    });
    expect(await readFile(path.join(outside, "victim"), "utf8")).toBe("untouched\n");
    // A symlinked jobs directory: neither listing nor enqueueing follows it.
    await rm(path.join(runDir, JOBS_DIR), { recursive: true });
    await symlink(outside, path.join(runDir, JOBS_DIR));
    await expect(listJobs(runDir)).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(enqueueJob(runDir, { kind: "echo", input: {} })).rejects.toMatchObject({
      code: "unsafe_state",
    });
    expect((await readdir(outside)).sort()).toEqual(["victim"]);
    // A symlink in place of run.json is not read.
    await writeFile(path.join(outside, "run.json"), "{}");
    await rm(path.join(runDir, RUN_FILE));
    await symlink(path.join(outside, "run.json"), path.join(runDir, RUN_FILE));
    await expect(readRun(runDir)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("refuses to create a run that exists", async () => {
    await createRunState(root, { runId: "run-1", repoId: "repo" });
    await expect(createRunState(root, { runId: "run-1", repoId: "repo" })).rejects.toThrow();
  });

  it("keeps every concurrent update", async () => {
    const { runDir } = await createRunState(root, { runId: "run-1", repoId: "repo" });
    const ports = Array.from({ length: 20 }, (_, i) => 9000 + i);
    await Promise.all(
      ports.map((port) => updateRun(runDir, (run) => ({ ...run, ports: [...run.ports, port] }))),
    );
    expect((await readRun(runDir)).ports.sort()).toEqual(ports);
  });

  it("requires a start time for the worker and every child group it records (F6)", async () => {
    const { runDir } = await createRunState(root, { runId: "run-1", repoId: "repo" });
    const launchedAt = new Date().toISOString();
    await expect(
      updateRun(runDir, (run) => ({ ...run, worker: { pid: 4242, launchedAt } as never })),
    ).rejects.toThrow();
    await expect(
      updateRun(runDir, (run) => ({ ...run, childGroups: [{ pgid: 4242 } as never] })),
    ).rejects.toThrow();
    expect(await readRun(runDir)).toMatchObject({ childGroups: [] });
    expect((await readRun(runDir)).worker).toBeUndefined();
  });

  it("rejects an update that breaks the schema", async () => {
    const { runDir } = await createRunState(root, { runId: "run-1", repoId: "repo" });
    await expect(updateRun(runDir, (run) => ({ ...run, ports: [0] }))).rejects.toThrow();
    expect((await readRun(runDir)).ports).toEqual([]);
    await expect(stat(path.join(runDir, RUN_LOCK_FILE))).rejects.toThrow();
  });

  it("takes over a run lock whose holder died", async () => {
    const { runDir } = await createRunState(root, { runId: "run-1", repoId: "repo" });
    await writeFile(path.join(runDir, RUN_LOCK_FILE), String(await deadPid()));
    expect(await withRunLock(runDir, async () => "ran")).toBe("ran");
  });
});

describe("writeJsonAtomic", () => {
  it("leaves the previous content intact when a write died before its rename", async () => {
    const file = path.join(root, "state.json");
    await writeJsonAtomic(file, { version: 1, items: [1, 2, 3] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
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
