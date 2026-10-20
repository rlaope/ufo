import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveWithGate, type HumanGate } from "../../src/app/human-gate.js";
import { type AppContext, type ApproveOptions, getJob } from "../../src/app/index.js";
import {
  type JobRecord,
  LOGS_DIR,
  runDirFor,
  TERMINAL_JOB_STATUSES,
} from "../../src/core/jobs/index.js";
import { type Exec, killRunProcesses, WORKER_ERR_LOG } from "../../src/worker/index.js";

export const FIXTURE_REPO = fileURLToPath(new URL("../fixtures/toy-http/repo", import.meta.url));
export const FIXTURE_CARDS = fileURLToPath(new URL("../fixtures/toy-http/cards", import.meta.url));
export const WORKER_ENTRY = fileURLToPath(new URL("./support/worker-entry.mjs", import.meta.url));
export const CLI_ENTRY = fileURLToPath(new URL("./support/cli-entry.mjs", import.meta.url));
/**
 * The built CLI, as the package ships it: test/global-setup.ts builds the package into a
 * temporary directory once per test run, never into the working tree's dist/.
 */
export const BUILT_CLI =
  process.env.UFO_TEST_BUILT_CLI ??
  "(no built CLI: run the tests with vitest, whose global setup builds it)";

/** Integration tests spawn real workers and run real workloads. */
export const TIMEOUT_MS = 90_000;

export const TEST_IDENTITY = { name: "Test", email: "test@example.invalid" };

/** Docker as seen on a machine without it: cleanup must report this, not fail. */
export const dockerAbsent: Exec = async () => {
  throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface Toy {
  readonly root: string;
  /** The user's repository: a copy of the toy-http fixture with one commit. */
  readonly repo: string;
  /** A clone of the user's repository, used to write diffs against its HEAD. */
  readonly scratch: string;
  readonly home: string;
  /** The repository id UFO keys the run state by. */
  readonly repoId: string;
  readonly context: AppContext;
  /** `$UFO_HOME/private/runs/<repo-id>/<run-id>`. */
  runDir(runId: string): string;
  cleanup(): Promise<void>;
}

/** UFO's repository id of `repo`: 16 hex of sha256(real path of the common git dir). */
export function repoIdOf(repo: string): string {
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  return createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 16);
}

export interface ToyOptions {
  /** Rewrites the fixture's ufo.yaml before the first commit. */
  readonly config?: (yaml: string) => string;
  /** Extra environment of the worker and so of every workload command. */
  readonly env?: Record<string, string>;
}

/**
 * A fresh toy-http repository with its own UFO home, an empty global git config (so nothing
 * reads the developer's identity), and an app context whose worker runs from the sources on
 * a pinned, idle machine.
 */
