import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import type { Change } from "../../domain/index.js";
import { GitError, git, runGit, summarizeStderr } from "./exec.js";
import { ufoHome } from "./home.js";

/** Hex characters of sha256(common dir) kept as the repository id. */
const REPO_ID_LENGTH = 16;
export const REPO_ID_PATTERN = /^[0-9a-f]{16}$/;

const MAX_RUN_ID_LENGTH = 64;
const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One optimization run: a branch in the user's repository and two worktrees outside it. A is the
 * run branch's HEAD (the baseline before the first keep); B is A plus the candidate patch. The
 * object holds only strings so it can be persisted with the run state and reloaded on resume.
 */
export interface Run {
  readonly runId: string;
  readonly repoId: string;
  /** Top level of the user's working tree. UFO reads it and never writes to it. */
  readonly repoRoot: string;
  /** `ufo/run-<run-id>`. */
  readonly branch: string;
  /** The user's HEAD when the run started. */
  readonly baseSha: string;
  /** `$UFO_HOME/worktrees/<repo-id>/<run-id>`. */
  readonly dir: string;
  readonly armA: string;
  readonly armB: string;
}

export interface CreatedRun {
  run: Run;
  /** Uncommitted changes in the user's tree are not part of the run; callers warn about them. */
  userTreeDirty: boolean;
}

export type ApplyResult =
  | {
      ok: true;
      /**
       * Paths changed in B's index, renames listed as both sides. This is git's own account of
       * the patch: re-check it against the protected paths before building.
       */
      changedPaths: string[];
    }
  | { ok: false; reason: "patch_failed"; detail: string };

export interface KeepTrailers {
  /** `Ufo-Metric`, e.g. `p95_latency_ms 120.4 -> 97.1 (-19.3%)`. */
  metric: string;
  /** `Ufo-Bundle`: the evidence bundle id. */
  bundle: string;
}

export interface ChangeCommit {
  sha: string;
  changeId: string;
}

/** Run id from a UTC timestamp, e.g. `20261017-153012`. */
export function newRunId(now: Date = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

export function runBranch(runId: string): string {
  return `ufo/run-${runId}`;
}

/** Stable id of a repository, shared by all its worktrees. It does not reveal the path. */
export async function repoId(repoRoot: string): Promise<string> {
  const result = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoRoot,
  );
  if (result.code !== 0) {
    throw new GitError("not_a_repo", "not inside a git repository", result.stderr);
  }
  const commonDir = await realpath(result.stdout.trim());
  return createHash("sha256").update(commonDir).digest("hex").slice(0, REPO_ID_LENGTH);
}

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd)).trim();
}

/**
 * Creates the run branch at the user's HEAD and the two arm worktrees. Nothing in the user's
 * working tree or index changes: the branch is created without checking it out, and the
 * worktrees live under `$UFO_HOME`.
 */
export async function createRun(
  repoRoot: string,
  runId: string,
  options: { home?: string } = {},
): Promise<CreatedRun> {
  if (runId.length > MAX_RUN_ID_LENGTH || !RUN_ID_PATTERN.test(runId)) {
    throw new GitError("invalid_run_id", `invalid run id: ${JSON.stringify(runId)}`);
  }
  const top = await runGit(["rev-parse", "--show-toplevel"], repoRoot);
  if (top.code !== 0) {
    throw new GitError("not_a_repo", "not inside a git working tree", top.stderr);
  }
  const root = await realpath(top.stdout.trim());
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root);
  if (head.code !== 0) {
    throw new GitError("no_commits", "the repository has no commits yet", head.stderr);
  }
  const baseSha = head.stdout.trim();
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], root);

  const branch = runBranch(runId);
  const existing = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
  if (existing.code === 0) {
    throw new GitError("branch_exists", `branch ${branch} already exists`);
  }

  const id = await repoId(root);
  const dir = path.join(options.home ?? ufoHome(), "worktrees", id, runId);
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    // Non-recursive, so an existing run directory is refused rather than reused.
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GitError("run_exists", `run ${runId} already has worktrees`);
    }
    throw error;
  }

  const run: Run = {
    runId,
    repoId: id,
    repoRoot: root,
    branch,
    baseSha,
    dir,
    armA: path.join(dir, "a"),
    armB: path.join(dir, "b"),
  };
  let branchCreated = false;
  try {
    await git(["branch", "--no-track", branch, baseSha], root);
    branchCreated = true;
    await git(["worktree", "add", "--quiet", run.armA, branch], root);
    await git(["worktree", "add", "--quiet", "--detach", run.armB, baseSha], root);
  } catch (error) {
    // The setup error is the one worth reporting; cleanup is best effort.
    await removeRun(run, { deleteBranch: branchCreated }).catch(() => undefined);
    throw error;
  }
  return { run, userTreeDirty: status.length > 0 };
}

async function resetB(run: Run, sha: string): Promise<void> {
  await git(["reset", "--hard", "--quiet", sha], run.armB);
  await git(["clean", "-ffd", "--quiet"], run.armB);
}

