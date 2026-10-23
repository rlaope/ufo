import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_CONFIG, DRAFT_WORKLOAD_COMMAND } from "../../../src/app/config.js";
import { type DoctorReport, doctor, EXIT_GAPS } from "../../../src/app/doctor.js";
import { NO_JFR } from "../../../src/app/profiler.js";
import { EXIT_OK, main } from "../../../src/cli/main.js";

// M7 L2: `ufo doctor` reports only what the repository's stacks, ufo.yaml (or the draft), and
// workload.profile need, each gap with its reason and an install hint; fake tools stand in on a
// PATH of their own, so nothing real is required or run.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Box {
  readonly repo: string;
  readonly bin: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A git repository holding `files`, an empty bin directory as the whole PATH, and a UFO home. */
function box(files: Record<string, string>): Box {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-doctor-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), text);
  }
  execFileSync("git", ["init", "--quiet", repo]);
  const made = {
    repo,
    bin,
    home: path.join(root, "ufo-home"),
    env: { PATH: bin, HOME: os.homedir() },
  };
  // doctor's git probe finds git on this PATH too.
  fake(made, "git", "echo git version 2.50.1");
  return made;
}

/** A fake program on the box's PATH that runs `script` (by default, exits 0). */
function fake(b: Box, name: string, script = "exit 0"): string {
  const file = path.join(b.bin, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A valid ufo.yaml: the empty draft with `command` replaced and `workload` lines added. */
function config(command: string, workload = ""): string {
  const text = DRAFT_CONFIG.replace(
    `  command: "${DRAFT_WORKLOAD_COMMAND}"\n`,
    `  command: ${JSON.stringify(command)}\n${workload}`,
  );
  expect(text).not.toBe(DRAFT_CONFIG);
  return text;
}

function check(b: Box, probeTimeoutMs?: number): Promise<DoctorReport> {
  return doctor(
    { cwd: b.repo, home: b.home },
    { env: { ...b.env }, ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }) },
  );
}

const gap = (report: DoctorReport, tool: string) => report.gaps.find((g) => g.tool === tool);
const found = (report: DoctorReport, tool: string) =>
  report.found.filter((f) => f.tool === tool && !f.neededBy[0]?.startsWith("UFO itself"));

