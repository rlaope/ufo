import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelRun,
  inspectTarget,
  type ProfileResult,
  profileTarget,
  startRun,
} from "../../src/app/index.js";
import { NODE_EXIT_ON_SIGNAL } from "../../src/app/profiler.js";
import type { FileHotspots } from "../../src/core/profile/index.js";
import { approveToy, git, makeToy, TIMEOUT_MS, type Toy, waitDone } from "./helpers.js";

// M4 E1–E3: profile_target under workload.profile. The profile's variables reach only the
// profiled steps of a profile job, never a baseline sample; the job's directory is outside both
// arms; what the profiler wrote there comes back as hot spots, the heaviest files first.

/**
 * Every workload step: records the variables it got, and when it is profiled writes what a
 * profiler would, five folded files of different weights and one broken one.
 */
const STEP = `import { appendFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const step = process.argv[2];
const env = process.env;
appendFileSync(
  path.join(env.TOY_LOG_DIR, "steps.jsonl"),
  \`\${JSON.stringify({
    step,
    phase: env.UFO_PHASE,
    profiled: env.TOY_PROFILED ?? null,
    out: env.TOY_PROFILE_OUT ?? null,
    dir: env.UFO_PROFILE_DIR ?? null,
  })}\\n\`,
);
if (env.TOY_PROFILED !== undefined) {
  const dir = path.dirname(env.TOY_PROFILE_OUT);
  for (const weight of [10, 50, 20, 40, 30]) {
    writeFileSync(
      path.join(dir, \`toy-\${weight}.collapsed\`),
      \`main;handle;work\${weight} (\${process.cwd()}/server.mjs:12) \${weight}\\n\`,
    );
  }
  writeFileSync(path.join(dir, "toy-broken.collapsed"), "main;handle\\n");
  // A workload that swaps its profile directory for a link to somewhere else.
  if (env.TOY_REPLACE_DIR !== undefined) {
    rmSync(env.UFO_PROFILE_DIR, { recursive: true });
    symlinkSync(env.TOY_LOG_DIR, env.UFO_PROFILE_DIR);
  }
}
const ready = path.join(env.TOY_LOG_DIR, \`ready-\${env.UFO_PHASE}-\${env.UFO_ARM}-\${env.UFO_PORT}\`);
if (step === "start") {
  writeFileSync(ready, "");
  setInterval(() => undefined, 1000);
} else if (step === "healthcheck") {
  process.exit(existsSync(ready) ? 0 : 1);
} else if (step === "command") {
  console.log(JSON.stringify({ latency_ms: 1, error_rate: 0 }));
}
`;

interface StepRecord {
  step: string;
  phase: string;
  profiled: string | null;
  out: string | null;
  dir: string | null;
}

/** The toy with `workload` (each line indented under it) and `files` committed. */
function profileToy(
  workload: string[],
  files: Record<string, string> = { "step.mjs": STEP },
  env: Record<string, string> = {},
): { toy: Toy; logDir: string } {
  const logDir = mkdtempSync(path.join(tmpdir(), "ufo-it-steps-"));
  const listed = ["TOY_LOG_DIR", ...Object.keys(env)].map((name) => `  - ${name}\n`).join("");
  const toy = makeToy({
    env: { TOY_LOG_DIR: logDir, ...env },
    config: (yaml) => {
      const start = yaml.indexOf("workload:\n");
      const end = yaml.indexOf("cards:\n");
      const lines = ["workload:", ...workload.map((line) => `  ${line}`), "oracles: []", ""];
      return `${yaml.slice(0, start)}${lines.join("\n")}${yaml.slice(end)}env:\n${listed}`;
    },
  });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(toy.repo, name), text);
  git(toy.repo, "add", "--all");
  git(toy.repo, "commit", "--quiet", "--message", "profiled scripts");
  return { toy, logDir };
}

