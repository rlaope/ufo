import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { repoId, runGit } from "../core/git/index.js";
import {
  assertRealDir,
  isErrno,
  RunIdSchema,
  readTextNoFollow,
  resolveGitCommonDir,
} from "../core/jobs/index.js";
import {
  assertTrustedDir,
  runDirFor,
  runsRoot,
  TrustError,
  trustedHome,
  ufoHome,
} from "../core/paths.js";
import type { Resolver } from "../core/policy/index.js";
import type { Exec } from "../worker/index.js";
import { processPath } from "./env.js";
import { AppError } from "./errors.js";

/**
 * What every app workflow needs to know about its caller. The CLI fills it from the process;
 * tests pass their own. None of these may come from an agent's tool parameters (plan R6).
 */
export interface AppContext {
  /** Any directory inside the target repository. */
  readonly cwd: string;
  /** `$UFO_HOME` override; defaults to `ufoHome()`. Checked by `trustedHome` before use. */
  readonly home?: string;
  /** Technique card directories besides the built-in ones, `<dir>/<domain>/<name>.yaml`. */
  readonly cardDirs?: readonly string[];
  /** Script the detached worker runs; defaults to the built CLI. */
  readonly workerEntry?: string;
  /**
   * The launcher environment `startRun` captures the run's allowlisted environment from;
   * defaults to `process.env`. Workers and commands get only the captured variables.
   */
  readonly workerEnv?: NodeJS.ProcessEnv;
  /** Runs `docker` for container cleanup on cancel and resume. */
  readonly exec?: Exec;
  /** Resolves the hostnames of approved targets; defaults to the system resolver. */
  readonly resolver?: Resolver;
  /**
   * How long a call waits while another control operation holds the run (resume, cancel,
   * finish, queueing work) before it fails `busy`; defaults to `CONTROL_LOCK_WAIT_MS`. An MCP
   * server sets it under its host's tool timeout.
   */
  readonly controlLockWaitMs?: number;
}

/** The CLI's wait for a run's control lock. */
export const CONTROL_LOCK_WAIT_MS = 120_000;

/** The wait every `withControlLock` of an app call is given: a finite wait ≥ 0, else the CLI's. */
export function controlLockWaitMs(context: AppContext): number {
  const wait = context.controlLockWaitMs;
  return wait !== undefined && Number.isFinite(wait) && wait >= 0 ? wait : CONTROL_LOCK_WAIT_MS;
}

export interface Repo {
  /** Real path of the working tree's top level. */
  readonly root: string;
  /** Real path of this working tree's git directory. */
  readonly gitDir: string;
  /** The `.git` directory shared by all worktrees. */
  readonly commonDir: string;
  readonly repoId: string;
}

export async function resolveRepo(cwd: string): Promise<Repo> {
  const top = await runGit(["rev-parse", "--show-toplevel"], cwd).catch(() => undefined);
  if (top === undefined || top.code !== 0) {
    throw new AppError("not_a_repo", `${cwd} is not inside a git working tree`);
  }
  const root = await realpath(top.stdout.trim());
  const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], root);
  return {
    root,
    gitDir: await realpath(gitDir.stdout.trim()),
    commonDir: await realpath(await resolveGitCommonDir(root)),
    repoId: await repoId(root),
  };
}

