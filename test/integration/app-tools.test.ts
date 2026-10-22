import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelRun,
  checkCapabilities,
  DEFAULT_INDEX_PAGE,
  draftConfigFor,
  finishRun,
  getJob,
  getRun,
  getTechnique,
  init,
  inspectTarget,
  JOB_KINDS,
  listTechniques,
  parseConfigText,
  profileTarget,
  readAppState,
  resolveRepo,
  startRun,
  status,
} from "../../src/app/index.js";
import { ensureWorker } from "../../src/app/launch.js";
import { enqueueJob, readRun, updateRun } from "../../src/core/jobs/index.js";
import { MAX_RESULT_BYTES, success } from "../../src/mcp/results.js";
import {
  approveToy,
  git,
  lightWorkload,
  listEveryTechnique,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// M2 B2: the app workflows behind the MCP tools inspect_target, check_capabilities,
// list_techniques, profile_target, and a get_job wait an MCP client cancels.

let toy: Toy;

beforeAll(async () => {
  toy = makeToy({ config: lightWorkload() });
  await approveToy(toy);
});

afterAll(async () => {
  await toy.cleanup();
});

// Code review R4: a caller that pinned the repository (ufo mcp) gets its workflows acting on that
// one resolution, wherever its working directory is.
describe("a pinned repository", { timeout: TIMEOUT_MS }, () => {
  it("is the one the workflows act on", async () => {
    const pinned = { ...toy.context, cwd: os.tmpdir(), repo: await resolveRepo(toy.repo) };
    expect((await inspectTarget(pinned)).repoRoot).toBe(toy.repo);
    expect((await status(pinned)).repoRoot).toBe(toy.repo);
  });
});

describe("inspecting the target", { timeout: TIMEOUT_MS }, () => {
  it("reports the stack, the approved ufo.yaml, its objective, cards, and commands", async () => {
    const view = await inspectTarget(toy.context);
    expect(view).toMatchObject({
      repoRoot: toy.repo,
      stack: ["package.json"],
      config: { present: true, valid: true },
      approval: { approved: true },
      objective: { primary: { name: "latency_ms", direction: "lower_is_better" } },
      optIns: [],
    });
    expect(view.cards).toEqual([
      { id: "generic.code-change", known: true },
      { id: "toy.fast-path", known: true },
      { id: "toy.cache-items", known: true },
      { id: "toy.no-delay", known: true },
    ]);
    expect(view.commands).toEqual(
      expect.arrayContaining([
        { what: "workload setup", command: "node --check server.mjs" },
        expect.objectContaining({ what: "workload command" }),
      ]),
    );
  });

  it("says when ufo.yaml is not approved, and when there is none", async () => {
    const other = makeToy({ config: lightWorkload() });
    try {
      expect(await inspectTarget(other.context)).toMatchObject({
        config: { present: true, valid: true },
        approval: {
          approved: false,
          reason: "policy:unapproved_config",
          detail:
            "ufo.yaml has not been approved; a person must run `ufo approve` in their own terminal; an agent must not run it",
        },
      });
      rmSync(path.join(other.repo, "ufo.yaml"));
      const missing = await inspectTarget(other.context);
      expect(missing).toEqual({
        repoRoot: other.repo,
        stack: ["package.json"],
        stacks: [
          {
            id: "node",
            evidence: ["package.json"],
            suggestions: { workloadHint: expect.stringContaining("latency") },
          },
        ],
        config: {
          present: false,
          valid: false,
          error: "config_missing: no ufo.yaml at the repository root; run ufo init",
        },
        // Code review R7: the draft to fill in, since the agent may have no ufo on its PATH.
        draftConfig: draftConfigFor(missing.stacks),
      });
      expect(missing.draftConfig).toContain("# Detected node: latency");
      // A Node project with a test script gets its command as a commented-out oracle, and the
      // draft still parses: only the marked workload command is left to fill in.
      writeFileSync(
        path.join(other.repo, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" }, dependencies: { vite: "6.0.0" } }),
      );
      const withTests = await inspectTarget(other.context);
      expect(withTests.stacks.map((stack) => stack.id)).toEqual(["node", "vite"]);
      const draft = withTests.draftConfig ?? "";
      expect(draft).toContain("#    command: npm test");
      expect(draft).toContain("# FILL IN:");
      expect(parseConfigText(draft).workload.command).toContain("replace this with your benchmark");
      expect(parseConfigText(draft).oracles).toEqual([]);
      // ufo init writes the draft inspect_target returns.
      const written = await init(other.context);
      expect(readFileSync(written.path, "utf8")).toBe(withTests.draftConfig);
      await expect(init(other.context)).rejects.toMatchObject({ code: "config_exists" });
      writeFileSync(path.join(other.repo, "ufo.yaml"), "version: [\n");
      const invalid = await inspectTarget(other.context);
      expect(invalid.config).toMatchObject({ present: true, valid: false });
      expect(invalid).not.toHaveProperty("draftConfig");
    } finally {
      await other.cleanup();
    }
  });
});

describe("checking capabilities", { timeout: TIMEOUT_MS }, () => {
  it("finds git, Node.js, and each program the commands start, and runs none of them", async () => {
    const other = makeToy({ config: lightWorkload("touch ran-by-ufo && no-such-program-ufo") });
    try {
      const report = await checkCapabilities(other.context);
      expect(report.git).toMatchObject({
        found: true,
        version: expect.stringMatching(/^\d+\.\d+/),
      });
      expect(report.node).toEqual({ version: process.version });
      // The toy context's docker runner finds no Docker.
      expect(report.docker).toEqual({ found: false, error: "not installed (not on PATH)" });
      // Code review CR-N9: installed but its daemon stopped, and running.
      const stopped = {
        ...other.context,
        exec: async () => {
          throw Object.assign(new Error("Command failed: docker version"), {
            code: 1,
            stderr: "\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.\nmore\n",
          });
        },
      };
      expect((await checkCapabilities(stopped)).docker).toEqual({
        found: true,
        reachable: false,
        error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      });
      const running = { ...other.context, exec: async () => ({ stdout: "29.7.2\n" }) };
      expect((await checkCapabilities(running)).docker).toEqual({
        found: true,
        reachable: true,
        version: "29.7.2",
      });
      expect(report.programs).toEqual([
        expect.objectContaining({ program: "touch", found: true, where: "path" }),
        {
          program: "node",
          found: true,
          where: "path",
          path: expect.stringMatching(/\/node$/),
          // The toy's cards run node too.
          usedBy: expect.arrayContaining(["workload command", "card toy.no-delay reset"]),
        },
      ]);
      expect(report.programs[0]?.usedBy).toEqual(["workload setup"]);
      expect(existsSync(path.join(other.repo, "ran-by-ufo"))).toBe(false);

      // Security N4: a relative path that leaves the repository is not looked up, even when a
      // file is there.
      const escaping = makeToy({ config: lightWorkload("../escape/tool --version") });
      try {
        mkdirSync(path.join(escaping.root, "escape"));
        writeFileSync(path.join(escaping.root, "escape", "tool"), "#!/bin/sh\n");
        expect((await checkCapabilities(escaping.context)).programs[0]).toMatchObject({
          program: "../escape/tool",
          found: false,
          where: "outside_repository",
        });
      } finally {
        await escaping.cleanup();
      }

      const missing = makeToy({ config: lightWorkload("no-such-program-ufo --version") });
      try {
        expect((await checkCapabilities(missing.context)).programs[0]).toEqual({
          program: "no-such-program-ufo",
          found: false,
          hint: "install no-such-program-ufo, or put it on PATH outside the repository and UFO's home",
          usedBy: ["workload setup"],
        });
      } finally {
        await missing.cleanup();
      }
    } finally {
      await other.cleanup();
    }
  });
});

describe("listing techniques", { timeout: TIMEOUT_MS }, () => {
  it("lists every known card with its signals and whether ufo.yaml enables it", async () => {
    const { cards } = await listEveryTechnique(toy.context);
    expect(cards.map((card) => card.id)).toEqual(
      expect.arrayContaining(["generic.code-change", "toy.fast-path", "toy.no-delay"]),
    );
    // The toy is a Node project: its stack's cards first, then any stack's, then the rest; each
    // group in id order.
    const ids = cards.map((card) => card.id);
    const groups = [
      cards.filter((card) => card.stacks.includes("node")),
      cards.filter((card) => card.stacks.length === 0),
      cards.filter((card) => card.stacks.length > 0 && !card.stacks.includes("node")),
    ].map((group) => group.map((card) => card.id));
    expect(ids).toEqual(groups.flat());
    for (const group of groups) expect(group).toEqual([...group].sort());
    const fastPath = cards.find((card) => card.id === "toy.fast-path");
    expect(fastPath).toMatchObject({ domain: "toy", enabled: true, kind: expect.any(String) });
    // The index holds none of the long fields; getTechnique opens the card.
    expect(Object.keys(fastPath ?? {}).sort()).toEqual(
      [
        "bottlenecks",
        "domain",
        "enabled",
        "expectedEffect",
        "id",
        "kind",
        "riskClass",
        "stacks",
        "title",
      ].sort(),
    );
    expect(
      (await getTechnique(toy.context, { cardId: "toy.fast-path" })).card.signals.length,
    ).toBeGreaterThan(0);
    const toyOnly = await listTechniques(toy.context, { domain: "toy" });
    expect(toyOnly.cards.length).toBeGreaterThan(0);
    expect(toyOnly.cards.every((card) => card.domain === "toy")).toBe(true);
  });
});

describe("the technique index", { timeout: TIMEOUT_MS }, () => {
  it("lists the first page of every built-in card within the result budget, unfiltered", async () => {
    const listing = await listTechniques(toy.context);
    expect(listing.total).toBeGreaterThan(50);
    expect(listing.cards).toHaveLength(DEFAULT_INDEX_PAGE);
    expect(listing.nextCursor).toEqual(expect.any(String));
    const text = JSON.stringify(success(listing).structuredContent);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_RESULT_BYTES);
    expect(text).not.toContain("truncated");
    for (const card of listing.cards) {
      expect(Object.keys(card)).not.toContain("signals");
    }
  });

  // M6: pages of one order, computed once over the whole listing.
  it("pages the whole order, whatever the page size, to a last page without a cursor", async () => {
    const pagesOf = async (options: Parameters<typeof listTechniques>[1] = {}) => {
      const pages = [await listTechniques(toy.context, options)];
      for (let next = pages[0]?.nextCursor; next !== undefined; next = pages.at(-1)?.nextCursor) {
        pages.push(await listTechniques(toy.context, { ...options, cursor: next }));
      }
      return pages;
    };
    const every = await listEveryTechnique(toy.context);
    expect(every.cards).toHaveLength(every.total);
    expect(new Set(every.cards.map((card) => card.id)).size).toBe(every.total);
    for (const limit of [undefined, 1, 7, 50]) {
      const pages = await pagesOf(limit === undefined ? {} : { limit });
      const size = limit ?? DEFAULT_INDEX_PAGE;
      expect(pages, String(limit)).toHaveLength(Math.ceil(every.total / size));
      expect(pages.flatMap((page) => page.cards)).toEqual(every.cards);
      expect(pages.every((page) => page.total === every.total)).toBe(true);
      expect(pages.at(-1)).not.toHaveProperty("nextCursor");
    }
    // The total counts the cards after the filters.
    const startup = await listEveryTechnique(toy.context, { bottleneck: "startup" });
    expect(startup.total).toBe(
      every.cards.filter((card) => card.bottlenecks.includes("startup")).length,
    );
    expect(startup.cards).toHaveLength(startup.total);
    const jvm = await listTechniques(toy.context, { stack: "jvm", bottleneck: "startup" });
    expect(jvm.total).toBe(
      startup.cards.filter((card) => card.stacks.length === 0 || card.stacks.includes("jvm"))
        .length,
    );
  });

  it("refuses a cursor of other filters, a cursor altered or made up, and a limit out of bounds", async () => {
    const first = await listTechniques(toy.context, { bottleneck: "cpu", limit: 2 });
    const cursor = first.nextCursor ?? "";
    expect(cursor).toMatch(/^2\.[0-9a-f]{16}$/);
    expect(
      (await listTechniques(toy.context, { bottleneck: "cpu", cursor })).cards[0]?.id,
    ).toBeDefined();
    const [offset, digest] = cursor.split(".");
    for (const [options, label] of [
      [{ bottleneck: "io", cursor }, "another bottleneck"],
      [{ cursor }, "no filter"],
      [{ bottleneck: "cpu", stack: "jvm", cursor }, "another stack"],
      [{ bottleneck: "cpu", domain: "toy", cursor }, "another domain"],
      [{ bottleneck: "cpu", cursor: `3.${digest}` }, "another offset"],
      [{ bottleneck: "cpu", cursor: `0${offset}.${digest}` }, "a leading zero"],
      [{ bottleneck: "cpu", cursor: `${offset}.${digest}0` }, "a longer digest"],
      [{ bottleneck: "cpu", cursor: `${offset}.${digest?.toUpperCase()}` }, "an upper-case digest"],
      [{ bottleneck: "cpu", cursor: `-1.${digest}` }, "a negative offset"],
      [{ bottleneck: "cpu", cursor: `1e1.${digest}` }, "an exponent"],
      [{ bottleneck: "cpu", cursor: `999999.${digest}` }, "an offset past the end"],
      [{ bottleneck: "cpu", cursor: "" }, "empty"],
      [{ bottleneck: "cpu", cursor: "../run.json" }, "a path"],
      [{ bottleneck: "cpu", cursor: "x".repeat(10_000) }, "oversized"],
    ] as const) {
      await expect(listTechniques(toy.context, options), label).rejects.toMatchObject({
        code: "usage",
        message: expect.stringContaining("list_techniques again without cursor"),
      });
    }
    for (const limit of [0, 51, 1.5, Number.NaN]) {
      await expect(listTechniques(toy.context, { limit }), String(limit)).rejects.toMatchObject({
        code: "usage",
        message: "limit must be a whole number from 1 to 50",
      });
    }
  });
});

describe("filtering and ordering techniques by stack and bottleneck", {
  timeout: TIMEOUT_MS,
}, () => {
  function card(name: string, stacks: string[], bottlenecks: string[]): string {
    return [
      `id: stk.${name}`,
      "domain: stk",
      `title: Card ${name}`,
      "kind: guided",
      "riskClass: lossless",
      `stacks: [${stacks.join(", ")}]`,
      `bottlenecks: [${bottlenecks.join(", ")}]`,
      "signals:",
      "  - evidence",
      "steps:",
      "  - first",
      "  - second",
      "expectedEffect: faster when measured",
      "sources:",
      "  - https://example.com/ufo-test-fixture",
      "verifiedIn: unverified",
      "",
    ].join("\n");
  }

  it("keeps the cards for the stack asked for and for any stack, and the bottleneck asked for", async () => {
    // The toy repository is a Node project.
    const other = makeToy({
      config: (yaml) => `${lightWorkload()(yaml)}cardDirs:\n  - cards\n`,
    });
    try {
      mkdirSync(path.join(other.repo, "cards", "stk"), { recursive: true });
      const write = (name: string, stacks: string[], bottlenecks: string[]) =>
        writeFileSync(
          path.join(other.repo, "cards", "stk", `${name}.yaml`),
          card(name, stacks, bottlenecks),
        );
      write("a-jvm-startup", ["jvm", "spring-boot"], ["startup"]);
      write("b-any-io", [], ["io"]);
      write("c-node-cpu", ["node"], ["cpu", "io"]);
      const ids = async (options: Parameters<typeof listTechniques>[1] = {}) =>
        (await listTechniques(other.context, { domain: "stk", ...options })).cards.map(
          (listed) => listed.id,
        );
      // The detected stack first, then any stack, then the others.
      expect(await ids()).toEqual(["stk.c-node-cpu", "stk.b-any-io", "stk.a-jvm-startup"]);
      expect(await ids({ stack: "jvm" })).toEqual(["stk.a-jvm-startup", "stk.b-any-io"]);
      expect(await ids({ stack: "python" })).toEqual(["stk.b-any-io"]);
      expect(await ids({ bottleneck: "io" })).toEqual(["stk.c-node-cpu", "stk.b-any-io"]);
      expect(await ids({ stack: "node", bottleneck: "startup" })).toEqual([]);
      const { cards } = await listEveryTechnique(other.context);
      const at = (id: string) => cards.findIndex((listed) => listed.id === id);
      // The detected stack's card before the any-stack ones, and a JVM card after both.
      expect(at("stk.c-node-cpu")).toBeLessThan(at("stk.b-any-io"));
      expect(at("generic.code-change")).toBeLessThan(at("stk.a-jvm-startup"));
      expect(at("stk.b-any-io")).toBeLessThan(at("stk.a-jvm-startup"));
      expect(cards.find((listed) => listed.id === "generic.code-change")?.bottlenecks).toContain(
        "startup",
      );
      const listed = cards.find((entry) => entry.id === "stk.c-node-cpu");
      expect(listed).toEqual({
        id: "stk.c-node-cpu",
        domain: "stk",
        title: "Card c-node-cpu",
        kind: "guided",
        riskClass: "lossless",
        stacks: ["node"],
        bottlenecks: ["cpu", "io"],
        expectedEffect: "faster when measured",
        enabled: false,
      });
      expect(await getTechnique(other.context, { cardId: "stk.c-node-cpu" })).toEqual({
        card: {
          id: "stk.c-node-cpu",
          domain: "stk",
          title: "Card c-node-cpu",
          kind: "guided",
          riskClass: "lossless",
          stacks: ["node"],
          bottlenecks: ["cpu", "io"],
          signals: ["evidence"],
          preconditions: [],
          steps: ["first", "second"],
          verification: [],
          traps: [],
          expectedEffect: "faster when measured",
          sources: ["https://example.com/ufo-test-fixture"],
          commandTemplates: [],
          pinnedToolVersions: {},
          verifiedIn: "unverified",
        },
        enabled: false,
      });
      await expect(getTechnique(other.context, { cardId: "stk.nope" })).rejects.toMatchObject({
        code: "usage",
        message: expect.stringContaining("stk.nope"),
      });
      // M6: a card added between pages changes the listing, so its cursor is refused.
      const page = await listTechniques(other.context, { domain: "stk", limit: 1 });
      expect(page).toMatchObject({ total: 3, nextCursor: expect.any(String) });
      const cursor = page.nextCursor ?? "";
      expect((await listTechniques(other.context, { domain: "stk", cursor })).cards).toHaveLength(
        2,
      );
      write("d-any-cpu", [], ["cpu"]);
      await expect(listTechniques(other.context, { domain: "stk", cursor })).rejects.toMatchObject({
        code: "usage",
      });
    } finally {
      await other.cleanup();
    }
  });
});

const FAKE_KEY = `sk-proj-${"Z9y8X7w6".repeat(6)}`;

// M2 B3d: these views reach an agent's model provider, so they go through the redactor too.
describe("the views behind the read-only tools", { timeout: TIMEOUT_MS }, () => {
  it("name the home as ~ and replace secrets", async () => {
    const other = makeToy({
      config: (yaml) => `${lightWorkload(`mytool --key ${FAKE_KEY}`)(yaml)}cardDirs:\n  - cards\n`,
    });
    try {
      // A card of the repository whose text carries the key.
      mkdirSync(path.join(other.repo, "cards", "secret"), { recursive: true });
      writeFileSync(
        path.join(other.repo, "cards", "secret", "leak.yaml"),
        [
          "id: secret.leak",
          "domain: secret",
          "title: A card that quotes a key",
          "kind: guided",
          "riskClass: lossless",
          "bottlenecks: [cpu]",
          "signals:",
          `  - the profile shows ${FAKE_KEY} in every request`,
          "sources:",
          "  - https://example.com/ufo-test-fixture",
          "verifiedIn: unverified",
          "",
        ].join("\n"),
      );
      // A program under the home, on the PATH the commands get.
      const bin = path.join(other.root, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "mytool"), "#!/bin/sh\n");
      chmodSync(path.join(bin, "mytool"), 0o755);
      const context = {
        ...other.context,
        workerEnv: {
          ...other.context.workerEnv,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        },
      };
      const homedir = vi.spyOn(os, "homedir").mockReturnValue(other.root);
      try {
        const inspected = await inspectTarget(context);
        expect(inspected.repoRoot).toBe("~/repo");
        expect(inspected.commands).toContainEqual({
          what: "workload setup",
          command: "mytool --key <redacted:api_key>",
        });
        const capabilities = await checkCapabilities(context);
        expect(capabilities.programs[0]).toMatchObject({
          program: "mytool",
          found: true,
          path: "~/bin/mytool",
        });
        const listed = await listTechniques(context, { domain: "secret" });
        const opened = await getTechnique(context, { cardId: "secret.leak" });
        expect(opened.card.signals).toEqual([
          "the profile shows <redacted:api_key> in every request",
        ]);
        for (const view of [inspected, capabilities, listed, opened]) {
          expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
          expect(JSON.stringify(view)).not.toContain(other.root);
        }
      } finally {
        homedir.mockRestore();
      }
    } finally {
      await other.cleanup();
    }
  });
});

