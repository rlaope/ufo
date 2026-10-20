import { readdir, realpath } from "node:fs/promises";
import { repoId, runGit } from "../core/git/index.js";
import { assertRealDir, isErrno, RunIdSchema, resolveGitCommonDir } from "../core/jobs/index.js";
import { assertTrustedDir, runDirFor, runsRoot, trustedHome, ufoHome } from "../core/paths.js";
import type { Resolver } from "../core/policy/index.js";
import type { Exec } from "../worker/index.js";
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
