import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Change } from "../../domain/index.js";
import { armsDirFor, ensureTrustedDir, ufoHome } from "../paths.js";
import { GitError, git, runGit, summarizeStderr } from "./exec.js";
import { checkRepoConfig } from "./preflight.js";

/** Hex characters of sha256(common dir) kept as the repository id. */
const REPO_ID_LENGTH = 16;
export const REPO_ID_PATTERN = /^[0-9a-f]{16}$/;

const MAX_RUN_ID_LENGTH = 64;
const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who UFO's commits name as author and committer: the user's git identity for the repository. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * One optimization run: a branch in the user's repository and two UFO-owned clones outside it.
 * A is the run branch's HEAD (the baseline before the first keep); B is A plus the candidate
 * patch. Every path here is derived from the run id and the trusted home (`runLayout`), never
 * read back from run state.
 */
export interface Run {
  readonly runId: string;
  readonly repoId: string;
  /** Top level of the user's working tree. UFO reads it and never writes to it. */
  readonly repoRoot: string;
  /** `ufo/run-<run-id>`, in each clone and, through a fetch, in the user's repository. */
  readonly branch: string;
  /** The user's HEAD when the run started. */
  readonly baseSha: string;
  /** `$UFO_HOME/arms/<repo-id>/<run-id>`. */
  readonly dir: string;
  readonly armA: string;
  readonly armB: string;
  /** Author and committer of kept changes; git's own resolution when absent. */
  readonly identity?: GitIdentity | undefined;
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

export function runBranch(runId: string): string {
  return `ufo/run-${runId}`;
}

/** Where a run's branch and arms are, from its ids and the trusted home alone. */
export function runLayout(
  home: string,
  repoId: string,
  runId: string,
): Pick<Run, "branch" | "dir" | "armA" | "armB"> {
  const dir = armsDirFor(home, repoId, runId);
  return { branch: runBranch(runId), dir, armA: path.join(dir, "a"), armB: path.join(dir, "b") };
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

/**
 * Refuses (`unsafe_arm`) an arm that is not exactly the directory UFO created: its path must be
 * its own real path (no symlinked component below the trusted home, whose real path the arm
 * paths are derived from), holding a real `.git` directory of its own. A symlink, or a `.git`
 * file or `commondir` pointing elsewhere, would aim the destructive commands below at another
 * repository.
 */
async function assertArm(arm: string): Promise<void> {
  if ((await realpath(arm).catch(() => undefined)) !== arm) {
    throw new GitError("unsafe_arm", `arm ${arm} is missing or reached through a symbolic link`);
  }
  const gitDir = path.join(arm, ".git");
  const info = await lstat(gitDir).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new GitError("unsafe_arm", `arm git directory ${gitDir} is not a real directory`);
  }
  if ((await lstat(path.join(gitDir, "commondir")).catch(() => undefined)) !== undefined) {
    throw new GitError("unsafe_arm", `arm ${arm} shares another repository's git directory`);
  }
}

/** git in one arm, with its git directory and work tree named explicitly. */
async function armGit(arm: string, args: readonly string[], input?: string): Promise<string> {
  await assertArm(arm);
  return git(armArgs(arm, args), arm, input);
}

async function armRunGit(arm: string, args: readonly string[], input?: string) {
  await assertArm(arm);
  return runGit(armArgs(arm, args), arm, input);
}

function armArgs(arm: string, args: readonly string[]): string[] {
  return [`--git-dir=${path.join(arm, ".git")}`, `--work-tree=${arm}`, ...args];
}

async function revParse(arm: string, rev: string): Promise<string> {
  return (await armGit(arm, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
}

/**
 * The identity `git commit` would use in the user's repository (`user.name`, `user.email`),
 * captured at start because the arms do not have the repository's config.
 */
async function readIdentity(repoRoot: string): Promise<GitIdentity | undefined> {
  const value = async (key: string) => {
    const result = await runGit(["config", "--get", key], repoRoot);
    return result.code === 0 ? result.stdout.trim() : "";
  };
  const [name, email] = [await value("user.name"), await value("user.email")];
  return name !== "" && email !== "" ? { name, email } : undefined;
}

/**
 * Creates the run branch at the user's HEAD and the two arms: local clones under
 * `$UFO_HOME/arms/<repo-id>/<run-id>/{a,b}` without checkout, templates, hooks, or the
 * repository's config, checked out at the base SHA. The repository's config is checked first
 * (`checkRepoConfig`), and the user's identity for it is captured for the commits. Nothing in the
 * user's working tree, index, or git directory changes except the new branch.
 */
export async function createRunArms(
  repoRoot: string,
  runId: string,
  options: { home?: string } = {},
): Promise<CreatedRun> {
  if (runId.length > MAX_RUN_ID_LENGTH || !RUN_ID_PATTERN.test(runId)) {
    throw new GitError("invalid_run_id", `invalid run id: ${JSON.stringify(runId)}`);
  }
  // Before anything else: `core.worktree` would already move the top level below.
  await checkRepoConfig(repoRoot);
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
  await checkRepoConfig(root, baseSha);
  const identity = await readIdentity(root);
  const status = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"],
    root,
  );

  const branch = runBranch(runId);
  const existing = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
  if (existing.code === 0) {
    throw new GitError("branch_exists", `branch ${branch} already exists`);
  }

  const id = await repoId(root);
  const home = options.home ?? ufoHome();
  const layout = runLayout(home, id, runId);
  await ensureTrustedDir(home, path.dirname(layout.dir));
  try {
    // Non-recursive, so an existing run directory is refused rather than reused.
    await mkdir(layout.dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GitError("run_exists", `run ${runId} already has arms`);
    }
    throw error;
  }

  const commonDir = (
    await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)
  ).trim();
  const run: Run = {
    runId,
    repoId: id,
    repoRoot: root,
    baseSha,
    ...layout,
    ...(identity === undefined ? {} : { identity }),
  };
  let branchCreated = false;
  try {
    await git(["branch", "--no-track", branch, baseSha], root);
    branchCreated = true;
    for (const arm of [run.armA, run.armB]) {
      await git(
        ["clone", "--quiet", "--no-checkout", "--local", "--template=", "--", commonDir, arm],
        layout.dir,
      );
    }
    await armGit(run.armA, ["checkout", "--quiet", "-b", branch, baseSha]);
    await armGit(run.armB, ["checkout", "--quiet", "--detach", baseSha]);
  } catch (error) {
    // The setup error is the one worth reporting; cleanup is best effort.
    await removeRun(run, { deleteBranch: branchCreated }).catch(() => undefined);
    throw error;
  }
  return { run, userTreeDirty: status.length > 0 };
}

/** Makes sure `arm` has commit `sha`, fetching it from the other arm when it does not. */
async function ensureCommit(run: Run, arm: string, sha: string): Promise<void> {
  const present = await armRunGit(arm, ["cat-file", "-e", `${sha}^{commit}`]);
  if (present.code === 0) return;
  const other = arm === run.armA ? run.armB : run.armA;
  await assertArm(other);
  await armGit(arm, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    path.join(other, ".git"),
    sha,
  ]);
}

