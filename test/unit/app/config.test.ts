import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DRAFT_CONFIG,
  draftConfigFor,
  GO_PROFILE_FETCH,
  GO_PROFILED_TEST,
  isDraftConfig,
  PYTHON_PROFILED_START,
  parseConfigText,
} from "../../../src/app/config.js";
import type { DetectedStack } from "../../../src/app/detect.js";

const TOY_CONFIG = readFileSync(
  new URL("../../fixtures/toy-http/repo/ufo.yaml", import.meta.url),
  "utf8",
);

describe("parseConfigText", () => {
  it("accepts the toy's ufo.yaml", () => {
    expect(parseConfigText(TOY_CONFIG).objective.primary.name).toBe("latency_ms");
  });

  it("refuses a test_pass_set guardrail without a test_pass_set oracle", () => {
    const text = TOY_CONFIG.replace(
      "    - kind: error_rate\n",
      "    - kind: error_rate\n    - kind: test_pass_set\n",
    ).replace(/^oracles:\n(?:.*\n)*?(?=^cards:)/m, "oracles: []\n");
    expect(() => parseConfigText(text)).toThrow(
      expect.objectContaining({
        code: "config_invalid",
        message: expect.stringContaining("guardrail test_pass_set needs an oracle"),
      }),
    );
  });

  it("accepts a test_pass_set guardrail next to its oracle", () => {
    const text = TOY_CONFIG.replace(
      "    - kind: error_rate\n",
      "    - kind: error_rate\n    - kind: test_pass_set\n",
    );
    expect(parseConfigText(text).objective.guardrails.map((g) => g.kind)).toContain(
      "test_pass_set",
    );
  });
});

const NODE: DetectedStack = {
  id: "node",
  evidence: ["package.json"],
  suggestions: { testCommand: "npm test", workloadHint: "latency: p95 of one request path" },
};
const GRADLE: DetectedStack = {
  id: "gradle",
  evidence: ["build.gradle"],
  suggestions: { workloadHint: "build: wall time of a clean build" },
};