describe("profiling the target", { timeout: TIMEOUT_MS }, () => {
  it("runs the workload once in arm A, times its steps, and is no technique but wall clock", async () => {
    const run = await startRun(toy.context);
    try {
      expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
      // Something wrote into arm A since its last job: the profile measures A at its commit.
      writeFileSync(path.join(run.arms.a, "server.mjs"), "// written into the arm\n", {
        flag: "a",
      });
      const queued = await profileTarget(toy.context, { runId: run.runId });
      const job = await waitDone(toy, run.runId, queued.jobId);
      expect(job.status, job.error?.message).toBe("succeeded");
      expect(git(run.arms.a, "status", "--porcelain")).toBe("");
      const profile = job.result as {
        sha: string;
        phases: { phase: string; ms: number }[];
        sample: unknown;
        artifact: string;
      };
      expect(profile.sha).toBe(run.baseSha);
      expect(profile.phases.map((p) => p.phase)).toEqual(["setup", "sample", "teardown"]);
      expect(profile.phases.every((p) => Number.isInteger(p.ms) && p.ms >= 0)).toBe(true);
      expect(profile.sample).toEqual({
        valid: true,
        values: [
          { name: "latency_ms", value: 1 },
          { name: "error_rate", value: 0 },
        ],
      });
      const artifact = path.join(toy.runDir(run.runId), profile.artifact);
      expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual(profile);
      const view = await getRun(toy.context, { runId: run.runId });
      expect(view.budget.techniquesTried).toBe(0);
      expect(view.decisions).toEqual([]);

      // Security N2: no technique, but only within the run's wall-clock budget (30 min here).
      const started = (await readRun(toy.runDir(run.runId))).createdAt;
      await updateRun(toy.runDir(run.runId), (record) => ({
        ...record,
        createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }));
      await expect(profileTarget(toy.context, { runId: run.runId })).rejects.toMatchObject({
        violation: { rule: "budget_exceeded", detail: "31 of 30 minutes used" },
      });
      // Security S2-4: and one queued before the clock ran out (the queue looks the same) is
      // refused when it starts.
      const runDir = toy.runDir(run.runId);
      const late = await enqueueJob(runDir, { kind: JOB_KINDS.profile, input: {} });
      await ensureWorker(toy.context, runDir, toy.home, await readAppState(runDir));
      expect(await waitDone(toy, run.runId, late.jobId)).toMatchObject({
        status: "failed",
        error: { message: "policy:budget_exceeded: 31 of 30 minutes used" },
      });
      await updateRun(toy.runDir(run.runId), (record) => ({ ...record, createdAt: started }));

      await finishRun(toy.context, { runId: run.runId });
      await expect(profileTarget(toy.context, { runId: run.runId })).rejects.toMatchObject({
        code: "run_finishing",
      });
    } finally {
      await cancelRun(toy.context, { runId: run.runId }).catch(() => undefined);
    }
  });
});

describe("a get_job wait", { timeout: TIMEOUT_MS }, () => {
  it("ends at once with interrupted when its signal aborts", async () => {
    // The baseline's setup sleeps, so the job stays running with its worker alive.
    const slow = makeToy({ config: lightWorkload("sleep 30") });
    try {
      await approveToy(slow);
      const run = await startRun(slow.context);
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 300);
      await expect(
        getJob(slow.context, {
          runId: run.runId,
          jobId: run.baselineJobId,
          waitS: 25,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "interrupted", message: "the wait was cancelled" });
      expect(Date.now() - started).toBeLessThan(5000);
      await cancelRun(slow.context, { runId: run.runId });
    } finally {
      await slow.cleanup();
    }
  });
});