async function resetB(run: Run, sha: string): Promise<void> {
  await ensureCommit(run, run.armB, sha);
  await armGit(run.armB, ["reset", "--hard", "--quiet", sha]);
  await armGit(run.armB, ["clean", "-ffd", "--quiet"]);
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
  const applied = await armRunGit(
    run.armB,
    ["apply", "--index", "--whitespace=nowarn", "-"],
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
  const changed = await armGit(run.armB, [
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "-z",
    aHead,
  ]);
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
 * Hands the run branch to the user's repository: a fetch of A's HEAD into
 * `refs/heads/ufo/run-<id>` (fast-forward only, no tags, no FETCH_HEAD, no submodules, no
 * maintenance), after checking the repository's config again. This is the only write UFO makes
 * to the user's repository after the branch exists.
 */
export async function publishBranch(run: Run): Promise<string> {
  await assertArm(run.armA);
  const sha = await revParse(run.armA, `refs/heads/${run.branch}`);
  await checkRepoConfig(run.repoRoot, run.baseSha);
  await git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      path.join(run.armA, ".git"),
      `${sha}:refs/heads/${run.branch}`,
    ],
    run.repoRoot,
  );
  return sha;
}

/**
 * Commits the change applied in B, authored per the user's identity for the repository, then
 * fast-forwards A to it and publishes the run branch to the user's repository. Returns the new
 * commit SHA.
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
  const identity =
    run.identity === undefined
      ? []
      : ["-c", `user.name=${run.identity.name}`, "-c", `user.email=${run.identity.email}`];
  await armGit(
    run.armB,
    [...identity, "commit", "--quiet", "--no-gpg-sign", "--cleanup=whitespace", "-F", "-"],
    message,
  );
  const sha = await revParse(run.armB, "HEAD");
  await ensureCommit(run, run.armA, sha);
  await armGit(run.armA, ["merge", "--ff-only", "--quiet", "--no-verify-signatures", sha]);
  await publishBranch(run);
  return sha;
}

/** Hard-resets B to A and removes untracked files in B. Ignored build outputs stay. */
export async function revertB(run: Run): Promise<void> {
  await resetB(run, await revParse(run.armA, "HEAD"));
}

