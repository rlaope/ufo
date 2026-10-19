import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * `$UFO_HOME`, or `~/.ufo` when unset. Callers that read or write anything there go through
 * `trustedHome` first.
 */
export function ufoHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.UFO_HOME;
  return home !== undefined && home !== "" ? path.resolve(home) : path.join(os.homedir(), ".ufo");
}

/**
 * e.g. `20261017-153000-a1b2c3`: UTC time, then random hex so two runs in one second differ.
 * The same id names the run branch (`ufo/run-<id>`), the arms, and the run state directory.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

// Layout of `$UFO_HOME` (plan §2.3, process model). Everything UFO trusts lives under
// `private/`: the approvals, every run's state, and the machine lock. The arms, which the agent
// reads code from and which run patched code, live beside it under `arms/`.
export const PRIVATE_DIR = "private";
export const APPROVALS_DIR = "approvals";
export const RUNS_DIR = "runs";
export const ARMS_DIR = "arms";
/** Machine lock file name inside `$UFO_HOME/private`. */
export const MACHINE_LOCK_FILE = "lock";

const RUN_ID_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A run id or repository id that names a directory: never a separator, `.` or `..`. */
function segment(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new RangeError(`invalid ${what}: ${JSON.stringify(value)}`);
  return value;
}

export function privateRoot(home: string): string {
  return path.join(home, PRIVATE_DIR);
}

export function approvalsRoot(home: string): string {
  return path.join(home, PRIVATE_DIR, APPROVALS_DIR);
}

/** `$UFO_HOME/private/runs/<repo-id>`: every run of one repository. */
export function runsRoot(home: string, repoId: string): string {
  return path.join(home, PRIVATE_DIR, RUNS_DIR, segment(repoId, REPO_ID_SEGMENT, "repo id"));
}

/** `$UFO_HOME/private/runs/<repo-id>/<run-id>`: one run's state. */
export function runDirFor(home: string, repoId: string, runId: string): string {
  return path.join(runsRoot(home, repoId), segment(runId, RUN_ID_SEGMENT, "run id"));
}

/** `$UFO_HOME/arms/<repo-id>/<run-id>`: the two clones `a` and `b` of one run. */
export function armsDirFor(home: string, repoId: string, runId: string): string {
  return path.join(
    home,
    ARMS_DIR,
    segment(repoId, REPO_ID_SEGMENT, "repo id"),
    segment(runId, RUN_ID_SEGMENT, "run id"),
  );
}

export function machineLockPath(home: string): string {
  return path.join(home, PRIVATE_DIR, MACHINE_LOCK_FILE);
}

/**
 * The repository id and run id a run directory names, when `runDir` is exactly
 * `runDirFor(home, repoId, runId)`; `undefined` for any other path.
 */
export function parseRunDir(
  home: string,
  runDir: string,
): { repoId: string; runId: string } | undefined {
  const relative = path.relative(path.join(home, PRIVATE_DIR, RUNS_DIR), runDir);
  const parts = relative.split(path.sep);
  if (parts.length !== 2) return undefined;
  const [repoId = "", runId = ""] = parts;
  if (!REPO_ID_SEGMENT.test(repoId) || !RUN_ID_SEGMENT.test(runId)) return undefined;
  return runDirFor(home, repoId, runId) === runDir ? { repoId, runId } : undefined;
}

export type TrustErrorCode = "unsafe_home" | "unsafe_state";

/**
 * `$UFO_HOME`, or something under it, is not safe to trust: a symlink, not a directory, owned by
 * another user, writable by group or others, or inside the target repository.
 */
export class TrustError extends Error {
  override name = "TrustError";
  readonly code: TrustErrorCode;

  constructor(code: TrustErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/** Why `info` (from `lstat`) is not a directory UFO may trust, or `undefined` when it is. */
function distrust(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "is a symbolic link";
  if (!info.isDirectory()) return "is not a directory";
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) return "is not owned by the current user";
  if ((info.mode & 0o022) !== 0) return "is writable by group or others (chmod 700 it)";
  return undefined;
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Checks `$UFO_HOME` and returns its real path, creating it with mode 0700 when it is missing.
 * Refuses (`unsafe_home`) a home that is a symlink, not a directory, not owned by the current
 * user, writable by group or others, or inside any of `outside` (the target repository's working
 * tree and git directories): the repository is untrusted, so UFO's trusted state may not live
 * in it.
 */
export async function trustedHome(
  home: string,
  options: { outside?: readonly string[] } = {},
): Promise<string> {
  const resolved = path.resolve(home);
  const refuseInside = (real: string) => {
    for (const dir of options.outside ?? []) {
      if (isWithin(real, dir)) {
        throw new TrustError(
          "unsafe_home",
          `UFO_HOME ${resolved} is inside the target repository (${dir}); use a directory outside it`,
        );
      }
    }
  };
  // Checked before anything is created, so a refused home leaves nothing in the repository.
  refuseInside(await realpathOfNearest(resolved));
  try {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const problem = distrust(await lstat(resolved));
  if (problem !== undefined) {
    throw new TrustError("unsafe_home", `UFO_HOME ${resolved} ${problem}`);
  }
  const real = await realpath(resolved);
  refuseInside(real);
  return real;
}

/** The real path `target` would have: its nearest existing ancestor's real path, plus the rest. */
async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Makes sure each directory from `root` down to `dir` exists as a real directory UFO may trust,
 * creating missing ones with mode 0700. Every existing component is checked with `lstat`, so a
 * planted symlink is refused (`unsafe_state`) instead of followed. `root` itself is the caller's
 * trusted home.
 */
export async function ensureTrustedDir(root: string, dir: string): Promise<string> {
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TrustError("unsafe_state", `${dir} is not inside ${root}`);
  }
  let current = root;
  for (const part of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, part);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      info = await lstat(current);
    }
    const problem = distrust(info);
    if (problem !== undefined) throw new TrustError("unsafe_state", `${current} ${problem}`);
  }
  return dir;
}

/**
 * Checks, without creating anything, that every component from `root` down to `dir` is a real
 * directory UFO may trust. Throws `unsafe_state`, or the `ENOENT` of a missing component.
 */
export async function assertTrustedDir(root: string, dir: string): Promise<void> {
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TrustError("unsafe_state", `${dir} is not inside ${root}`);
  }
  let current = root;
  for (const part of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, part);
    const problem = distrust(await lstat(current));
    if (problem !== undefined) throw new TrustError("unsafe_state", `${current} ${problem}`);
  }
}
