import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import { readMachineLock } from "../../src/core/jobs/index.js";
import { approveToy, git, makeToy, TIMEOUT_MS, type Toy, userState, workerLog } from "./helpers.js";

// The CLI end to end. `ufo measure` and `ufo run` go through main() with the toy's context (its
// UFO home, card directory, and the test worker on a pinned machine); the built
// `dist/cli/index.js` refuses a piped approval and an unapproved run.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILT_CLI = path.join(ROOT, "dist", "cli", "index.js");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

let toy: Toy;

beforeAll(() => {
  // `npm run build`, so the test runs what the package ships.
  execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: ROOT, stdio: "pipe" },
  );
  toy = makeToy();
}, TIMEOUT_MS);

afterAll(async () => {
  await toy.cleanup();
});

/** The built CLI with stdin piped from `input`, as `echo approve | ufo approve` would run it. */
function built(target: Toy, args: string[], input = "") {
  const result = spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: target.repo,
    env: { ...process.env, UFO_HOME: target.home },
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `ufo <args>` in-process, with the toy's app context. */
async function ufo(args: string[]) {
  let stdout = "";
  let stderr = "";
  const { cwd, ...context } = toy.context;
  const code = await main(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd,
    context,
  });
  return { code, stdout, stderr };
}

function noRunLeftover(target: Toy) {
  expect(git(target.repo, "branch", "--list", "ufo/*")).toBe("");
  expect(git(target.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}

describe("ufo CLI", { timeout: TIMEOUT_MS }, () => {
  it("built: refuses an approval from piped stdin (AC 18) and an unapproved run", async () => {
    const fresh = makeToy();
    try {
      expect(built(fresh, ["--version"])).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });

      const piped = built(fresh, ["approve"], "approve\n");
      expect(piped).toMatchObject({ code: 1, stdout: "" });
      expect(piped.stderr).toBe(
        "ufo approve: policy:non_tty_approval: ufo approve needs an interactive terminal on stdin\n",
      );
      const json = built(fresh, ["approve", "--allow-lossy", "--json"], "approve\n");
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false,
        command: "approve",
        error: {
          code: "policy:non_tty_approval",
          message: "ufo approve needs an interactive terminal on stdin",
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
    } finally {
      await fresh.cleanup();
    }
  });

  it("ufo measure prints the baseline samples and stats, and leaves no run behind", async () => {
    await approveToy(toy);
    const before = userState(toy.repo);
    const result = await ufo(["measure"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /^Baseline at [0-9a-f]{7}: median [\d.]+ over 5 samples \([\d.]+(?:, [\d.]+){4}\)$/m,
    );
    expect(result.stdout).toMatch(/^Noise floor: \d+\.\d%$/m);
    expect(result.stdout).toContain("Oracle unit-tests: passed (4 passed, 0 failed, 4 executed)");
    expect(result.stdout).toContain("Oracle smoke: passed");
    expect(result.stdout).not.toContain("Refusal:");

    const status = await ufo(["status", "--json"]);
    expect(status.code).toBe(0);
    const view = JSON.parse(status.stdout).result;
    expect(view.runs).toMatchObject([{ status: "finished" }]);
    expect(view.current).toMatchObject({ purpose: "measure", status: "finished" });
    expect(view.lock).toBeUndefined();
    noRunLeftover(toy);
    expect(userState(toy.repo)).toEqual(before);
  });

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