/** Resets B to A, then applies the change's diff to B's working tree and index. */
export async function applyToB(
  run: Run,
  change: Pick<Change, "baseSha" | "diff">,
): Promise<ApplyResult> {
  const aHead = await revParse(run.armA, "HEAD");
  if (change.baseSha !== aHead) {
    return {
      ok: false,
      reason: "patch_failed",
      detail: `the change is based on ${change.baseSha}, but arm A is at ${aHead}`,
    };
  }
  await resetB(run, aHead);
  const applied = await runGit(
    ["apply", "--index", "--whitespace=nowarn", "-"],
    run.armB,
    change.diff,
  );
  if (applied.code !== 0) {
    await resetB(run, aHead);
    return {
      ok: false,
      reason: "patch_failed",
      detail: summarizeStderr(applied.stderr) || "git apply failed",
    };
  }
  const changed = await git(
    ["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "-z", aHead],
    run.armB,
  );
  return { ok: true, changedPaths: changed.split("\0").filter((p) => p.length > 0) };
}

function checkTrailerValue(name: string, value: string): void {
  if (value.trim() !== value || value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new GitError(
      "invalid_trailer",
      `${name} must be one non-empty line: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Commits the change applied in B, authored per the target repository's git config, then
 * fast-forwards A and the run branch to it. Returns the new commit SHA.
 */
export async function commitKeep(
  run: Run,
  change: Pick<Change, "changeId" | "cardId" | "hypothesis">,
  trailers: KeepTrailers,
): Promise<string> {
  checkTrailerValue("Ufo-Metric", trailers.metric);
  checkTrailerValue("Ufo-Bundle", trailers.bundle);
  checkTrailerValue("Ufo-Technique", change.cardId);
  if (!UUID_PATTERN.test(change.changeId)) {
    throw new GitError("invalid_trailer", `Ufo-Change-Id must be a UUID: ${change.changeId}`);
  }
  const changeId = change.changeId.toLowerCase();
  if ((await listChangeIds(run)).some((c) => c.changeId === changeId)) {
    throw new GitError("duplicate_change", `change ${change.changeId} is already on ${run.branch}`);
  }
  const aHead = await revParse(run.armA, "HEAD");
  const bHead = await revParse(run.armB, "HEAD");
  if (aHead !== bHead) {
    throw new GitError("arms_diverged", `arm B is at ${bHead}, not at arm A's ${aHead}`);
  }
  // The trailers are the message's last paragraph, so lines in the hypothesis that look like
  // trailers are never parsed as ones.
  const message = [
    `ufo: ${change.cardId}`,
    "",
    change.hypothesis,
    "",
    `Ufo-Technique: ${change.cardId}`,
    `Ufo-Metric: ${trailers.metric}`,
    `Ufo-Bundle: ${trailers.bundle}`,
    `Ufo-Change-Id: ${change.changeId}`,
    "",
  ].join("\n");
  await git(["commit", "--quiet", "--cleanup=whitespace", "-F", "-"], run.armB, message);
  const sha = await revParse(run.armB, "HEAD");
  await git(["merge", "--ff-only", "--quiet", "--no-verify-signatures", sha], run.armA);
  return sha;
}

/** Hard-resets B to A and removes untracked files in B. Ignored build outputs stay. */
export async function revertB(run: Run): Promise<void> {
  await resetB(run, await revParse(run.armA, "HEAD"));
}

/** `Ufo-Change-Id`s of the commits UFO made on the run branch, oldest first. */
export async function listChangeIds(run: Run): Promise<ChangeCommit[]> {
  const out = await git(
    [
      "log",
      "-z",
      "--reverse",
      "--format=%H%x1f%(trailers:key=Ufo-Change-Id,valueonly,separator=%x1f)",
      `${run.baseSha}..refs/heads/${run.branch}`,
    ],
    run.repoRoot,
  );
  const commits: ChangeCommit[] = [];
  for (const record of out.split("\0")) {
    const [sha, ...values] = record.trim().split("\x1f");
    if (!sha) continue;
    for (const value of values) {
      const changeId = value.trim();
      if (UUID_PATTERN.test(changeId)) commits.push({ sha, changeId: changeId.toLowerCase() });
    }
  }
  return commits;
}

async function removeEmptyDir(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

/**
 * Removes both worktrees (including their build outputs) and the run directory. The run branch
 * stays unless `deleteBranch` is set.
 */
export async function removeRun(run: Run, options: { deleteBranch?: boolean } = {}): Promise<void> {
  for (const arm of [run.armA, run.armB]) {
    const removed = await runGit(["worktree", "remove", "--force", "--force", arm], run.repoRoot);
    // A path that does not exist was never added (setup failed first) or is already gone.
    if (removed.code !== 0 && existsSync(arm)) {
      throw new GitError(
        "git_failed",
        `git worktree remove failed: ${summarizeStderr(removed.stderr)}`,
        removed.stderr,
      );
    }
  }
  // Only empty directories are removed: UFO never deletes a tree git did not hand it.
  await removeEmptyDir(run.dir);
  await removeEmptyDir(path.dirname(run.dir));
  if (options.deleteBranch) {
    await git(["branch", "-D", run.branch], run.repoRoot);
  }
}
