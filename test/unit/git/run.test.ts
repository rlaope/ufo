import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeFailure } from "../../../src/app/index.js";
import {
  applyToB,
  attributeDrivers,
  checkRepoConfig,
  commitKeep,
  createRunArms,
  diffFromFiles,
  GitError,
  git,
  gitProcessEnv,
  headOfA,
  listChangeIds,
  type Run,
  readFileAtA,
  removeRun,
  removeRunLeaving,
  repoId,
  resetArms,
  resetBTo,
  revertB,
  runBranch,
  withLeftovers,
} from "../../../src/core/git/index.js";
import { newRunId } from "../../../src/core/paths.js";
import {
  checkPaths,
  checkProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
} from "../../../src/core/policy/index.js";
import {
  BASE_FILES,
  gitIn,
  isolateGit,
  makeRepo,
  type Sandbox,
  TEST_EMAIL,
  TEST_NAME,
} from "./helpers.js";

// Every test here runs git, often many times; under load (the full suite beside other work) that
// can take longer than Vitest's defaults (5 s a test, 10 s a hook). A timeout for this file only.
const GIT_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: GIT_TIMEOUT_MS, hookTimeout: GIT_TIMEOUT_MS });

const BASE_APP = BASE_FILES["src/app.js"];

const SPEEDUP_DIFF = [
  "diff --git a/src/app.js b/src/app.js",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,4 +1,4 @@",
  "-export const delayMs = 5;",
  "+export const delayMs = 0;",
  " export function handle() {",
  "   return 'ok';",
  " }",
  "",
].join("\n");

/** Applies before and after SPEEDUP_DIFF: its context does not include line 1. */
const RETURN_DIFF = [
  "diff --git a/src/app.js b/src/app.js",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -2,3 +2,3 @@",
  " export function handle() {",
  "-  return 'ok';",
  "+  return 'fast';",
  " }",
  "",
].join("\n");

/** Renames the test file into src: faster, if the test no longer runs. */
const MOVE_TEST_DIFF = [
  "diff --git a/test/app.test.js b/src/helper.js",
  "similarity index 100%",
  "rename from test/app.test.js",
  "rename to src/helper.js",
  "",
].join("\n");

let sandbox: Sandbox;
let home: string;
let runCount = 0;

beforeAll(() => {
  sandbox = isolateGit();
  home = path.join(sandbox.root, "ufo-home");
  mkdirSync(home, { mode: 0o700 });
});

afterAll(() => sandbox.restore());

function nextRunId(): string {
  runCount += 1;
  return `20261017-1200${String(runCount).padStart(2, "0")}`;
}

function newRepo(files = BASE_FILES): string {
  return makeRepo(sandbox.root, `repo-${randomUUID()}`, files);
}

function head(dir: string): string {
  return gitIn(dir, "rev-parse", "HEAD").trim();
}

function changeFor(run: Run, diff = SPEEDUP_DIFF) {
  return {
    changeId: randomUUID(),
    baseSha: head(run.armA),
    cardId: "toy.no-delay",
    diff,
    hypothesis: "The handler sleeps for delayMs on every request; removing it cuts latency.",
  };
}

const TRAILERS = { metric: "p95_latency_ms 12.1 -> 6.9 (-43.0%)", bundle: "toy-http-2026-10-17.1" };

/**
 * The files of the user's git directory, except the objects and the run branch's ref and
 * reflog: everything else UFO must leave as it was (no `worktrees/`, no FETCH_HEAD, no config).
 */
