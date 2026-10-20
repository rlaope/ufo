import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRun, listRunIds, measure } from "../../src/app/index.js";
import { main } from "../../src/cli/main.js";
import {
  listJobs,
  readLedger,
  readMachineLock,
  readRun,
  TERMINAL_JOB_STATUSES,
} from "../../src/core/jobs/index.js";
import {
  approveToy,
  BUILT_CLI,
  git,
  lightWorkload,
  makeToy,
  plantPrograms,
  TIMEOUT_MS,
  type Toy,
  userState,
  workerLog,
} from "./helpers.js";

// The CLI end to end. `ufo measure` and `ufo run` go through main() with the toy's context (its
// UFO home, card directory, and the test worker on a pinned machine); the built CLI (the package
// test/global-setup.ts builds) refuses a piped approval and an unapproved run.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

let toy: Toy;

// The package is built by test/global-setup.ts, so the test runs what it ships.
beforeAll(() => {
  toy = makeToy();
}, TIMEOUT_MS);

afterAll(async () => {
  await toy.cleanup();
});

/** The built CLI with stdin piped from `input`, as `echo approve | ufo approve` would run it. */
function built(target: Toy, args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: target.repo,
    env: { ...process.env, UFO_HOME: target.home, ...env },
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `ufo <args>` in-process, with the toy's app context. */
async function ufo(args: string[], target: Toy = toy, signals?: EventEmitter) {
  let stdout = "";
  let stderr = "";
  const { cwd, ...context } = target.context;
  const code = await main(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd,
    context,
    // A copy: main() filters the PATH of the environment it is given.
    env: { ...process.env },
    ...(signals === undefined ? {} : { signals }),
  });
  return { code, stdout, stderr };
}

