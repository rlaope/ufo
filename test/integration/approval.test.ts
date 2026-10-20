import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveWithGate } from "../../src/app/human-gate.js";
import {
  approve,
  cancelRun,
  describeFailure,
  extendBudget,
  startRun,
} from "../../src/app/index.js";
import { readMachineLock } from "../../src/core/jobs/index.js";
import type { Resolver } from "../../src/core/policy/index.js";
import { approveToy, git, makeToy, TIMEOUT_MS, type Toy } from "./helpers.js";

// AC 18 and AC 9 through the app layer: start_run refuses an unapproved or changed ufo.yaml and
// any target that is not loopback, the Docker bridge, or a listed private address; approval is
// human-only. A refusal leaves nothing behind: no run state, branch, worktree, or lock.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let toy: Toy;

beforeEach(() => {
  toy = makeToy();
});

afterEach(async () => {
  await toy.cleanup();
});

function approvals(): string[] {
  try {
    return readdirSync(path.join(toy.home, "private", "approvals"));
  } catch {
    return [];
  }
}

async function expectNothingStarted(): Promise<void> {
  const list = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      // Never created.
      return [];
    }
  };
  expect(list(path.dirname(toy.runDir("x")))).toEqual([]);
  expect(list(path.join(toy.home, "arms", toy.repoId))).toEqual([]);
  expect(git(toy.repo, "branch", "--list", "ufo/*")).toBe("");
  expect(git(toy.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  expect(await readMachineLock({ home: toy.home })).toBeUndefined();
}

/** The failure a rejected workflow reports, as the CLI would print it. */
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeDefined();
  return describeFailure(error);
}

const configFile = () => path.join(toy.repo, "ufo.yaml");

describe("approval (AC 18)", { timeout: TIMEOUT_MS }, () => {
  it("start_run refuses a ufo.yaml that was never approved", async () => {
    expect(await refusal(startRun(toy.context))).toMatchObject({
      exitCode: 1,
      code: "policy:unapproved_config",
    });
    await expectNothingStarted();
  });

  it("approve needs a terminal on stdin; an answer from anywhere else does not count", async () => {
    for (const stdin of [{ isTTY: false }, {}]) {
      const print = vi.fn();
      const confirm = vi.fn(async () => "approve");
      expect(await refusal(approveWithGate(toy.context, { stdin, print, confirm }))).toMatchObject({
        exitCode: 1,
        code: "policy:non_tty_approval",
      });
      expect(print).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    }
    // The production gate takes no answer from its caller: without a terminal it refuses even
    // when one is smuggled into the options.
    const smuggled = { print: vi.fn(), confirm: async () => "approve", stdin: { isTTY: true } };
    expect(await refusal(approve(toy.context, smuggled))).toMatchObject({
      exitCode: 1,
      code: "policy:non_tty_approval",
    });
    expect(smuggled.print).not.toHaveBeenCalled();
    const extendSmuggled = { ...smuggled, confirm: async () => "extend" };
    expect(await refusal(extendBudget(toy.context, extendSmuggled))).toMatchObject({
      exitCode: 1,
      code: "policy:non_tty_approval",
    });
    expect(approvals()).toEqual([]);
    expect((await refusal(startRun(toy.context))).code).toBe("policy:unapproved_config");
  });

  it("records nothing when the human declines or an opt-in flag does not match", async () => {
    expect(await refusal(approveToy(toy, { confirm: async () => "yes" }))).toMatchObject({
      exitCode: 1,
      code: "approval_declined",
    });
    expect(await refusal(approveToy(toy, { allowLossy: true }))).toMatchObject({
      exitCode: 1,
      code: "opt_in_mismatch",
    });
    writeFileSync(configFile(), `${readFileSync(configFile(), "utf8")}optIns:\n  - lossy\n`);
    expect((await refusal(approveToy(toy))).code).toBe("opt_in_mismatch");
    expect(approvals()).toEqual([]);
  });

  it("start_run refuses a ufo.yaml changed after approval, and starts on the approved bytes", async () => {
    const approved = readFileSync(configFile(), "utf8");
    const result = await approveToy(toy);
    expect(approvals()).toEqual([`${result.repoId}.json`]);
    for (const edited of [
      `${approved}\n`,
      `${approved}# a comment\n`,
      approved.replace("minEffect: 0.03", "minEffect: 0.01"),
    ]) {
      writeFileSync(configFile(), edited);
      expect(await refusal(startRun(toy.context))).toMatchObject({
        exitCode: 1,
        code: "policy:config_changed",
      });
      await expectNothingStarted();
    }
    writeFileSync(configFile(), approved);
    const run = await startRun(toy.context);
    expect(run.branch).toBe(`ufo/run-${run.runId}`);
    await cancelRun(toy.context, { runId: run.runId });
  });

  it("writes approvals only from approveWithGate(), after its TTY check", () => {
    const sources = readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(entry.parentPath, entry.name));
    const writers = sources
      .filter((file) => /\brecordApproval\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .sort();
    expect(writers).toEqual(["src/app/human-gate.ts", "src/core/policy/approvals.ts"]);
    const source = readFileSync(path.join(ROOT, "src/app/human-gate.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function approveWithGate("));
    const gate = body.indexOf("requireTty(options.stdin);");
    expect(gate).toBeGreaterThan(0);
    const repo = body.indexOf("repoOf(");
    expect(repo).toBeGreaterThan(0);
    expect(gate).toBeLessThan(repo);
    expect(gate).toBeLessThan(body.indexOf("recordApproval("));
  });
});

