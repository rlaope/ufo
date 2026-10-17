import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyToB,
  commitKeep,
  createRun,
  GitError,
  listChangeIds,
  newRunId,
  type Run,
  removeRun,
  repoId,
  revertB,
  runBranch,
} from "../../../src/core/git/index.js";
import {
  checkPaths,
  checkProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
} from "../../../src/core/policy/index.js";
import { gitIn, isolateGit, makeRepo, type Sandbox, TEST_EMAIL, TEST_NAME } from "./helpers.js";

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
});

afterAll(() => sandbox.restore());

function nextRunId(): string {
  runCount += 1;
  return `20261017-1200${String(runCount).padStart(2, "0")}`;
}

function newRepo(): string {
  return makeRepo(sandbox.root, `repo-${randomUUID()}`);
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

describe("createRun", () => {
  it("creates the run branch at the user's HEAD and two arms under UFO_HOME", async () => {
    const repo = newRepo();
    const runId = nextRunId();
    const { run, userTreeDirty } = await createRun(repo, runId, { home });
    expect(userTreeDirty).toBe(false);
    expect(run.branch).toBe(`ufo/run-${runId}`);
    expect(run.baseSha).toBe(head(repo));
    expect(run.dir).toBe(path.join(home, "worktrees", await repoId(repo), runId));
    expect(run.armA).toBe(path.join(run.dir, "a"));
    expect(run.armB).toBe(path.join(run.dir, "b"));
    expect(gitIn(run.armA, "symbolic-ref", "HEAD").trim()).toBe(`refs/heads/${run.branch}`);
    expect(head(run.armA)).toBe(run.baseSha);
    expect(() => gitIn(run.armB, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(head(run.armB)).toBe(run.baseSha);
    expect(gitIn(repo, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
    await removeRun(run, { deleteBranch: true });
  });

  it("defaults the worktree root to UFO_HOME", async () => {
    const repo = newRepo();
    const envHome = path.join(sandbox.root, "env-home");
    process.env.UFO_HOME = envHome;
    try {
      const { run } = await createRun(repo, nextRunId());
      expect(run.dir.startsWith(path.join(envHome, "worktrees") + path.sep)).toBe(true);
      await removeRun(run, { deleteBranch: true });
    } finally {
      delete process.env.UFO_HOME;
    }
  });

  it("refuses a branch that already exists", async () => {
    const repo = newRepo();
    const runId = nextRunId();
    gitIn(repo, "branch", runBranch(runId));
    await expect(createRun(repo, runId, { home })).rejects.toMatchObject({ code: "branch_exists" });
    expect(existsSync(path.join(home, "worktrees", await repoId(repo), runId))).toBe(false);
  });

  it("refuses an invalid run id and a repository without commits", async () => {
    await expect(createRun(newRepo(), "../escape", { home })).rejects.toMatchObject({
      code: "invalid_run_id",
    });
    const empty = path.join(sandbox.root, `empty-${randomUUID()}`);
    mkdirSync(empty);
    gitIn(empty, "init", "--quiet", "--initial-branch=main");
    await expect(createRun(empty, nextRunId(), { home })).rejects.toMatchObject({
      code: "no_commits",
    });
  });

  it("makes run ids from UTC timestamps", () => {
    expect(newRunId(new Date("2026-10-17T15:30:12.345Z"))).toBe("20261017-153012");
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

    const { run, userTreeDirty } = await createRun(repo, nextRunId(), { home });
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
    // The run branch survives for review, holding exactly the kept change.
    expect((await listChangeIds(run)).map((c) => c.changeId)).toEqual([kept.changeId]);
  });
});

describe("applyToB", () => {
  it("fails with patch_failed on a stale base SHA and leaves B at A", async () => {
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    const { run } = await createRun(newRepo(), nextRunId(), { home });
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
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "post-merge"]) {
      const file = path.join(repo, ".git/hooks", hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 1\n`);
      chmodSync(file, 0o755);
    }
    const { run } = await createRun(repo, nextRunId(), { home });
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
    const { run } = await createRun(repo, nextRunId(), { home });
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

describe("removeRun", () => {
  it("keeps the run branch unless asked, and removes empty run directories", async () => {
    const repo = newRepo();
    const { run } = await createRun(repo, nextRunId(), { home });
    await removeRun(run);
    expect(gitIn(repo, "branch", "--list", run.branch).trim()).not.toBe("");
    expect(existsSync(path.dirname(run.dir))).toBe(false);
    await removeRun(run, { deleteBranch: true });
    expect(gitIn(repo, "branch", "--list", run.branch).trim()).toBe("");
    expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });
});