/** The nearest directory at or above `dir` with a `.git` entry: its working tree, as git finds it. */
async function nearestWorkTree(dir: string): Promise<string | undefined> {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if ((await lstat(path.join(current, ".git")).catch(() => undefined)) !== undefined) {
      return current;
    }
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * Filters this process's own `PATH` before UFO runs git, ps, or docker (security H1, N4): no
 * empty or relative entry, none with a `node_modules` segment, and none inside the working
 * directory, `repoDir`, UFO's home, or the repository there with its git directories. Before git
 * finds that repository, the working tree around each directory is found by its `.git` entry,
 * so the repository's own `git` never runs. Returns the repository, or `undefined` when there is
 * none (an error when `requireRepo`).
 */
export async function trustProcessPath(options: {
  readonly cwd: string;
  readonly repoDir?: string | undefined;
  readonly home?: string | undefined;
  readonly requireRepo?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<Repo | undefined> {
  const env = options.env ?? process.env;
  const dirs = [options.cwd, ...(options.repoDir === undefined ? [] : [options.repoDir])];
  const reals = await Promise.all(dirs.map((dir) => realpath(dir).catch(() => dir)));
  const trees = await Promise.all([...dirs, ...reals].map(nearestWorkTree));
  const untrusted = [
    ...dirs,
    ...reals,
    ...trees.filter((tree) => tree !== undefined),
    path.resolve(options.home ?? ufoHome(env)),
  ];
  env.PATH = processPath(env.PATH ?? "", untrusted);
  const repo = await resolveRepo(options.repoDir ?? options.cwd).catch((error: unknown) => {
    if (options.requireRepo === true) throw error;
    return undefined;
  });
  if (repo !== undefined) {
    env.PATH = processPath(env.PATH, [...untrusted, repo.root, repo.gitDir, repo.commonDir]);
  }
  return repo;
}

function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}${path.sep}`);
}

/** Whether the git directory of `repo`, outside its work tree, names that work tree back. */
async function namesWorkTree(repo: Repo): Promise<boolean> {
  // A linked worktree: `<git dir>/gitdir` holds the path of the work tree's `.git` file.
  const linked = await readTextNoFollow(path.join(repo.gitDir, "gitdir")).catch(() => undefined);
  if (linked !== undefined) {
    const named = await realpath(path.dirname(path.resolve(repo.gitDir, linked.trim()))).catch(
      () => undefined,
    );
    if (named === repo.root) return true;
  }
  // A submodule: `core.worktree` in its own config, relative to its git directory.
  const configured = await runGit(
    ["config", "--file", path.join(repo.gitDir, "config"), "--get", "core.worktree"],
    repo.root,
  ).catch(() => undefined);
  if (configured?.code === 0) {
    const named = await realpath(path.resolve(repo.gitDir, configured.stdout.trim())).catch(
      () => undefined,
    );
    if (named === repo.root) return true;
  }
  return false;
}

/**
 * Refuses a work tree whose git directory is outside it unless that git directory names it back,
 * as a linked worktree's or a submodule's does (security N1): a `.git` pointed at another
 * repository's git directory would act on that repository's runs.
 */
export async function refuseForeignGitDir(repo: Repo): Promise<void> {
  if (within(repo.commonDir, repo.root) || (await namesWorkTree(repo))) return;
  throw new TrustError(
    "unsafe_state",
    `the git directory of ${repo.root} is ${repo.gitDir}, outside it, and does not name it as its work tree`,
  );
}

/**
 * Refuses to go on when the repository at `pinned.root` is no longer the one pinned: its git
 * directory, common directory, or id changed, so `.git` now names another repository's
 * (security N1). `since` names what pinned it, for the message.
 */
export async function refuseChangedRepository(pinned: Repo, since: string): Promise<void> {
  const now = await resolveRepo(pinned.root);
  if (
    now.root === pinned.root &&
    now.gitDir === pinned.gitDir &&
    now.commonDir === pinned.commonDir &&
    now.repoId === pinned.repoId
  ) {
    return;
  }
  throw new TrustError(
    "unsafe_state",
    `the repository's git directory changed since ${since} started`,
  );
}

/**
 * The trusted home for work on `repo`: `$UFO_HOME` (or the context's override) checked and
 * created by `trustedHome`, which refuses one inside the repository or its git directories.
 */
export function homeFor(context: AppContext, repo: Repo): Promise<string> {
  return trustedHome(context.home ?? ufoHome(), {
    outside: [repo.root, repo.gitDir, repo.commonDir],
  });
}

/** Run ids of the repository, oldest first (ids start with their UTC start time). */
export async function listRunIds(home: string, repo: Pick<Repo, "repoId">): Promise<string[]> {
  const root = runsRoot(home, repo.repoId);
  let names: string[];
  try {
    await assertRealDir(root);
    names = await readdir(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  return names.filter((name) => RunIdSchema.safeParse(name).success).sort();
}

export interface LocatedRun {
  readonly repo: Repo;
  /** The trusted home's real path. */
  readonly home: string;
  readonly runId: string;
  readonly runDir: string;
}

/**
 * The run `runId`, or the latest run of the repository when it is omitted. Its directory is
 * derived from the trusted home and the repository id, and checked component by component.
 */
export async function locateRun(context: AppContext, runId?: string): Promise<LocatedRun> {
  const repo = await resolveRepo(context.cwd);
  const home = await homeFor(context, repo);
  const ids = await listRunIds(home, repo);
  const id = runId ?? ids.at(-1);
  if (id === undefined) throw new AppError("no_run", "this repository has no UFO runs");
  if (!RunIdSchema.safeParse(id).success || !ids.includes(id)) {
    throw new AppError("no_run", `no run ${id} in this repository`);
  }
  const runDir = runDirFor(home, repo.repoId, id);
  await assertTrustedDir(home, runDir);
  return { repo, home, runId: id, runDir };
}