// The resolver stands in for DNS; no test resolves a real name.
const DNS: Record<string, string[]> = {
  "api.example.com": ["1.1.1.1"],
  "split.example.com": ["10.0.0.7", "1.1.1.1"],
  "db.internal": ["10.1.2.3"],
  "cache.internal": ["fd12:3456::7"],
  localhost: ["127.0.0.1", "::1"],
};

function fakeResolver(calls: string[]): Resolver {
  return async (name) => {
    calls.push(name);
    return (DNS[name] ?? []).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
}

/** Lists `targets` in ufo.yaml, approves it, and starts a run with the fake resolver. */
async function startWithTargets(targets: readonly string[], calls: string[]) {
  const listed = targets.map((target) => `  - "${target}"`).join("\n");
  writeFileSync(
    configFile(),
    readFileSync(configFile(), "utf8").replace(/^cards:/m, `targets:\n${listed}\ncards:`),
  );
  await approveToy(toy);
  return startRun({ ...toy.context, resolver: fakeResolver(calls) });
}

describe("load targets (AC 9)", { timeout: TIMEOUT_MS }, () => {
  it.each([
    { targets: ["api.example.com"], address: "1.1.1.1", resolved: ["api.example.com"] },
    { targets: ["8.8.8.8"], address: "8.8.8.8", resolved: [] },
    {
      targets: ["db.internal", "split.example.com"],
      address: "1.1.1.1",
      resolved: ["db.internal", "split.example.com"],
    },
    { targets: ["169.254.169.254"], address: "169.254.169.254", resolved: [] },
    { targets: ["100.64.0.1"], address: "100.64.0.1", resolved: [] },
  ])("refuses $targets although approved, since it resolves to $address", async (example) => {
    const calls: string[] = [];
    const failure = await refusal(startWithTargets(example.targets, calls));
    expect(failure).toMatchObject({ exitCode: 1, code: "policy:target_not_allowed" });
    expect(failure.message).toContain(`resolves to ${example.address}`);
    expect(failure.message).toContain("external targets are deferred past v1");
    expect(calls).toEqual(example.resolved);
    expect(approvals()).toHaveLength(1);
    await expectNothingStarted();
  });

  it("starts with listed RFC 1918 and ULA targets, resolving each hostname once", async () => {
    const calls: string[] = [];
    const run = await startWithTargets(
      ["10.0.0.0/8", "192.168.10.20", "db.internal", "cache.internal", "fd00::/8", "localhost"],
      calls,
    );
    expect(calls).toEqual(["db.internal", "cache.internal", "localhost"]);
    await cancelRun(toy.context, { runId: run.runId });
  });
});