describe("ufo doctor", () => {
  it("reports a Node repository's missing node for its stack and the draft's node-cpu preset", async () => {
    const b = box({ "package.json": '{"name":"app"}' });
    const report = await check(b);
    expect(report).toMatchObject({ repoRoot: b.repo, stacks: ["node"], source: "draft" });
    expect(gap(report, "node")).toEqual({
      tool: "node",
      neededBy: ["stack node (package.json)", "workload.profile preset node-cpu"],
      problem: "node is not on the PATH UFO's commands get",
      hint: expect.stringContaining("https://nodejs.org"),
    });
    // UFO's own checks pass: git, the Node.js running UFO, UFO_HOME.
    expect(report.gaps.map((g) => g.tool)).toEqual(["node"]);
    expect(report.found.map((f) => f.tool)).toEqual(["git", "node", "UFO_HOME"]);
    fake(b, "node");
    const fixed = await check(b);
    expect(fixed.gaps).toEqual([]);
    expect(found(fixed, "node")).toEqual([
      {
        tool: "node",
        neededBy: ["stack node (package.json)", "workload.profile preset node-cpu"],
        path: path.join(b.bin, "node"),
      },
    ]);
  });

  it("reports a Maven repository's java, mvn, and the jvm-jfr preset's jfr, found as findJfr finds it", async () => {
    const b = box({ "pom.xml": "<project/>" });
    let report = await check(b);
    expect(report).toMatchObject({ stacks: ["jvm", "maven"], source: "draft" });
    expect(report.gaps.map((g) => g.tool)).toEqual(["java", "mvn", "jfr"]);
    expect(gap(report, "java")).toMatchObject({
      neededBy: ["stack jvm (pom.xml)", "workload.profile preset jvm-jfr"],
      hint: expect.stringContaining("https://adoptium.net"),
    });
    expect(gap(report, "mvn")?.hint).toContain("https://maven.apache.org/install.html");
    expect(gap(report, "jfr")).toMatchObject({
      problem: NO_JFR,
      hint: expect.stringContaining("https://docs.oracle.com/"),
    });
    // java -version prints on stderr.
    fake(b, "java", `echo 'openjdk version "21.0.4" 2024-07-16' >&2`);
    fake(b, "mvn");
    report = await check(b);
    expect(report.gaps.map((g) => g.tool)).toEqual(["jfr"]);
    expect(found(report, "java")[0]?.version).toBe('openjdk version "21.0.4" 2024-07-16');
    fake(b, "jfr");
    report = await check(b);
    expect(report.gaps).toEqual([]);
    expect(found(report, "jfr")[0]?.path).toBe(path.join(b.bin, "jfr"));
  });

  it("needs no mvn or gradle beside a wrapper, only java", async () => {
    const b = box({ "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" });
    fake(b, "java");
    fake(b, "jfr");
    expect((await check(b)).gaps).toEqual([]);
  });

  it("checks what a ufo.yaml's commands start and its profile needs: go for pprof, py-spy", async () => {
    const b = box({
      "go.mod": "module example.com/app\n",
      "ufo.yaml": config(
        "./bench.sh",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion in ufo.yaml.
        '  start: ${UFO_PROFILE_DIR:+py-spy record -f raw -o "$UFO_PROFILE_DIR/py.txt" -s --} hey -z 5s\n  profile:\n    format: pprof\n',
      ),
    });
    const report = await check(b);
    expect(report).toMatchObject({ stacks: ["go"], source: "ufo.yaml" });
    expect(report.gaps.map((g) => g.tool)).toEqual(["go", "./bench.sh", "py-spy"]);
    expect(gap(report, "go")).toMatchObject({
      neededBy: ["stack go (go.mod)", "workload.profile format pprof"],
      hint: expect.stringContaining("https://go.dev/doc/install"),
    });
    expect(gap(report, "./bench.sh")).toMatchObject({
      neededBy: ["workload command"],
      problem: "./bench.sh is not in the repository",
    });
    expect(gap(report, "py-spy")).toMatchObject({
      neededBy: ["a workload step starts py-spy"],
      hint: expect.stringContaining("https://github.com/benfred/py-spy"),
    });
    fake(b, "go");
    fake(b, "py-spy", "echo py-spy 0.4.0");
    writeFileSync(path.join(b.repo, "bench.sh"), "#!/bin/sh\n");
    const fixed = await check(b);
    expect(fixed.gaps).toEqual([]);
    expect(found(fixed, "py-spy")[0]?.version).toBe("py-spy 0.4.0");
  });

  it("checks python3, else python, for a Python repository, and asks the one found its version", async () => {
    const b = box({ "requirements.txt": "flask\n" });
    expect(gap(await check(b), "python3 or python")?.hint).toContain("https://www.python.org/");
    fake(b, "python", "echo Python 3.12.1");
    const report = await check(b);
    expect(report.gaps).toEqual([]);
    expect(found(report, "python")[0]).toMatchObject({
      neededBy: ["stack python (requirements.txt)"],
      version: "Python 3.12.1",
    });
  });

  it("checks that package.json declares the bundle analyzer the workload names", async () => {
    const manifest = (deps: string) => `{"name":"app","dependencies":{"next":"15.0.0"${deps}}}`;
    const b = box({
      "package.json": manifest(""),
      "ufo.yaml": config(
        "node bench.mjs",
        `  setup: npm ci && npx --no next build && { [ -z "$UFO_PROFILE_DIR" ] || npx --no source-map-explorer 'x/*.js' --json "$UFO_PROFILE_DIR/c.json"; }\n  profile:\n    format: bundle-stats\n`,
      ),
    });
    fake(b, "node");
    fake(b, "npm");
    const report = await check(b);
    expect(report.gaps).toEqual([
      {
        tool: "source-map-explorer",
        neededBy: [
          "workload.profile format bundle-stats (a workload step runs source-map-explorer)",
        ],
        problem:
          "source-map-explorer is not a dependency in package.json, so an arm does not install it",
        hint: expect.stringContaining("npm install --save-dev source-map-explorer"),
      },
    ]);
    writeFileSync(path.join(b.repo, "package.json"), manifest(',"source-map-explorer":"2.5.3"'));
    expect((await check(b)).gaps).toEqual([]);
  });

  it("checks an async-profiler library -agentpath names in workload.profile env", async () => {
    const b = box({
      "ufo.yaml": config(
        "./bench.sh",
        '  start: ./server.sh\n  profile:\n    env:\n      JAVA_TOOL_OPTIONS: "-agentpath:/nowhere/libasyncProfiler.dylib=start,event=cpu,collapsed,file={{profile_dir}}/p.collapsed"\n    format: collapsed\n',
      ),
      "bench.sh": "",
      "server.sh": "",
    });
    const report = await check(b);
    expect(report.gaps).toEqual([
      {
        tool: "async-profiler",
        neededBy: ["workload.profile env (-agentpath)"],
        problem: "/nowhere/libasyncProfiler.dylib does not exist",
        hint: expect.stringContaining("https://github.com/async-profiler/async-profiler"),
      },
    ]);
  });

  it("reports an invalid ufo.yaml as a gap and checks the draft's tools instead", async () => {
    const b = box({ "package.json": "{}", "ufo.yaml": "version: 1\nobjective: [\n" });
    fake(b, "node");
    const report = await check(b);
    expect(report.source).toBe("draft");
    expect(report.gaps).toEqual([
      {
        tool: "ufo.yaml",
        neededBy: ["ufo approve and every run"],
        problem: expect.stringMatching(/^config_invalid: ufo\.yaml is not valid YAML/),
        hint: expect.stringContaining("ufo approve"),
      },
    ]);
    expect(found(report, "node")[0]?.neededBy).toContain("workload.profile preset node-cpu");
  });

  it("reports a probe that hangs as a gap once its timeout kills it", async () => {
    const b = box({ "pom.xml": "<project/>", mvnw: "" });
    fake(b, "java", "exec /bin/sleep 30");
    fake(b, "jfr");
    const started = Date.now();
    const report = await check(b, 300);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(report.gaps).toEqual([
      {
        tool: "java",
        neededBy: ["stack jvm (pom.xml)", "workload.profile preset jvm-jfr"],
        problem: `${path.join(b.bin, "java")} did not answer java -version within 0.3 s`,
        hint: expect.stringContaining("https://adoptium.net"),
      },
    ]);
  });

  // Security review M7: a version manager's shim on PATH (pyenv, asdf, mise) picks its binary from
  // the directory it runs in and its parents, and the launcher's JAVA_TOOL_OPTIONS or PYTHON*
  // would reach the probed program; a probe gets neither.
  it("probes outside the repository with only PATH, HOME, and LANG", async () => {
    const b = box({ "requirements.txt": "flask\n", ".python-version": "3.99.0\n" });
    const record = path.join(path.dirname(b.repo), "probe.txt");
    fake(b, "python3", `{ pwd; /usr/bin/env; } > '${record}'; echo Python 3.12.1`);
    const env = {
      ...b.env,
      LANG: "en_US.UTF-8",
      JAVA_TOOL_OPTIONS: "-javaagent:/x.jar",
      PYTHONPATH: "/elsewhere",
      PYENV_VERSION: "3.99.0",
    };
    const report = await doctor({ cwd: b.repo, home: b.home }, { env });
    expect(found(report, "python3")[0]?.version).toBe("Python 3.12.1");
    const [cwd = "", ...lines] = readFileSync(record, "utf8").trim().split("\n");
    expect(cwd.startsWith(b.repo)).toBe(false);
    expect(path.basename(cwd)).toMatch(/^ufo-doctor-/);
    // The shell adds its own PWD, SHLVL, and _.
    const names = lines
      .map((line) => line.split("=")[0])
      .filter((name) => !/^(PWD|OLDPWD|SHLVL|_)$/.test(name ?? ""));
    expect(names.sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(lines).toContain(`PATH=${b.bin}`);
    // The probe's directory is removed afterwards.
    expect(existsSync(cwd)).toBe(false);
  });

  it("reports a program that fails its probe with the first line it printed", async () => {
    const b = box({ "pom.xml": "<project/>", mvnw: "" });
    // As macOS's /usr/bin/java stub does without a JDK.
    fake(b, "java", "echo 'Unable to locate a Java Runtime.' >&2; exit 1");
    fake(b, "jfr");
    expect(gap(await check(b), "java")?.problem).toBe(
      `${path.join(b.bin, "java")} is on PATH, but java -version failed: Unable to locate a Java Runtime.`,
    );
  });

  it("reports a directory outside any repository as a gap, with UFO's own checks", async () => {
    const b = box({});
    const outside = path.dirname(b.repo);
    const report = await doctor({ cwd: outside, home: b.home }, { env: b.env });
    expect(report).toMatchObject({ source: "none", stacks: [] });
    expect(report.repoRoot).toBeUndefined();
    expect(report.gaps.map((g) => g.tool)).toEqual(["repository"]);
    expect(report.found.map((f) => f.tool)).toEqual(["git", "node", "UFO_HOME"]);
  });

  it("reports a UFO_HOME it cannot trust", async () => {
    const b = box({});
    mkdirSync(b.home, { mode: 0o777 });
    chmodSync(b.home, 0o777);
    const report = await check(b);
    expect(gap(report, "UFO_HOME")).toMatchObject({
      problem: expect.stringContaining("writable by group or others"),
      hint: expect.stringContaining("chmod 700"),
    });
  });
});

describe("the ufo doctor command", () => {
  async function run(argv: string[], b: Box) {
    let stdout = "";
    let stderr = "";
    const code = await main(argv, {
      cwd: b.repo,
      env: { ...b.env, UFO_HOME: b.home },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }

  it("exits 0 with no gap and prints one JSON object with --json", async () => {
    const b = box({ "package.json": "{}" });
    fake(b, "node");
    const result = await run(["doctor", "--json"], b);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(["ok", "command", "result"]);
    expect(parsed).toMatchObject({ ok: true, command: "doctor" });
    expect(Object.keys(parsed.result).sort()).toEqual([
      "found",
      "gaps",
      "repoRoot",
      "source",
      "stacks",
    ]);
    expect(parsed.result).toMatchObject({ stacks: ["node"], source: "draft", gaps: [] });
    for (const entry of parsed.result.found) {
      expect(Object.keys(entry)).toEqual(expect.arrayContaining(["tool", "neededBy"]));
    }
    const text = await run(["doctor"], b);
    expect(text.code).toBe(EXIT_OK);
    expect(text.stdout).toMatch(/ {2}ok {3}node \(.*\/bin\/node\): stack node \(package\.json\)/);
    expect(text.stdout).toMatch(/No gaps\.\n$/);
  });

  it(`exits ${EXIT_GAPS} with gaps, each with what is missing, why, and how to get it`, async () => {
    const b = box({ "go.mod": "module x\n" });
    const json = await run(["doctor", "--json"], b);
    expect(json.code).toBe(EXIT_GAPS);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.gaps).toEqual([
      {
        tool: "go",
        neededBy: ["stack go (go.mod)"],
        problem: "go is not on the PATH UFO's commands get",
        hint: expect.stringContaining("https://go.dev/doc/install"),
      },
    ]);
    const text = await run(["doctor"], b);
    expect(text.code).toBe(EXIT_GAPS);
    expect(text.stdout).toContain("  gap  go: go is not on the PATH UFO's commands get\n");
    expect(text.stdout).toContain("         needed by: stack go (go.mod)\n");
    expect(text.stdout).toContain("         fix: install Go (https://go.dev/doc/install)\n");
    expect(text.stdout).toMatch(/1 gap\.\n$/);
  });

  it("refuses arguments it does not take", async () => {
    const b = box({});
    expect((await run(["doctor", "--host", "codex"], b)).code).toBe(2);
  });
});
