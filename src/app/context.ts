import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
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

/**
 * The main checkout of the linked worktree whose `.git` file is `dotGit`, read without running
 * git: the git directory it names is `<checkout>/.git/worktrees/<name>`, whose `gitdir` names
 * that `.git` file back. A `.git` file naming any other directory names no checkout, so it cannot
 * drop an unrelated directory (a system `bin`) from PATH (security S2-6); a submodule's
 * superproject encloses it and is found by the walk up.
 */
async function gitFileOwner(dotGit: string): Promise<string | undefined> {
  const text = await readTextNoFollow(dotGit).catch(() => undefined);
  const named = text?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (named === undefined) return undefined;
  const gitDir = path.resolve(path.dirname(dotGit), named);
  const at = gitDir.indexOf(`${path.sep}.git${path.sep}`);
  if (at === -1) return undefined;
  const owner = gitDir.slice(0, at);
  if (path.dirname(gitDir) !== path.join(owner, ".git", "worktrees")) return undefined;
  const back = await readTextNoFollow(path.join(gitDir, "gitdir")).catch(() => undefined);
  if (back === undefined) return undefined;
  const [backTo, self] = await Promise.all(
    [path.resolve(gitDir, back.trim()), dotGit].map((file) =>
      realpath(path.dirname(file)).catch(() => undefined),
    ),
  );
  return backTo !== undefined && backTo === self ? owner : undefined;
}

/**
 * Every directory at or above `dir` with a `.git` entry: the working trees around it, the one git
 * finds first and those that enclose it (a submodule's superproject), with the main checkout of
 * a linked worktree among them.
 */
async function enclosingWorkTrees(dir: string): Promise<string[]> {
  const trees: string[] = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const dotGit = path.join(current, ".git");
    const entry = await lstat(dotGit).catch(() => undefined);
    if (entry !== undefined) {
      trees.push(current);
      const owner = entry.isFile() ? await gitFileOwner(dotGit) : undefined;
      if (owner !== undefined) trees.push(owner);
    }
    if (path.dirname(current) === current) return trees;
  }
}

/**
 * Filters this process's own `PATH` before UFO runs git, ps, or docker (security H1, N4): no
 * empty or relative entry, none with a `node_modules` segment, and none inside the working
 * directory, `repoDir`, UFO's home, or the repository there with its git directories. Before git
 * finds that repository, every working tree around each directory is found by its `.git` entry,
 * so no repository's own `git` runs. Your home directory and its ancestors are never one of
 * those roots, even when one is a repository (dotfiles) or the working directory: tools installed
 * under it (`~/.nvm`, `~/.cargo/bin`) stay, and a project's `.bin` there is caught by the
 * `node_modules` rule. Returns the repository, or `undefined` when there is none (an error when
 * `requireRepo`), the entries it dropped, and the project roots it distrusted besides UFO's home
 * (where `ufo setup` refuses a UFO home).
 */