export function makeToy(options: ToyOptions = {}): Toy {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ufo-it-")));
  const globalConfig = path.join(root, "global.gitconfig");
  writeFileSync(globalConfig, "");
  const gitEnv = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  // The test process runs git too (the app layer creates the arms in-process), so it needs the
  // empty global config while the toy lives; cleanup puts the previous values back.
  const previousEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  Object.assign(process.env, gitEnv);
  const restoreEnv = () => {
    // A toy made later owns the variables now; its own cleanup restores them.
    if (process.env.GIT_CONFIG_GLOBAL !== globalConfig) return;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const repo = path.join(root, "repo");
  cpSync(FIXTURE_REPO, repo, { recursive: true });
  if (options.config !== undefined) {
    const file = path.join(repo, "ufo.yaml");
    writeFileSync(file, options.config(readFileSync(file, "utf8")));
  }
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", TEST_IDENTITY.name);
  git(repo, "config", "user.email", TEST_IDENTITY.email);
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", "toy-http");
  const scratch = path.join(root, "scratch");
  git(root, "clone", "--quiet", repo, scratch);
  const home = path.join(root, "ufo-home");
  const id = repoIdOf(repo);
  const context: AppContext = {
    cwd: repo,
    home,
    cardDirs: [FIXTURE_CARDS],
    workerEntry: WORKER_ENTRY,
    // The launcher environment; a run passes on only its allowlisted part.
    workerEnv: { ...process.env, ...gitEnv, ...options.env },
    exec: dockerAbsent,
  };
  const runDir = (runId: string) => runDirFor(home, id, runId);
  return {
    root,
    repo,
    scratch,
    home,
    repoId: id,
    context,
    runDir,
    cleanup: async () => {
      let ids: string[] = [];
      try {
        ids = readdirSync(path.dirname(runDir("x")));
      } catch {
        // No run was started.
      }
      for (const runId of ids) {
        await killRunProcesses(runDir(runId), { exec: dockerAbsent, graceMs: 500 }).catch(
          () => undefined,
        );
      }
      await rm(root, { recursive: true, force: true });
      restoreEnv();
    },
  };
}

/**
 * For tests about state, locks, and policy rather than measurement: the toy's ufo.yaml with a
 * constant workload and no oracles, so its baseline costs almost nothing and does not load the
 * machine that the measuring tests share. `setup` replaces the toy's setup command.
 */
export function lightWorkload(setup = "node --check server.mjs") {
  return (yaml: string): string => {
    const start = yaml.indexOf("workload:\n");
    const end = yaml.indexOf("cards:\n");
    if (start === -1 || end === -1) throw new Error("the toy's ufo.yaml changed shape");
    const workload = [
      "workload:",
      `  setup: ${setup}`,
      `  command: 'node -e "console.log(JSON.stringify({ latency_ms: 1, error_rate: 0 }))"'`,
      "oracles: []",
      "",
    ].join("\n");
    return `${yaml.slice(0, start)}${workload}${yaml.slice(end)}`;
  };
}

/**
 * A toy for the built `ufo mcp`, which loads cards only as ufo.yaml declares them: the toy's
 * cards are committed in the repository (`cardDirs: [ufo-cards]`), and its context names no
 * other card directory, so an approval made with it is the one the server checks. The machine
 * checks are loosened, since the server's worker measures on this real machine.
 */
export function mcpToy(
  options: { readonly setup?: string; readonly config?: (yaml: string) => string } = {},
): Toy {
  const toy = makeToy({
    config: (yaml) =>
      (options.config ?? ((text: string) => text))(
        `${lightWorkload(options.setup)(yaml)}cardDirs:\n  - ufo-cards\nhygiene:\n  requireAcPower: false\n  maxLoadFactor: 64\n`,
      ),
  });
  cpSync(FIXTURE_CARDS, path.join(toy.repo, "ufo-cards"), { recursive: true });
  git(toy.repo, "add", "--all");
  git(toy.repo, "commit", "--quiet", "--message", "toy cards");
  return { ...toy, context: { ...toy.context, cardDirs: [] } };
}

/**
 * Plants `git`, `ps`, and `docker` in `dir` that only append their name to `marker`: what a
 * project could put on the PATH UFO starts with (security H1).
 */
export function plantPrograms(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ["git", "ps", "docker"]) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho ${name} >> '${marker}'\nexit 1\n`);
    chmodSync(file, 0o755);
  }
}

/** The environment `ufo mcp` runs in for `toy`: this process's, with the toy's UFO home. */
export function serverEnv(toy: Toy): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...process.env, UFO_HOME: toy.home })) {
    if (value !== undefined && name !== "CLAUDE_PROJECT_DIR") env[name] = value;
  }
  return env;
}

/**
 * Approves the toy's ufo.yaml as a human at a terminal would, through the gate's test seam
 * (production `approve()` reads the answer from /dev/tty).
 */
export function approveToy(toy: Toy, options: Partial<ApproveOptions & HumanGate> = {}) {
  return approveWithGate(toy.context, {
    stdin: { isTTY: true },
    print: () => undefined,
    confirm: async () => "approve",
    ...options,
  });
}

/** A unified diff against the toy's HEAD that rewrites `file` with `transform`. */
export function diffOf(toy: Toy, file: string, transform: (content: string) => string): string {
  const target = path.join(toy.scratch, file);
  const before = readFileSync(target, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`the transform leaves ${file} unchanged`);
  writeFileSync(target, after);
  try {
    return git(toy.scratch, "diff", "--no-color", "--", file);
  } finally {
    git(toy.scratch, "checkout", "--quiet", "--", file);
  }
}

export function workerLog(toy: Toy, runId: string): string {
  try {
    return readFileSync(path.join(toy.runDir(runId), LOGS_DIR, WORKER_ERR_LOG), "utf8");
  } catch {
    return "";
  }
}

/** Long-polls a job until it is terminal; a timeout includes the worker's stderr. */
export async function waitDone(
  toy: Toy,
  runId: string,
  jobId: string,
  timeoutMs = 60_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(toy.context, { runId, jobId, waitS: 2 });
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} is still ${job.status}\n${workerLog(toy, runId)}`);
    }
  }
}

/**
 * The files of the user's git directory except its objects and the run branches' refs and
 * reflogs: what AC 6 requires UFO to leave alone (no `worktrees/`, `FETCH_HEAD`, or config).
 */
export function gitDirListing(repo: string): string[] {
  return (readdirSync(path.join(repo, ".git"), { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join("/"))
    .filter(
      (entry) =>
        !entry.startsWith("objects") &&
        !/^(logs\/)?refs\/heads\/ufo(\/|$)/.test(entry) &&
        entry !== "logs/refs/heads" &&
        entry !== "refs/heads" &&
        entry !== "logs/refs",
    )
    .sort();
}

/**
 * What AC 6 compares in the user's repository: HEAD, the checked-out branch, the porcelain
 * status, the uncommitted changes byte for byte, and the ignore files UFO must never write.
 */
export function userState(repo: string) {
  const read = (file: string) => {
    try {
      return readFileSync(path.join(repo, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const status = git(repo, "--no-optional-locks", "status", "--porcelain");
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => [line.slice(3), read(line.slice(3))]);
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    branch: git(repo, "symbolic-ref", "HEAD").trim(),
    status,
    untracked: Object.fromEntries(untracked),
    unstaged: git(repo, "--no-optional-locks", "diff", "--binary"),
    staged: git(repo, "--no-optional-locks", "diff", "--cached", "--binary"),
    gitignore: read(".gitignore"),
    exclude: read(".git/info/exclude"),
  };
}

/** The decision a change job returned. */
export function decisionOf(job: JobRecord) {
  if (job.status !== "succeeded") {
    throw new Error(`job ${job.jobId} ${job.status}: ${job.error?.message ?? ""}`);
  }
  return (job.result as { decision: { outcome: string; reason?: string; detail?: string } })
    .decision;
}

/**
 * Asserts a keep and, when it is not one, fails with the whole decision (reason, detail,
 * effect, pairs) and the job's stats: `toMatchObject` would hide every field but `outcome`.
 */
export function expectKeep(decision: { outcome: string }, job?: JobRecord): void {
  if (decision.outcome === "keep") return;
  const stats = (job?.result as { stats?: unknown } | undefined)?.stats;
  throw new Error(
    `expected a keep, got ${JSON.stringify(decision, null, 2)}${
      stats === undefined ? "" : `\nstats: ${JSON.stringify(stats, null, 2)}`
    }`,
  );
}