describe("draftConfigFor", () => {
  it("is the plain draft when nothing is detected, and the draft parses", () => {
    expect(draftConfigFor([])).toBe(DRAFT_CONFIG);
    expect(parseConfigText(DRAFT_CONFIG).cards).toEqual(["generic.code-change"]);
  });

  it("builds a valid draft from the detected stacks with the one field to fill in marked", () => {
    const draft = draftConfigFor([GRADLE, NODE]);
    const config = parseConfigText(draft);
    expect(config.cards).toEqual(["generic.code-change"]);
    expect(config.workload.command).toMatch(/replace this with your benchmark command/);
    expect(draft).toContain("# Detected gradle: build: wall time of a clean build");
    expect(draft).toContain("# Detected node: latency: p95 of one request path");
    expect(draft).toContain("# FILL IN:");
    expect(draft).toContain("# Detected: gradle, node.");
  });

  it("offers the test command as a commented-out oracle, naming the line it must print", () => {
    const draft = draftConfigFor([NODE]);
    expect(draft).toContain("#    command: npm test");
    expect(draft).toContain("ufoTestResults");
    expect(parseConfigText(draft).oracles).toEqual([]);
    // Uncommented, the oracle is valid config.
    const live = draft
      .replace("oracles: []\n#  - name:", "oracles:\n  - name:")
      .replace(/\n# {4}(kind|command):/g, "\n    $1:");
    expect(parseConfigText(live).oracles).toEqual([
      { name: "unit-tests", kind: "test_pass_set", command: "npm test" },
    ]);
  });

  it("keeps the generic oracle example when no test command is known", () => {
    expect(draftConfigFor([GRADLE])).toContain("#    command: ./scripts/smoke.sh");
  });
});

// M4 E4: the draft's profile block for profile_target.
describe("the draft's profile block", () => {
  const stack = (id: DetectedStack["id"]): DetectedStack => ({
    id,
    evidence: ["x"],
    suggestions: {},
  });

  /** The draft with the commented lines from `marker` on, up to the next note, uncommented. */
  function uncommented(draft: string, marker: string): string {
    const lines = draft.split("\n");
    const from = lines.findIndex((line) => line.includes(marker));
    let at = lines.findIndex((line, i) => i > from && /^ {2}# (start|profile):/.test(line));
    while (lines[at]?.startsWith("  # ") && !lines[at]?.startsWith("  # Python")) {
      lines[at] = `  ${(lines[at] ?? "").slice(4)}`;
      at++;
    }
    return lines.join("\n");
  }

  it("profiles Node with its preset, and the draft parses as written", () => {
    expect(parseConfigText(draftConfigFor([NODE])).workload.profile).toEqual({
      preset: "node-cpu",
    });
    expect(parseConfigText(draftConfigFor([GRADLE])).workload).not.toHaveProperty("profile");
  });

  it("offers the JVM's async-profiler agent commented, valid once uncommented", () => {
    const draft = draftConfigFor([stack("jvm"), stack("spring-boot")]);
    expect(parseConfigText(draft).workload).not.toHaveProperty("profile");
    expect(draft.match(/# JVM: /g)).toHaveLength(1);
    expect(draft).toContain("https://github.com/async-profiler/async-profiler");
    const withStart = uncommented(draft, "# JVM: ").replace(
      "  command:",
      "  start: java -jar app.jar\n  command:",
    );
    expect(parseConfigText(withStart).workload.profile).toEqual({
      env: {
        JAVA_TOOL_OPTIONS:
          "-agentpath:/path/to/libasyncProfiler.dylib=start,event=cpu,collapsed,file={{profile_dir}}/prof-%p.collapsed",
      },
      steps: ["start"],
      format: "collapsed",
    });
  });

  it("offers Python's py-spy wrapper on start commented, valid once uncommented", () => {
    const draft = draftConfigFor([stack("python"), stack("fastapi")]);
    expect(parseConfigText(draft).workload).not.toHaveProperty("profile");
    expect(draft).toContain(`# start: ${PYTHON_PROFILED_START}`);
    expect(parseConfigText(uncommented(draft, "# Python: ")).workload).toMatchObject({
      start: PYTHON_PROFILED_START,
      profile: { format: "collapsed" },
    });
  });

  it("starts the bare command in a measured run, where UFO_PROFILE_DIR is not set", () => {
    // What /bin/sh -c makes of the line: its words, as the program would get them.
    const words = (env: NodeJS.ProcessEnv) =>
      execFileSync("/bin/sh", ["-c", `set -- ${PYTHON_PROFILED_START}; printf '[%s]' "$@"`], {
        env,
        encoding: "utf8",
      });
    const { UFO_PROFILE_DIR: _, ...measured } = process.env;
    expect(words(measured)).toBe("[python][app.py]");
    expect(words({ ...measured, UFO_PROFILE_DIR: "" })).toBe("[python][app.py]");
    expect(words({ ...measured, UFO_PROFILE_DIR: "/runs/a b/p" })).toBe(
      "[py-spy][record][-f][raw][-o][/runs/a b/p/py.txt][-s][--][python][app.py]",
    );
  });
});

// M5 V3: Go has no variable that turns profiling on, so its command writes the pprof file.
describe("the draft's Go profile block", () => {
  const GO: DetectedStack = { id: "go", evidence: ["go.mod"], suggestions: {} };
  const sh = (line: string, env: NodeJS.ProcessEnv) =>
    spawnSync("/bin/sh", ["-c", line], { env, encoding: "utf8", timeout: 10_000 });
  const { UFO_PROFILE_DIR: _, ...measured } = process.env;

  it("is commented, names format pprof, and is valid once uncommented", () => {
    const draft = draftConfigFor([GO]);
    expect(parseConfigText(draft).workload).not.toHaveProperty("profile");
    expect(draft).toContain(`  #   ${GO_PROFILED_TEST}\n`);
    expect(draft).toContain(`  #   ${GO_PROFILE_FETCH}\n`);
    expect(draft).toContain("/debug/pprof/profile?seconds=10");
    const lines = draft.split("\n");
    const at = lines.indexOf("  # profile:");
    lines[at] = "  profile:";
    lines[at + 1] = "    format: pprof";
    expect(parseConfigText(lines.join("\n")).workload.profile).toEqual({ format: "pprof" });
    expect(isDraftConfig(draft, [GO])).toBe(true);
  });

  it("profiles the benchmark only where UFO_PROFILE_DIR is set", () => {
    const words = (env: NodeJS.ProcessEnv) =>
      execFileSync("/bin/sh", ["-c", `set -- ${GO_PROFILED_TEST}; printf '[%s]' "$@"`], {
        env,
        encoding: "utf8",
      });
    expect(words(measured)).toBe("[go][test][-run][^$][-bench][.][./bench]");
    expect(words({ ...measured, UFO_PROFILE_DIR: "/runs/a b/p" })).toBe(
      "[go][test][-run][^$][-bench][.][-cpuprofile][/runs/a b/p/cpu.pprof][-o][/dev/null][./bench]",
    );
  });

  it("fetches from the server only in a profile job, and exits as the load did", () => {
    const line = GO_PROFILE_FETCH.replace("./bench.sh", "echo '{}'; (exit 3)");
    expect(line).not.toBe(GO_PROFILE_FETCH);
    const fetchless = sh(line, { ...measured, PATH: "/nonexistent" });
    expect([fetchless.status, fetchless.stdout, fetchless.stderr]).toEqual([3, "{}\n", ""]);
    // A port nothing listens on: curl fails, quietly, and the status stays the load's.
    const failed = sh(line, { ...measured, UFO_PROFILE_DIR: "/nonexistent", UFO_PORT: "1" });
    expect([failed.status, failed.stdout]).toEqual([3, "{}\n"]);
  });
});

describe("isDraftConfig", () => {
  it("accepts exactly the draft built for the stacks", () => {
    expect(isDraftConfig(draftConfigFor([NODE]), [NODE])).toBe(true);
    expect(isDraftConfig(DRAFT_CONFIG)).toBe(true);
    expect(isDraftConfig(draftConfigFor([NODE]), [GRADLE])).toBe(false);
    expect(isDraftConfig(`${DRAFT_CONFIG}x`)).toBe(false);
    expect(isDraftConfig(DRAFT_CONFIG, "node")).toBe(false);
    expect(isDraftConfig(undefined)).toBe(false);
    expect(isDraftConfig(DRAFT_CONFIG, [{ id: 1 }])).toBe(false);
  });
});