function gitDirListing(repo: string): string[] {
  const root = path.join(repo, ".git");
  return (readdirSync(root, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join("/"))
    .filter(
      (entry) =>
        !entry.startsWith("objects") &&
        !/^(logs\/)?refs\/heads\/ufo(\/|$)/.test(entry) &&
        !(entry === "logs/refs/heads" || entry === "refs/heads"),
    )
    .sort();
}

/** Everything AC 6 compares: HEAD, branch, porcelain status, index and exclude bytes, files. */
function userState(repo: string) {
  const read = (file: string) =>
    existsSync(path.join(repo, file)) ? readFileSync(path.join(repo, file)) : null;
  return {
    head: head(repo),
    branch: gitIn(repo, "symbolic-ref", "HEAD").trim(),
    status: gitIn(repo, "--no-optional-locks", "status", "--porcelain"),
    index: read(".git/index"),
    exclude: read(".git/info/exclude"),
    gitignore: read(".gitignore"),
    files: ["src/app.js", "test/app.test.js", "package.json", "notes.txt"].map(read),
  };
}

// Code review R2: what is left is named, never put in a command, since the failure that carries it
// reaches you redacted (`~/…`), and a pasted `rm -rf -- '~/…'` would remove nothing.
describe("removeRunLeaving", () => {
  it("names the directory it could not remove, redacted, without a command", async () => {
    const root = path.join(sandbox.root, `it's here ${randomUUID()}`);
    const dir = path.join(root, "run-1");
    mkdirSync(path.join(dir, "a"), { recursive: true });
    chmodSync(root, 0o500);
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(sandbox.root);
    try {
      const left = await removeRunLeaving({ dir } as Run, { deleteBranch: false });
      expect(left).toMatch(
        new RegExp(
          `^could not remove the arms directory ${escapeRegExp(dir)} \\(.+\\); remove that directory and everything in it by hand$`,
        ),
      );
      const failure = describeFailure(withLeftovers(new Error("git clone failed"), left));
      expect(failure.message).toContain(
        `could not remove the arms directory ~${dir.slice(sandbox.root.length)} (`,
      );
      expect(failure.message).not.toContain("rm -rf");
    } finally {
      homedir.mockRestore();
      chmodSync(root, 0o700);
    }
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("repoId", () => {
  it("is stable across subdirectories and linked worktrees and hides the path", async () => {
    const repo = newRepo();
    const id = await repoId(repo);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await repoId(path.join(repo, "src"))).toBe(id);
    const linked = path.join(sandbox.root, `linked-${randomUUID()}`);
    gitIn(repo, "worktree", "add", "--quiet", "--detach", linked);
    expect(await repoId(linked)).toBe(id);
    expect(id).not.toContain(path.basename(repo).slice(0, 8));
  });

  it("differs between repositories", async () => {
    expect(await repoId(newRepo())).not.toBe(await repoId(newRepo()));
  });

  it("refuses a directory outside any repository", async () => {
    const plain = path.join(sandbox.root, `plain-${randomUUID()}`);
    mkdirSync(plain);
    await expect(repoId(plain)).rejects.toMatchObject({ code: "not_a_repo" });
  });
});

describe("createRunArms", () => {
  it("creates the run branch at the user's HEAD and two UFO-owned clones under UFO_HOME", async () => {
    const repo = newRepo();
    gitIn(repo, "config", "alias.ufo-test-local", "status");
    const runId = nextRunId();
    const { run, userTreeDirty } = await createRunArms(repo, runId, { home });
    expect(userTreeDirty).toBe(false);
    expect(run.branch).toBe(`ufo/run-${runId}`);
    expect(run.baseSha).toBe(head(repo));
    expect(run.dir).toBe(path.join(home, "arms", await repoId(repo), runId));
    expect(run.armA).toBe(path.join(run.dir, "a"));
    expect(run.armB).toBe(path.join(run.dir, "b"));
    expect(run.identity).toEqual({ name: TEST_NAME, email: TEST_EMAIL });
    expect(gitIn(run.armA, "symbolic-ref", "HEAD").trim()).toBe(`refs/heads/${run.branch}`);
    expect(head(run.armA)).toBe(run.baseSha);
    expect(() => gitIn(run.armB, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(head(run.armB)).toBe(run.baseSha);
    expect(gitIn(repo, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
    expect(gitIn(repo, "rev-parse", `refs/heads/${run.branch}`).trim()).toBe(run.baseSha);
    // Clones, not worktrees: each arm has its own git directory, no admin data in the user's
    // repository, and none of the repository's own config, hooks, or templates.
    for (const arm of [run.armA, run.armB]) {
      expect(existsSync(path.join(arm, ".git", "commondir"))).toBe(false);
      expect(existsSync(path.join(arm, ".git", "hooks"))).toBe(false);
      expect(readFileSync(path.join(arm, ".git", "config"), "utf8")).not.toContain(
        "ufo-test-local",
      );
    }
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(false);
    expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    await removeRun(run, { deleteBranch: true });
  });

  it("defaults the arms root to UFO_HOME", async () => {
    const repo = newRepo();
    const envHome = path.join(sandbox.root, "env-home");
    mkdirSync(envHome, { mode: 0o700 });
    process.env.UFO_HOME = envHome;
    try {
      const { run } = await createRunArms(repo, nextRunId());
      expect(run.dir.startsWith(path.join(envHome, "arms") + path.sep)).toBe(true);
      await removeRun(run, { deleteBranch: true });
    } finally {
      delete process.env.UFO_HOME;
    }
  });

  it("refuses a branch that already exists", async () => {
    const repo = newRepo();
    const runId = nextRunId();
    gitIn(repo, "branch", runBranch(runId));
    await expect(createRunArms(repo, runId, { home })).rejects.toMatchObject({
      code: "branch_exists",
    });
    expect(existsSync(path.join(home, "arms", await repoId(repo), runId))).toBe(false);
  });

  it("refuses an invalid run id and a repository without commits", async () => {
    await expect(createRunArms(newRepo(), "../escape", { home })).rejects.toMatchObject({
      code: "invalid_run_id",
    });
    const empty = path.join(sandbox.root, `empty-${randomUUID()}`);
    mkdirSync(empty);
    gitIn(empty, "init", "--quiet", "--initial-branch=main");
    await expect(createRunArms(empty, nextRunId(), { home })).rejects.toMatchObject({
      code: "no_commits",
    });
  });

  it("accepts the shared run id format", async () => {
    const runId = newRunId(new Date("2026-10-17T15:30:12.345Z"));
    expect(runId).toMatch(/^20261017-153012-[0-9a-f]{6}$/);
    const { run } = await createRunArms(newRepo(), runId, { home });
    expect(run.branch).toBe(runBranch(runId));
    expect(path.basename(run.dir)).toBe(runId);
  });
});

describe("a full run (AC 6)", () => {
  it("leaves the user's HEAD, status, index, and files byte-identical, with a dirty tree", async () => {
    const repo = newRepo();
    writeFileSync(path.join(repo, "src/app.js"), "// work in progress\n", { flag: "a" });
    writeFileSync(path.join(repo, "package.json"), '{ "name": "toy", "private": true }\n');
    gitIn(repo, "add", "package.json");
    writeFileSync(path.join(repo, "notes.txt"), "untracked notes\n");
    const before = userState(repo);
    const gitDirBefore = gitDirListing(repo);

    const { run, userTreeDirty } = await createRunArms(repo, nextRunId(), { home });
    expect(userTreeDirty).toBe(true);
    // Uncommitted work is not part of the run.
    expect(readFileSync(path.join(run.armA, "src/app.js"), "utf8")).not.toContain("in progress");
    expect(existsSync(path.join(run.armA, "notes.txt"))).toBe(false);

    const kept = changeFor(run);
    const applied = await applyToB(run, kept);
    expect(applied).toEqual({ ok: true, changedPaths: ["src/app.js"] });
    const sha = await commitKeep(run, kept, TRAILERS);
    expect(head(run.armA)).toBe(sha);
    expect(gitIn(repo, "rev-parse", `refs/heads/${run.branch}`).trim()).toBe(sha);

    const dropped = changeFor(run, RETURN_DIFF);
    expect(await applyToB(run, dropped)).toEqual({ ok: true, changedPaths: ["src/app.js"] });
    writeFileSync(path.join(run.armB, "build-output.tmp"), "artifact\n");
    await revertB(run);
    expect(head(run.armB)).toBe(sha);
    expect(gitIn(run.armB, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(run.armB, "build-output.tmp"))).toBe(false);

    await removeRun(run);
    expect(existsSync(run.dir)).toBe(false);
    expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain(run.dir);
    expect(userState(repo)).toEqual(before);
    // Nothing but the run branch and its objects was written to the user's git directory.
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(false);
    expect(gitDirListing(repo)).toEqual(gitDirBefore);
    expect(gitIn(repo, "log", "-1", "--format=%H", run.branch).trim()).toBe(sha);
    // The run branch survives for review, holding exactly the kept change.
    expect(
      gitIn(
        repo,
        "log",
        "--format=%(trailers:key=Ufo-Change-Id,valueonly)",
        `${run.baseSha}..${run.branch}`,
      ).trim(),
    ).toBe(kept.changeId);
  });
});

describe("applyToB", () => {
  it("fails with patch_failed on a stale base SHA and leaves B at A", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const stale = changeFor(run);
    // Advance A with a keep, so the first change's base is stale.
    const first = changeFor(run);
    await applyToB(run, first);
    await commitKeep(run, first, TRAILERS);
    const result = await applyToB(run, stale);
    expect(result).toMatchObject({ ok: false, reason: "patch_failed" });
    expect(result.ok === false && result.detail).toContain(stale.baseSha);
    expect(head(run.armB)).toBe(head(run.armA));
    expect(gitIn(run.armB, "status", "--porcelain")).toBe("");
    await removeRun(run, { deleteBranch: true });
  });

  it("fails with patch_failed and one line of git's stderr when the patch does not apply", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const broken = changeFor(run, SPEEDUP_DIFF.replace("delayMs = 5", "delayMs = 7"));
    const result = await applyToB(run, broken);
    expect(result).toMatchObject({ ok: false, reason: "patch_failed" });
    const detail = result.ok ? "" : result.detail;
    expect(detail).toContain("src/app.js");
    expect(detail).not.toMatch(/\p{Cc}/u);
    expect(gitIn(run.armB, "status", "--porcelain")).toBe("");
    await removeRun(run, { deleteBranch: true });
  });

  it("rejects a protected-path patch before apply, and git's own path list agrees (AC 3)", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const violation = checkProtectedPaths(MOVE_TEST_DIFF, DEFAULT_PROTECTED_PATHS);
    expect(violation).toMatchObject({ rule: "protected_path", subjects: ["test/app.test.js"] });
    // The worker stops here; B was never touched.
    expect(gitIn(run.armB, "status", "--porcelain")).toBe("");
    // Had it applied, the index-derived paths name the same file.
    const applied = await applyToB(run, changeFor(run, MOVE_TEST_DIFF));
    expect(applied.ok && [...applied.changedPaths].sort()).toEqual([
      "src/helper.js",
      "test/app.test.js",
    ]);
    expect(applied.ok && checkPaths(applied.changedPaths, DEFAULT_PROTECTED_PATHS)).toMatchObject({
      rule: "protected_path",
    });
    await revertB(run);
    await removeRun(run, { deleteBranch: true });
  });
});

describe("commitKeep and listChangeIds", () => {
  it("writes all four trailers, authored by the target repository's identity", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const change = changeFor(run);
    await applyToB(run, change);
    const sha = await commitKeep(run, change, TRAILERS);
    const message = gitIn(run.armA, "log", "-1", "--format=%B", sha);
    const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
      cwd: run.armA,
      input: message,
      encoding: "utf8",
    });
    expect(parsed.trim().split("\n")).toEqual([
      `Ufo-Technique: ${change.cardId}`,
      `Ufo-Metric: ${TRAILERS.metric}`,
      `Ufo-Bundle: ${TRAILERS.bundle}`,
      `Ufo-Change-Id: ${change.changeId}`,
    ]);
    expect(gitIn(run.armA, "log", "-1", "--format=%an <%ae>|%cn <%ce>", sha).trim()).toBe(
      `${TEST_NAME} <${TEST_EMAIL}>|${TEST_NAME} <${TEST_EMAIL}>`,
    );
    expect(await listChangeIds(run)).toEqual([{ sha, changeId: change.changeId }]);
    await removeRun(run, { deleteBranch: true });
  });

  it("lists change ids oldest first and ignores trailer-like lines in the hypothesis", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const first = changeFor(run);
    first.hypothesis = `Spoof attempt.\nUfo-Change-Id: ${randomUUID()}\n\nUfo-Change-Id: ${randomUUID()}`;
    expect(await applyToB(run, first)).toMatchObject({ ok: true });
    const firstSha = await commitKeep(run, first, TRAILERS);
    const second = changeFor(
      run,
      [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1,2 +1,2 @@",
        "-export const delayMs = 0;",
        "+export const delayMs = 1;",
        " export function handle() {",
        "",
      ].join("\n"),
    );
    expect(await applyToB(run, second)).toMatchObject({ ok: true });
    const secondSha = await commitKeep(run, second, TRAILERS);
    expect(await listChangeIds(run)).toEqual([
      { sha: firstSha, changeId: first.changeId },
      { sha: secondSha, changeId: second.changeId },
    ]);
    await removeRun(run, { deleteBranch: true });
  });

  it("refuses a change id that is already on the run branch", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const change = changeFor(run);
    await applyToB(run, change);
    await commitKeep(run, change, TRAILERS);
    await expect(commitKeep(run, change, TRAILERS)).rejects.toMatchObject({
      code: "duplicate_change",
    });
    expect(await listChangeIds(run)).toHaveLength(1);
    await removeRun(run, { deleteBranch: true });
  });

  it("refuses a trailer value that is not one line", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const change = changeFor(run);
    await applyToB(run, change);
    await expect(
      commitKeep(run, change, { ...TRAILERS, metric: `fast\nUfo-Change-Id: ${randomUUID()}` }),
    ).rejects.toBeInstanceOf(GitError);
    expect(head(run.armA)).toBe(run.baseSha);
    await removeRun(run, { deleteBranch: true });
  });

  it("never runs the target repository's hooks", async () => {
    const repo = newRepo();
    const marker = path.join(sandbox.root, `hook-ran-${randomUUID()}`);
    for (const hook of [
      "pre-commit",
      "commit-msg",
      "post-commit",
      "post-checkout",
      "post-merge",
      "reference-transaction",
    ]) {
      const file = path.join(repo, ".git/hooks", hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 1\n`);
      chmodSync(file, 0o755);
    }
    const { run } = await createRunArms(repo, nextRunId(), { home });
    const change = changeFor(run);
    await applyToB(run, change);
    await commitKeep(run, change, TRAILERS);
    await removeRun(run, { deleteBranch: true });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("git environment", () => {
  it("ignores GIT_DIR and GIT_WORK_TREE that point at the user's repository", async () => {
    const repo = newRepo();
    writeFileSync(path.join(repo, "notes.txt"), "untracked notes\n");
    const before = userState(repo);
    const { run } = await createRunArms(repo, nextRunId(), { home });
    process.env.GIT_DIR = path.join(repo, ".git");
    process.env.GIT_WORK_TREE = repo;
    try {
      const change = changeFor(run);
      await applyToB(run, change);
      await revertB(run);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
    await removeRun(run, { deleteBranch: true });
    expect(userState(repo)).toEqual(before);
  });
});

describe("git hardening (F3)", () => {
  /** Runs `fn` with `text` appended to the developer-free global config of this sandbox. */
  async function withGlobalConfig(text: string, fn: () => Promise<void>): Promise<void> {
    const file = process.env.GIT_CONFIG_GLOBAL ?? "";
    writeFileSync(file, text);
    try {
      await fn();
    } finally {
      writeFileSync(file, "");
    }
  }

  function markerScript(name: string): { script: string; marker: string } {
    const marker = path.join(sandbox.root, `${name}-${randomUUID()}`);
    const script = path.join(sandbox.root, `${name}-${randomUUID()}.sh`);
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    return { script, marker };
  }

  it("never signs commits, even when the user's config asks for a signing program", async () => {
    const { script, marker } = markerScript("gpg");
    const repo = newRepo();
    await withGlobalConfig(
      `[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${script}\n`,
      async () => {
        const { run } = await createRunArms(repo, nextRunId(), { home });
        const change = changeFor(run);
        await applyToB(run, change);
        const sha = await commitKeep(run, change, TRAILERS);
        expect(gitIn(run.armA, "cat-file", "commit", sha)).not.toContain("gpgsig");
        await removeRun(run, { deleteBranch: true });
      },
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("computes patch diffs without textconv", async () => {
    const { script, marker } = markerScript("textconv");
    const repo = newRepo({ ...BASE_FILES, ".gitattributes": "*.js diff=conv\n" });
    await withGlobalConfig(`[diff "conv"]\n\ttextconv = ${script}\n`, async () => {
      const { run } = await createRunArms(repo, nextRunId(), { home });
      const original = (await readFileAtA(run, "src/app.js")) ?? "";
      const diff = await diffFromFiles(
        run,
        new Map([["src/app.js", original.replace("delayMs = 5", "delayMs = 0")]]),
      );
      expect(diff).toContain("+export const delayMs = 0;");
      await removeRun(run, { deleteBranch: true });
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an arm whose git directory was replaced by a pointer to the user's repository", async () => {
    const repo = newRepo();
    writeFileSync(path.join(repo, "notes.txt"), "untracked notes\n");
    const { run } = await createRunArms(repo, nextRunId(), { home });
    const before = userState(repo);
    rmSync(path.join(run.armB, ".git"), { recursive: true });
    writeFileSync(path.join(run.armB, ".git"), `gitdir: ${path.join(repo, ".git")}\n`);
    await expect(revertB(run)).rejects.toMatchObject({ code: "unsafe_arm" });
    rmSync(path.join(run.armB, ".git"));
    symlinkSync(path.join(repo, ".git"), path.join(run.armB, ".git"));
    await expect(applyToB(run, changeFor(run))).rejects.toMatchObject({ code: "unsafe_arm" });
    rmSync(path.join(run.armB, ".git"));
    // The arms directory itself swapped for a symlink: refused, not followed.
    const moved = `${run.dir}.moved`;
    renameSync(run.dir, moved);
    symlinkSync(moved, run.dir);
    await expect(headOfA(run)).rejects.toMatchObject({ code: "unsafe_arm" });
    rmSync(run.dir);
    renameSync(moved, run.dir);
    expect(await headOfA(run)).toBe(run.baseSha);
    expect(userState(repo)).toEqual(before);
    await removeRun(run, { deleteBranch: true });
    expect(existsSync(path.join(repo, ".git", "HEAD"))).toBe(true);
  });
});

describe("checkRepoConfig (F3 preflight)", () => {
  it.each([
    ["filter.lfs-like.smudge", "cat"],
    ["filter.x.clean", "cat"],
    ["diff.external", "/bin/true"],
    ["diff.x.textconv", "cat"],
    ["diff.x.command", "cat"],
    ["merge.x.driver", "cat %A"],
    ["gpg.program", "/bin/true"],
    ["gpg.ssh.program", "/bin/true"],
    ["core.worktree", "/tmp"],
    ["core.sshCommand", "ssh -o ProxyCommand=true"],
    ["include.path", "../shared.gitconfig"],
    ["includeIf.gitdir:/tmp/.path", "x.gitconfig"],
    ["extensions.worktreeConfig", "true"],
    ["url./tmp/elsewhere.insteadOf", "/"],
    // Security N1: config-based hooks, credential helpers, network settings, remote helper
    // programs, bundle URIs, submodule update commands, and sections UFO does not know.
    ["hook.mark.command", "true"],
    ["credential.helper", "store"],
    ["http.proxy", "http://127.0.0.1:9"],
    ["fetch.bundleURI", "file:///tmp/x.bundle"],
    ["remote.origin.uploadpack", "/bin/true"],
    ["submodule.lib.update", "!true"],
    ["unknownsection.key", "1"],
    // Security review (round 3) N1-a/b/c: recursion into submodules, git-lfs programs and
    // endpoints, and promisor remotes.
    ["submodule.recurse", "true"],
    ["submodule.propagateBranches", "true"],
    ["lfs.customtransfer.x.path", "/bin/true"],
    ["lfs.extension.x.clean", "cat"],
    ["lfs.url", "https://example.invalid/lfs"],
    ["remote.origin.lfsurl", "https://example.invalid/lfs"],
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialCloneFilter", "blob:none"],
  ])(
    "refuses a repository whose config sets %s, before anything is created",
    async (key, value) => {
      const repo = newRepo();
      gitIn(repo, "config", key, value);
      const runId = nextRunId();
      await expect(createRunArms(repo, runId, { home })).rejects.toMatchObject({
        violation: {
          rule: "unsafe_repo_config",
          subjects: [
            key
              .toLowerCase()
              .replace(/^(includeif|url)\.(.*)\.([^.]+)$/, (_m, a, b, c) => `${a}.${b}.${c}`),
          ],
        },
      });
      expect(gitIn(repo, "branch", "--list", runBranch(runId)).trim()).toBe("");
      expect(existsSync(path.join(home, "arms", await repoId(repo), runId))).toBe(false);
    },
  );

  it("runs no config-based hook: the repository is refused before git writes to it", async () => {
    const repo = newRepo();
    const marker = path.join(path.dirname(repo), "hook-ran");
    gitIn(repo, "config", "hook.mark.command", `touch ${marker}`);
    gitIn(repo, "config", "hook.mark.event", "reference-transaction");
    const runId = nextRunId();
    await expect(createRunArms(repo, runId, { home })).rejects.toMatchObject({
      violation: { rule: "unsafe_repo_config" },
    });
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(repo, "branch", "--list", runBranch(runId)).trim()).toBe("");
  });

  it("allows ordinary repository settings, including hooks and fsmonitor that UFO overrides", async () => {
    const repo = newRepo();
    gitIn(repo, "config", "core.hooksPath", ".husky");
    gitIn(repo, "config", "core.fsmonitor", "true");
    gitIn(repo, "config", "diff.x.binary", "true");
    gitIn(repo, "config", "remote.origin.url", "https://example.invalid/toy.git");
    // What `git lfs` itself writes into a repository's config.
    gitIn(repo, "config", "lfs.repositoryformatversion", "0");
    gitIn(repo, "config", "lfs.https://example.invalid/toy.git/info/lfs.access", "basic");
    await expect(checkRepoConfig(repo, head(repo))).resolves.toBeUndefined();
  });

  it("does not recurse into submodules, whose config it never checks, when it writes the run branch", async () => {
    const lib = newRepo();
    const repo = newRepo();
    gitIn(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", lib, "lib");
    gitIn(repo, "commit", "--quiet", "--message", "lib");
    const marker = path.join(path.dirname(repo), `submodule-hook-ran-${randomUUID()}`);
    gitIn(path.join(repo, "lib"), "config", "hook.mark.command", `touch ${marker}`);
    gitIn(path.join(repo, "lib"), "config", "hook.mark.event", "reference-transaction");
    // The user's global config asks for recursion (the repository's own config cannot).
    const global = process.env.GIT_CONFIG_GLOBAL as string;
    const saved = readFileSync(global, "utf8");
    appendFileSync(global, "[submodule]\n\trecurse = true\n\tpropagateBranches = true\n");
    try {
      const runId = nextRunId();
      const { run } = await createRunArms(repo, runId, { home });
      expect(gitIn(repo, "branch", "--list", runBranch(runId)).trim()).not.toBe("");
      expect(existsSync(marker)).toBe(false);
      await removeRun(run, { deleteBranch: true });
    } finally {
      writeFileSync(global, saved);
    }
  });

  it("runs git with absolute PATH entries only, and never fetches a missing object lazily", async () => {
    expect(
      gitProcessEnv({ PATH: ["/usr/bin", ".", "", "bin", "/bin"].join(path.delimiter) }),
    ).toEqual({
      PATH: ["/usr/bin", "/bin"].join(path.delimiter),
    });
    const repo = newRepo();
    const env = await git(["-c", "alias.env=!env", "env"], repo);
    expect(env).toMatch(/^GIT_NO_LAZY_FETCH=1$/m);
  });

  it("refuses attributes that name a driver the repository's config defines", async () => {
    const repo = newRepo({ ...BASE_FILES, "assets/.gitattributes": "*.bin diff=x\n" });
    await expect(checkRepoConfig(repo, head(repo))).resolves.toBeUndefined();
    gitIn(repo, "config", "diff.x.binary", "true");
    await expect(checkRepoConfig(repo, head(repo))).rejects.toMatchObject({
      violation: { rule: "unsafe_repo_config", subjects: ["assets/.gitattributes: diff=x"] },
    });
    gitIn(repo, "config", "--unset", "diff.x.binary");
    writeFileSync(path.join(repo, ".git", "info", "attributes"), "* merge=y\n");
    gitIn(repo, "config", "merge.y.name", "y");
    await expect(checkRepoConfig(repo, head(repo))).rejects.toMatchObject({
      violation: { subjects: [".git/info/attributes: merge=y"] },
    });
  });

  it("reads driver attributes", () => {
    expect(
      attributeDrivers("# c\n*.png binary\n*.dat filter=lfs diff=lfs merge=lfs -text\n\n"),
    ).toEqual([
      { attribute: "filter", driver: "lfs" },
      { attribute: "diff", driver: "lfs" },
      { attribute: "merge", driver: "lfs" },
    ]);
  });
});

describe("removeRun", () => {
  it("keeps the run branch unless asked, and removes empty run directories", async () => {
    const repo = newRepo();
    const { run } = await createRunArms(repo, nextRunId(), { home });
    await removeRun(run);
    expect(gitIn(repo, "branch", "--list", run.branch).trim()).not.toBe("");
    expect(existsSync(path.dirname(run.dir))).toBe(false);
    await removeRun(run, { deleteBranch: true });
    expect(gitIn(repo, "branch", "--list", run.branch).trim()).toBe("");
    expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });
});

describe("readFileAtA and diffFromFiles", () => {
  it("reads committed regular files and turns new content into a diff that applies to B", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const original = await readFileAtA(run, "src/app.js");
    expect(original).toBe(BASE_APP);
    expect(await readFileAtA(run, "missing.js")).toBeUndefined();
    expect(await readFileAtA(run, "src")).toBeUndefined();

    const diff = await diffFromFiles(
      run,
      new Map([["src/app.js", (original ?? "").replace("delayMs = 5", "delayMs = 0")]]),
    );
    expect(diff).toContain("+export const delayMs = 0;");
    expect(gitIn(run.armB, "status", "--porcelain")).toBe("");
    const change = changeFor(run, diff);
    expect(await applyToB(run, change)).toEqual({ ok: true, changedPaths: ["src/app.js"] });
    await revertB(run);
    expect(await diffFromFiles(run, new Map([["src/app.js", original ?? ""]]))).toBe("");
    await removeRun(run, { deleteBranch: true });
  });

  it("refuses to write through a symlink or outside the tree", async () => {
    const repo = newRepo();
    symlinkSync("app.js", path.join(repo, "src/link.js"));
    gitIn(repo, "add", "src/link.js");
    gitIn(repo, "commit", "--quiet", "--message", "link");
    const { run } = await createRunArms(repo, nextRunId(), { home });
    expect(await readFileAtA(run, "src/link.js")).toBeUndefined();
    await expect(diffFromFiles(run, new Map([["src/link.js", "x\n"]]))).rejects.toThrow(
      /not a regular file/,
    );
    await expect(diffFromFiles(run, new Map([["../escape.js", "x\n"]]))).rejects.toThrow(
      /repository-relative/,
    );
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(BASE_APP);
    expect(gitIn(run.armB, "status", "--porcelain")).toBe("");
    await removeRun(run, { deleteBranch: true });
  });
});

describe("resetBTo and resetArms", () => {
  it("puts B at the base SHA for the final check and resets both arms after a crash", async () => {
    const { run } = await createRunArms(newRepo(), nextRunId(), { home });
    const kept = changeFor(run);
    await applyToB(run, kept);
    const sha = await commitKeep(run, kept, TRAILERS);

    await resetBTo(run, run.baseSha);
    expect(head(run.armB)).toBe(run.baseSha);
    expect(head(run.armA)).toBe(sha);
    await expect(resetBTo(run, "0".repeat(40))).rejects.toThrow();

    // Leftovers of an interrupted job in both arms.
    writeFileSync(path.join(run.armA, "src/app.js"), "partial\n");
    writeFileSync(path.join(run.armA, "stray.tmp"), "x\n");
    writeFileSync(path.join(run.armB, "src/app.js"), "partial\n");
    expect(await resetArms(run)).toBe(sha);
    expect(await headOfA(run)).toBe(sha);
    expect(head(run.armB)).toBe(sha);
    for (const arm of [run.armA, run.armB]) {
      expect(gitIn(arm, "status", "--porcelain")).toBe("");
    }
    await removeRun(run, { deleteBranch: true });
  });
});