function noRunLeftover(target: Toy) {
  expect(git(target.repo, "branch", "--list", "ufo/*")).toBe("");
  expect(git(target.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}

describe("ufo CLI", { timeout: TIMEOUT_MS }, () => {
  // Code review CR-N10: the tests never rebuild the working tree's dist/ under a running test.
  it("built: runs the package built outside the working tree", () => {
    expect(path.isAbsolute(BUILT_CLI)).toBe(true);
    expect(path.relative(ROOT, BUILT_CLI).startsWith("..")).toBe(true);
  });

  it("built: refuses an approval from piped stdin (AC 18) and an unapproved run", async () => {
    const fresh = makeToy();
    try {
      expect(built(fresh, ["--version"])).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });

      const piped = built(fresh, ["approve"], "approve\n");
      expect(piped).toMatchObject({ code: 1, stdout: "" });
      expect(piped.stderr).toBe(
        "ufo approve: policy:non_tty_approval: ufo approve needs an interactive terminal on stdin: a person must run `ufo approve` in their own terminal; an agent must not run it\n",
      );
      const json = built(fresh, ["approve", "--allow-lossy", "--json"], "approve\n");
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false,
        command: "approve",
        error: {
          code: "policy:non_tty_approval",
          message:
            "ufo approve needs an interactive terminal on stdin: a person must run `ufo approve` in their own terminal; an agent must not run it",
        },
      });
      expect(built(fresh, ["approve", "--yes"], "approve\n").code).toBe(2);
      expect(existsSync(fresh.home)).toBe(false);

      const run = built(fresh, ["run"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("ufo run: policy:unapproved_config:");
      expect(built(fresh, ["extend-budget"], "extend\n")).toMatchObject({ code: 1 });
      expect(built(fresh, ["report"]).code).toBe(2);
      noRunLeftover(fresh);

      // Security H1, N4: git and ps from the project or a node_modules directory on the PATH
      // (npx and npm scripts put them first) are never run.
      const marker = path.join(fresh.root, "planted-ran");
      const planted = [
        path.join(fresh.repo, "node_modules", ".bin"),
        path.join(fresh.root, "node_modules", ".bin"),
        path.join(fresh.repo, "tools"),
      ];
      for (const dir of planted) plantPrograms(dir, marker);
      const onPath = { PATH: [...planted, process.env.PATH ?? ""].join(path.delimiter) };
      expect(built(fresh, ["status", "--json"], "", onPath).code).toBe(0);
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
    } finally {
      await fresh.cleanup();
    }
  });

  it("ufo measure prints the baseline samples and stats, and leaves no run behind", async () => {
    // The CLI's output is under test, not the machine's noise: a workload with a constant value
    // keeps the baseline decidable however busy the machine is, with the toy's real oracles.
    const steady = makeToy({
      config: (yaml) =>
        yaml.replace(
          "  command: node bench/latency.mjs",
          `  command: 'node -e "console.log(JSON.stringify({ latency_ms: 1, error_rate: 0 }))"'`,
        ),
    });
    try {
      await measuresSteadily(steady);
    } finally {
      await steady.cleanup();
    }
    await approveToy(toy);
  });

  async function measuresSteadily(target: Toy) {
    await approveToy(target);
    const before = userState(target.repo);
    const result = await ufo(["measure"], target);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /^Baseline at [0-9a-f]{7}: median [\d.]+ over 5 samples \([\d.]+(?:, [\d.]+){4}\)$/m,
    );
    expect(result.stdout).toMatch(/^Noise floor: \d+\.\d%$/m);
    expect(result.stdout).toContain("Oracle unit-tests: passed (4 passed, 0 failed, 4 executed)");
    expect(result.stdout).toContain("Oracle smoke: passed");
    expect(result.stdout).not.toContain("Refusal:");

    const status = await ufo(["status", "--json"], target);
    expect(status.code).toBe(0);
    const view = JSON.parse(status.stdout).result;
    expect(view.runs).toMatchObject([{ status: "finished" }]);
    expect(view.current).toMatchObject({ purpose: "measure", status: "finished" });
    expect(view.lock).toBeUndefined();
    noRunLeftover(target);
    expect(userState(target.repo)).toEqual(before);
  }

  it("ufo run applies the recipe card, keeps it, and prints the report", async () => {
    const before = userState(toy.repo);
    const result = await ufo(["run"]);
    const runId = /^run (\S+) on /m.exec(result.stderr)?.[1] ?? "";
    expect(result.code, `${result.stderr}\n${workerLog(toy, runId)}`).toBe(0);
    expect(result.stderr).toContain(`run ${runId} on ufo/run-${runId}`);
    expect(result.stderr).toContain("toy.no-delay: keep");

    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^Run ${runId}: [0-9a-f]{7} -> [0-9a-f]{7} on ufo/run-${runId}$`),
    );
    expect(lines[1]).toMatch(
      /^toy-http GET \/items, 15 sequential requests on loopback: latency_ms [\d.]+ → [\d.]+ ms \(.+, 5 pairs, .+, no agent \(recipes\)\)$/,
    );
    expect(result.stdout).toMatch(/^ {2}toy\.no-delay keep [+-]?\d+\.\d% -> [0-9a-f]{7}$/m);
    expect(result.stdout).toMatch(/^Evidence bundle: .+$/m);

    const reported = await ufo(["report", "--run", runId, "--json"]);
    expect(reported.code).toBe(0);
    expect(JSON.parse(reported.stdout).result).toMatchObject({
      runId,
      headline: lines[1],
      decisions: [{ cardId: "toy.no-delay", outcome: "keep" }],
    });

    // One commit on the run branch: the recipe's edit with its trailers.
    const branch = `ufo/run-${runId}`;
    expect(git(toy.repo, "rev-list", "--count", `main..${branch}`).trim()).toBe("1");
    expect(git(toy.repo, "show", `${branch}:toy.properties`)).toContain("items.extra_delay_ms=0\n");
    expect(git(toy.repo, "log", "-1", "--format=%(trailers:only,unfold)", branch)).toContain(
      "Ufo-Technique: toy.no-delay",
    );
    expect(await readMachineLock({ home: toy.home })).toBeUndefined();
    expect(userState(toy.repo)).toEqual(before);
  });
});

/** Signals as a Ctrl-C delivers them, once `ufo` listens for one and `ready` holds. */
function ctrlC(ready: () => Promise<boolean> = async () => true): EventEmitter {
  const signals = new EventEmitter();
  signals.on("newListener", (event) => {
    if (event !== "SIGINT") return;
    const poll = async () => {
      if (await ready().catch(() => false)) signals.emit("SIGINT");
      else setTimeout(poll, 20);
    };
    setImmediate(poll);
  });
  return signals;
}

/**
 * Whether a baseline of `target` is being measured right now. A run whose start has made its
 * directory but not yet its jobs/ is not: the poll must not fail while `measure` is starting.
 */
const measuring = (target: Toy) => async () => {
  for (const id of await listRunIds(target.home, { repoId: target.repoId })) {
    const jobs = await listJobs(target.runDir(id)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (jobs.some((job) => job.kind === "baseline" && job.status === "running")) return true;
  }
  return false;
};

// Code review (round 3) #2: Ctrl-C on `ufo run` or `ufo measure` cancels the run instead of
// leaving it running behind the command with the machine lock held.
describe("Ctrl-C", { timeout: TIMEOUT_MS }, () => {
  it("measuring: a run whose start made its directory but not yet jobs/ is not measuring", async () => {
    const own = makeToy();
    try {
      // createRunState makes the run directory, then jobs/: a poll can land in between.
      mkdirSync(own.runDir("20261020-000000-abcdef"), { recursive: true });
      expect(await measuring(own)()).toBe(false);
    } finally {
      await own.cleanup();
    }
  });

  it("cancels the run of ufo measure and ufo run, and releases the machine lock", async () => {
    const own = makeToy({ config: lightWorkload() });
    try {
      await approveToy(own);
      for (const command of ["measure", "run"]) {
        const result = await ufo([command], own, ctrlC());
        expect(result.code, result.stderr).toBe(1);
        const line = result.stderr.match(
          new RegExp(
            `^ufo ${command}: interrupted: interrupted; (?:measure )?run (\\S+) was cancelled$`,
            "m",
          ),
        );
        expect(line, result.stderr).not.toBeNull();
        expect(result.stderr).toContain(
          "interrupted: cancelling the run (Ctrl-C again to stop waiting)",
        );
        expect((await readRun(own.runDir(line?.[1] as string))).status).toBe("cancelled");
        expect(await readMachineLock({ home: own.home })).toBeUndefined();
        if (command === "measure") noRunLeftover(own);
      }
    } finally {
      await own.cleanup();
    }
  });

  it("fails a start it interrupted as interrupted, saying why the start stopped", async () => {
    // Not approved: the start fails, as one whose git or ps process got the Ctrl-C would.
    const own = makeToy({ config: lightWorkload() });
    try {
      const result = await ufo(["run"], own, ctrlC());
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toMatch(
        /^ufo run: interrupted: interrupted; the run did not start \(.*approve.*\)$/m,
      );
      expect(await readMachineLock({ home: own.home })).toBeUndefined();
    } finally {
      await own.cleanup();
    }
  });

  it("leaves the cleanup of a measure run cancelled from outside to that cancel", async () => {
    const own = makeToy();
    let measured: Promise<unknown> | undefined;
    try {
      await approveToy(own);
      // Settled into a value at once: measure may fail before the cancel below returns.
      measured = measure(own.context).then(
        () => undefined,
        (error: unknown) => error,
      );
      const ready = measuring(own);
      while (!(await ready())) await new Promise((resolve) => setTimeout(resolve, 20));
      const [runId] = await listRunIds(own.home, { repoId: own.repoId });
      await cancelRun(own.context, { runId: runId as string });
      expect(await measured).toMatchObject({ code: "measurement_failed" });
      const types = (await readLedger(own.runDir(runId as string))).map((event) => event.type);
      expect(types).toContain("run_cancelled");
      expect(types).not.toContain("cleanup_failed");
      expect((await readRun(own.runDir(runId as string))).status).toBe("cancelled");
      noRunLeftover(own);
    } finally {
      // A failure above must not remove the toy under a measure still running in this process.
      await measured;
      await own.cleanup();
    }
  });

  it("cancels ufo measure interrupted while its baseline is measured", async () => {
    // The toy's own workload: the baseline takes seconds, long enough to be interrupted.
    const own = makeToy();
    try {
      await approveToy(own);
      const result = await ufo(["measure"], own, ctrlC(measuring(own)));
      expect(result.code, result.stderr).toBe(1);
      const line = result.stderr.match(
        /^ufo measure: interrupted: interrupted; measure run (\S+) was cancelled$/m,
      );
      expect(line, result.stderr).not.toBeNull();
      // Cancelled as `ufo cancel` does: the baseline job too, and the cancel is recorded.
      const runDir = own.runDir(line?.[1] as string);
      const jobs = await listJobs(runDir);
      expect(jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status))).toEqual([]);
      expect((await readLedger(runDir)).map((event) => event.type)).toContain("run_cancelled");
      expect(await readMachineLock({ home: own.home })).toBeUndefined();
      noRunLeftover(own);
    } finally {
      await own.cleanup();
    }
  });
});

// Verifier V6: the shipped worker entry (dist/cli/index.js) on this real machine, with the
// machine checks loosened in ufo.yaml so the test does not depend on AC power or an idle CPU.
describe("the built ufo worker", { timeout: TIMEOUT_MS }, () => {
  it("measures a baseline with hygiene loosened in ufo.yaml, and records it as a limitation", async () => {
    const real = makeToy({
      config: (yaml) =>
        `${lightWorkload()(yaml)}hygiene:\n  requireAcPower: false\n  maxLoadFactor: 64\n`,
    });
    try {
      await approveToy(real);
      const result = await measure({ ...real.context, workerEntry: BUILT_CLI });
      expect(result.baseline.values).toHaveLength(5);
      expect(result.baseline.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("allowed on battery power"),
          expect.stringContaining("64 × cores"),
        ]),
      );
    } finally {
      await real.cleanup();
    }
  });
});