/** Arm A's HEAD, the commit every change applies on. */
export function headOfA(run: Run): Promise<string> {
  return revParse(run.armA, "HEAD");
}

/**
 * Puts B at `sha`, which must be the run's base SHA or a commit on the run branch. The final
 * check measures the base SHA in B against the final SHA in A; `revertB` brings B back.
 */
export async function resetBTo(run: Run, sha: string): Promise<void> {
  const target = await revParse(run.armA, sha);
  const onBranch = await armRunGit(run.armA, ["merge-base", "--is-ancestor", target, "HEAD"]);
  if (onBranch.code !== 0) {
    throw new GitError("arms_diverged", `${sha} is not on the run branch ${run.branch}`);
  }
  await resetB(run, target);
}

/**
 * Discards whatever an interrupted job left in either arm: A is reset to the run branch's HEAD
 * (the commit is the source of truth, see `reconcileLedger`) and B to A. Returns A's SHA.
 */
export async function resetArms(run: Run): Promise<string> {
  await armGit(run.armA, ["reset", "--hard", "--quiet", "HEAD"]);
  await armGit(run.armA, ["clean", "-ffd", "--quiet"]);
  const aHead = await revParse(run.armA, "HEAD");
  await resetB(run, aHead);
  return aHead;
}

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * Content of `file` in A's HEAD commit, read from git rather than the file system, so a symlink
 * cannot point the read outside the repository. `undefined` when the path is not a regular file
 * in that commit.
 */
export async function readFileAtA(run: Run, file: string): Promise<string | undefined> {
  const entry = await armGit(run.armA, ["ls-tree", "-z", "HEAD", "--", file]);
  const [meta, name] = entry.replace(/\0$/, "").split("\t");
  const [mode, type, object] = (meta ?? "").split(" ");
  if (name !== file || type !== "blob" || !REGULAR_FILE_MODES.has(mode ?? "") || !object) {
    return undefined;
  }
  return armGit(run.armA, ["cat-file", "blob", object]);
}

/** Refuses to write through a symlink or into anything but a regular file inside `root`. */
async function assertWritableInTree(root: string, file: string): Promise<string> {
  const parts = file.split("/");
  if (
    file.startsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    file.includes("\\")
  ) {
    throw new GitError("git_failed", `not a repository-relative path: ${JSON.stringify(file)}`);
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    const last = index === parts.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
      throw new GitError("git_failed", `${file} is not a regular file in the worktree`);
    }
  }
  return current;
}

/**
 * The unified diff, against A's HEAD, that turns each listed file into the given content.
 * git computes it in B, which is reset to A before and after. Only existing regular files can
 * be rewritten. An empty string means the content equals A's.
 */
export async function diffFromFiles(run: Run, files: ReadonlyMap<string, string>): Promise<string> {
  const aHead = await revParse(run.armA, "HEAD");
  await resetB(run, aHead);
  try {
    for (const [file, content] of files) {
      await writeFile(await assertWritableInTree(run.armB, file), content);
    }
    await armGit(run.armB, ["add", "--", ...files.keys()]);
    return await armGit(run.armB, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      aHead,
    ]);
  } finally {
    await resetB(run, aHead);
  }
}

/** `Ufo-Change-Id`s of the commits UFO made on the run branch in arm A, oldest first. */
export async function listChangeIds(run: Run): Promise<ChangeCommit[]> {
  const out = await armGit(run.armA, [
    "log",
    "-z",
    "--reverse",
    "--format=%H%x1f%(trailers:key=Ufo-Change-Id,valueonly,separator=%x1f)",
    `${run.baseSha}..refs/heads/${run.branch}`,
  ]);
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
 * Removes both arms (including their build outputs) and the run's arms directory, which UFO
 * created and owns. A missing arm is not an error. The run branch stays unless `deleteBranch`
 * is set.
 */
export async function removeRun(run: Run, options: { deleteBranch?: boolean } = {}): Promise<void> {
  // `rm` removes a symlink planted at the path itself, never what it points to.
  await rm(run.dir, { recursive: true, force: true });
  await removeEmptyDir(path.dirname(run.dir));
  if (options.deleteBranch) {
    await checkRepoConfig(run.repoRoot, run.baseSha);
    await git(["branch", "-D", run.branch], run.repoRoot);
  }
}