export async function trustProcessPath(options: {
  readonly cwd: string;
  readonly repoDir?: string | undefined;
  readonly home?: string | undefined;
  readonly requireRepo?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ repo: Repo | undefined; dropped: string[]; projectRoots: string[] }> {
  const env = options.env ?? process.env;
  const before = (env.PATH ?? "").split(path.delimiter);
  const userHome = path.resolve(os.homedir());
  const userHomes = [userHome, await realpath(userHome).catch(() => userHome)];
  const roots = (dirs: readonly string[]) =>
    dirs.filter((root) => !userHomes.some((home) => within(home, path.resolve(root))));
  const dirs = [options.cwd, ...(options.repoDir === undefined ? [] : [options.repoDir])];
  const reals = await Promise.all(dirs.map((dir) => realpath(dir).catch(() => dir)));
  const trees = await Promise.all([...dirs, ...reals].map(enclosingWorkTrees));
  const project = roots([...dirs, ...reals, ...trees.flat()]);
  const untrusted = [...project, ...roots([path.resolve(options.home ?? ufoHome(env))])];
  env.PATH = processPath(env.PATH ?? "", untrusted);
  const repo = await resolveRepo(options.repoDir ?? options.cwd).catch((error: unknown) => {
    if (options.requireRepo === true) throw error;
    return undefined;
  });
  const repoRoots =
    repo === undefined
      ? []
      : roots([repo.root, repo.gitDir, repo.commonDir, path.dirname(repo.commonDir)]);
  if (repo !== undefined) env.PATH = processPath(env.PATH, [...untrusted, ...repoRoots]);
  const kept = new Set(env.PATH.split(path.delimiter));
  return {
    repo,
    dropped: [...new Set(before.filter((entry) => !kept.has(entry)))],
    projectRoots: [...project, ...repoRoots],
  };
}

function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * Whether `repo` is a linked worktree or a submodule whose git directory names its work tree
 * back: `<common dir>/worktrees/<name>`, whose `gitdir` holds the path of the work tree's `.git`
 * file, or the common directory itself, with `core.worktree` in its config.
 */
async function namesWorkTree(repo: Repo): Promise<boolean> {
  let named: string | undefined;
  if (path.dirname(repo.gitDir) === path.join(repo.commonDir, "worktrees")) {
    const linked = await readTextNoFollow(path.join(repo.gitDir, "gitdir")).catch(() => undefined);
    named =
      linked === undefined ? undefined : path.dirname(path.resolve(repo.gitDir, linked.trim()));
  } else if (repo.gitDir === repo.commonDir) {
    // Relative to the git directory.
    const configured = await runGit(
      ["config", "--file", path.join(repo.gitDir, "config"), "--get", "core.worktree"],
      repo.root,
    ).catch(() => undefined);
    named =
      configured?.code === 0 ? path.resolve(repo.gitDir, configured.stdout.trim()) : undefined;
  }
  return named !== undefined && (await realpath(named).catch(() => undefined)) === repo.root;
}

/**
 * Refuses a work tree whose common git directory is outside it, unless it is a linked worktree
 * or a submodule (`namesWorkTree`) whose git directory is outside the work tree too (security
 * N1, S2-1): a `.git` pointed at another repository's git directory would act on that
 * repository's runs, and a back-link inside the work tree, the session's own directory, proves
 * nothing, since whatever wrote the `.git` could write it too.
 */
async function refuseForeignGitDir(repo: Repo): Promise<void> {
  if (within(repo.commonDir, repo.root)) return;
  if (!within(repo.gitDir, repo.root) && (await namesWorkTree(repo))) return;
  throw new TrustError(
    "unsafe_state",
    `the git directory of ${repo.root} is ${repo.commonDir}, outside it, and ${repo.root} is no linked worktree or submodule of it`,
  );
}

/**
 * Refuses your home directory or a directory above it as `dir`, which `what` names (security
 * S2-2): a project there holds every directory under your home, the tools on PATH that UFO keeps
 * there among them. Runs no git.
 */
export async function refuseHomeDirectory(dir: string, what: string): Promise<void> {
  const home = path.resolve(os.homedir());
  const homes = [home, await realpath(home).catch(() => home)];
  const forms = [path.resolve(dir), await realpath(dir).catch(() => path.resolve(dir))];
  if (forms.some((form) => homes.some((at) => within(at, form)))) {
    throw new AppError(
      "not_a_repo",
      `${what} ${dir} is your home directory or above it; UFO works only in a project folder`,
    );
  }
}

/**
 * The repository at `dir`, to bind a long-lived server to, with this process's PATH filtered
 * for it first (`trustProcessPath`): each time it is looked for, so one found only after startup
 * is filtered for too before git runs in it (security S2-3). A work tree sharing a git directory
 * elsewhere is refused unless it is a linked worktree or submodule of it whose git directory is
 * outside the work tree (security N1, S2-1). Outside a repository `repo` is `undefined`, or
 * `not_a_repo` is thrown when `requireRepo`.
 */
export async function bindRepository(options: {
  readonly dir: string;
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly requireRepo?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ repo: Repo | undefined; dropped: string[] }> {
  const found = await trustProcessPath({ ...options, repoDir: options.dir });
  if (found.repo !== undefined) await refuseForeignGitDir(found.repo);
  return found;
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