function records(logDir: string): StepRecord[] {
  return readFileSync(path.join(logDir, "steps.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StepRecord);
}

const PROFILE_ENV = [
  "profile:",
  "  env:",
  '    TOY_PROFILED: "yes"',
  '    TOY_PROFILE_OUT: "{{profile_dir}}/toy-%p.collapsed"',
  "  format: collapsed",
];

function inside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Starts a run, waits for its baseline, profiles once, and returns the profile and its run. */
async function profileOnce(toy: Toy, beforeProfile: (runDir: string) => void = () => undefined) {
  const run = await startRun(toy.context);
  expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
  beforeProfile(toy.runDir(run.runId));
  const queued = await profileTarget(toy.context, { runId: run.runId });
  const job = await waitDone(toy, run.runId, queued.jobId);
  expect(job.status, job.error?.message).toBe("succeeded");
  return { run, jobId: queued.jobId, profile: job.result as unknown as ProfileResult };
}

describe("profiling a server under workload.profile", { timeout: TIMEOUT_MS }, () => {
  let toy: Toy;
  let logDir: string;

  beforeAll(async () => {
    ({ toy, logDir } = profileToy([
      "setup: node step.mjs setup",
      "start: node step.mjs start",
      "healthcheck: node step.mjs healthcheck",
      "command: node step.mjs command",
      ...PROFILE_ENV,
    ]));
  });

  afterAll(async () => {
    await toy.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  });

  it("shows every variable at approval, JSON-quoted", async () => {
    const printed: string[] = [];
    await approveToy(toy, { print: (text) => printed.push(text) });
    const text = printed.join("");
    expect(text).toContain(
      [
        "Profiling, for profile_target only (baselines, samples, oracles, and the final check run without it):",
        "  every step of a profile job gets UFO_PROFILE_DIR, a new directory in the run state; UFO reads the collapsed files written there",
        "  profiled steps: start; they also get these variables, {{profile_dir}} replaced with that directory",
        '  profile env TOY_PROFILED: "yes"',
        '  profile env TOY_PROFILE_OUT: "{{profile_dir}}/toy-%p.collapsed"',
      ].join("\n"),
    );
  });

  it("gives the variables to start alone, the directory to every step, and nothing to the baseline", async () => {
    const { run, jobId, profile } = await profileOnce(toy);
    try {
      const dir = path.join(toy.runDir(run.runId), "artifacts", `profile-${jobId}`);
      const seen = records(logDir);
      const baseline = seen.filter((r) => r.phase === "baseline");
      expect(new Set(baseline.map((r) => r.step))).toEqual(
        new Set(["setup", "start", "healthcheck", "command"]),
      );
      for (const record of baseline) {
        expect(record).toMatchObject({ profiled: null, out: null, dir: null });
      }
      const profiled = seen.filter((r) => r.phase === "profile");
      expect(new Set(profiled.map((r) => r.step))).toEqual(
        new Set(["setup", "start", "healthcheck", "command"]),
      );
      for (const record of profiled) {
        expect(record.dir).toBe(dir);
        expect(record.profiled).toBe(record.step === "start" ? "yes" : null);
        expect(record.out).toBe(record.step === "start" ? `${dir}/toy-%p.collapsed` : null);
      }
      // The profiler wrote into the run state, outside both arms, and neither arm changed.
      expect(inside(dir, toy.runDir(run.runId))).toBe(true);
      expect(inside(dir, run.arms.a) || inside(dir, run.arms.b)).toBe(false);
      expect(readdirSync(dir)).toHaveLength(6);
      expect(git(run.arms.a, "status", "--porcelain")).toBe("");

      expect(profile.hotspots).toEqual({
        format: "collapsed",
        dir: path.join("artifacts", `profile-${jobId}`),
        files: [50, 40, 30, 20].map((weight) => ({
          file: `toy-${weight}.collapsed`,
          valid: true,
          unit: "samples",
          weight,
          // Paths in arm A are named relative to the repository.
          self: [{ frame: `work${weight} (server.mjs:12)`, pct: 100 }],
          total: [
            { frame: "handle", pct: 100 },
            { frame: "main", pct: 100 },
            { frame: `work${weight} (server.mjs:12)`, pct: 100 },
          ],
          stacks: [{ frames: ["main", "handle", `work${weight} (server.mjs:12)`], pct: 100 }],
        })),
        omitted: 2,
      });
      const artifact = path.join(toy.runDir(run.runId), profile.artifact);
      expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual(profile);
    } finally {
      await cancelRun(toy.context, { runId: run.runId }).catch(() => undefined);
    }
  });
});

describe("profiling a command under workload.profile", { timeout: TIMEOUT_MS }, () => {
  it("profiles the measured command when there is no start, and only in the profile job", async () => {
    const { toy, logDir } = profileToy([
      "setup: node step.mjs setup",
      "command: node step.mjs command",
      ...PROFILE_ENV,
    ]);
    try {
      await approveToy(toy);
      // What an interrupted attempt of the same job left: the job starts with an empty directory.
      const { run, jobId, profile } = await profileOnce(toy, (runDir) => {
        const stale = path.join(runDir, "artifacts", "profile-job-000002");
        mkdirSync(stale);
        writeFileSync(path.join(stale, "stale.collapsed"), "main;stale 1000\n");
      });
      expect(jobId).toBe("job-000002");
      const dir = path.join(toy.runDir(run.runId), "artifacts", `profile-${jobId}`);
      expect(readdirSync(dir)).not.toContain("stale.collapsed");
      const seen = records(logDir);
      expect(seen.some((r) => r.phase === "baseline" && r.step === "command")).toBe(true);
      expect(seen.filter((r) => r.profiled !== null || r.dir !== null)).toEqual([
        { step: "setup", phase: "profile", profiled: null, out: null, dir },
        { step: "command", phase: "profile", profiled: "yes", out: `${dir}/toy-%p.collapsed`, dir },
      ]);
      expect(profile.sample).toMatchObject({ valid: true });
      expect(profile.hotspots?.files.map((f) => f.file)).toEqual([
        "toy-50.collapsed",
        "toy-40.collapsed",
        "toy-30.collapsed",
        "toy-20.collapsed",
      ]);
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("keeps the phases and sample when the workload replaced its profile directory", async () => {
    const { toy, logDir } = profileToy([
      "command: node step.mjs command",
      ...PROFILE_ENV.slice(0, 2),
      '    TOY_REPLACE_DIR: "yes"',
      ...PROFILE_ENV.slice(2),
    ]);
    try {
      await approveToy(toy);
      const { run, profile } = await profileOnce(toy);
      expect(profile.sample).toMatchObject({ valid: true });
      expect(profile.phases.map((p) => p.phase)).toEqual(["sample", "teardown"]);
      expect(profile.hotspots).toMatchObject({ format: "collapsed", files: [], omitted: 0 });
      expect(profile.hotspots?.reason).toBe(
        "the workload replaced the profile directory; UFO does not follow it",
      );
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("leaves hot spots out without a profile block", async () => {
    const { toy, logDir } = profileToy(["command: node step.mjs command"]);
    try {
      await approveToy(toy);
      const { run, profile } = await profileOnce(toy);
      expect(profile).not.toHaveProperty("hotspots");
      expect(records(logDir).every((r) => r.dir === null && r.profiled === null)).toBe(true);
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("a profile block ufo.yaml cannot have", { timeout: TIMEOUT_MS }, () => {
  it.each([
    ["PATH", "PATH: /tmp/bin", "PATH and HOME stay the run's own"],
    ["HOME", "HOME: /tmp", "PATH and HOME stay the run's own"],
    ["a UFO_ name", "UFO_PROFILE_DIR: /tmp", "UFO_ names are reserved"],
    [
      "a lowercase name",
      "node_options: --cpu-prof",
      "must be an uppercase environment variable name",
    ],
    ["a secret-like name", "OPENAI_API_KEY: sk-x", "OPENAI_API_KEY looks like a secret"],
    [
      "another placeholder",
      'NODE_OPTIONS: "--cpu-prof-dir={{run_dir}}"',
      "is the only placeholder",
    ],
    ["a control character", 'NODE_OPTIONS: "--cpu-prof\\u0007"', "control characters"],
  ])("refuses %s in its env", async (_label, entry, message) => {
    const { toy, logDir } = profileToy([
      "command: node step.mjs command",
      "profile:",
      "  env:",
      `    ${entry}`,
      "  format: cpuprofile",
    ]);
    try {
      const view = await inspectTarget(toy.context);
      expect(view.config).toMatchObject({ present: true, valid: false });
      expect((view.config as { error: string }).error).toContain(message);
      await expect(approveToy(toy)).rejects.toMatchObject({ code: "config_invalid" });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

// M4 E4: the node-cpu preset with the real node binary. A server spends 40 ms of CPU in burn()
// per /work request; the measured command makes three.
const SERVER = `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

function burn(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

const server = createServer((req, res) => {
  if (req.url === "/work") burn(40);
  res.end("ok");
});
writeFileSync(
  path.join(process.env.TOY_LOG_DIR, \`node-options-\${process.env.UFO_PHASE}\`),
  process.env.NODE_OPTIONS ?? "",
);
if (process.argv.includes("--own-handler")) {
  process.on("SIGTERM", () => {
    writeFileSync(path.join(process.env.TOY_LOG_DIR, \`handled-\${process.env.UFO_PHASE}\`), "");
    process.exit(0);
  });
}
server.listen(Number(process.env.UFO_PORT), "127.0.0.1");
`;

const CLIENT = `const base = \`http://127.0.0.1:\${process.env.UFO_PORT}\`;
if (process.argv[2] === "health") {
  const ok = await fetch(\`\${base}/health\`).then((r) => r.ok, () => false);
  process.exit(ok ? 0 : 1);
}
const started = performance.now();
for (let i = 0; i < 3; i++) await (await fetch(\`\${base}/work\`)).text();
console.log(JSON.stringify({ latency_ms: (performance.now() - started) / 3, error_rate: 0 }));
`;

/** A wrapper as npm is one: it forwards SIGTERM to the app and exits when the app has. */
const LAUNCHER = `import { spawn } from "node:child_process";

const app = spawn(process.execPath, ["srv.mjs"], { stdio: "inherit" });
process.on("SIGTERM", () => app.kill("SIGTERM"));
app.on("exit", (code) => process.exit(code ?? 1));
`;

const NODE_FILES = { "srv.mjs": SERVER, "client.mjs": CLIENT, "launcher.mjs": LAUNCHER };

function nodeWorkload(start: string): string[] {
  return [
    `start: ${start}`,
    "healthcheck: node client.mjs health",
    "command: node client.mjs measure",
    "profile:",
    "  preset: node-cpu",
  ];
}

function hotFrames(file: FileHotspots | undefined): string[] {
  if (file === undefined) throw new Error("no such file");
  if (!file.valid) throw new Error(file.reason);
  return file.self.map((s) => s.frame);
}

describe("the node-cpu preset", { timeout: TIMEOUT_MS }, () => {
  it("profiles a server with no SIGTERM handler, through a wrapper, the app's file first", async () => {
    const { toy, logDir } = profileToy(nodeWorkload("node launcher.mjs"), NODE_FILES);
    try {
      const printed: string[] = [];
      await approveToy(toy, { print: (text) => printed.push(text) });
      const options = `--cpu-prof --cpu-prof-dir="{{profile_dir}}" --require "${NODE_EXIT_ON_SIGNAL}"`;
      expect(printed.join("")).toContain(
        [
          "  profiled steps: start; they also get these variables, {{profile_dir}} replaced with that directory",
          "  preset node-cpu: node --cpu-prof, with UFO's preload so a process stopped by SIGTERM or SIGINT still writes its profile",
          `  profile env NODE_OPTIONS: ${JSON.stringify(options)}`,
        ].join("\n"),
      );
      const { run, profile } = await profileOnce(toy);
      const hotspots = profile.hotspots;
      expect(hotspots).toMatchObject({ format: "cpuprofile", omitted: 0 });
      // The wrapper and the app each wrote one; the app, which did the work, comes first.
      expect(hotspots?.files).toHaveLength(2);
      const [app, wrapper] = hotspots?.files ?? [];
      expect(hotFrames(app)).toContainEqual(expect.stringMatching(/^burn \(srv\.mjs:\d+\)$/));
      expect(hotFrames(wrapper).some((frame) => frame.startsWith("burn "))).toBe(false);
      expect(git(run.arms.a, "status", "--porcelain")).toBe("");
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("leaves a server's own SIGTERM handler to run, and adds to the NODE_OPTIONS env: passes", async () => {
    const { toy, logDir } = profileToy(nodeWorkload("node srv.mjs --own-handler"), NODE_FILES, {
      NODE_OPTIONS: "--no-deprecation",
    });
    try {
      const printed: string[] = [];
      await approveToy(toy, { print: (text) => printed.push(text) });
      expect(printed.join("")).toContain("; NODE_OPTIONS goes after the value env: passes");
      const { run, jobId, profile } = await profileOnce(toy);
      expect(readdirSync(logDir)).toContain("handled-profile");
      const dir = path.join(toy.runDir(run.runId), "artifacts", `profile-${jobId}`);
      const read = (phase: string) =>
        readFileSync(path.join(logDir, `node-options-${phase}`), "utf8");
      expect(read("baseline")).toBe("--no-deprecation");
      expect(read("profile")).toBe(
        `--no-deprecation --cpu-prof --cpu-prof-dir="${dir}" --require "${NODE_EXIT_ON_SIGNAL}"`,
      );
      expect(profile.hotspots?.files).toHaveLength(1);
      expect(hotFrames(profile.hotspots?.files[0])).toContainEqual(
        expect.stringMatching(/^burn \(srv\.mjs:\d+\)$/),
      );
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
