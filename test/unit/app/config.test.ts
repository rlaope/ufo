import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DRAFT_CONFIG,
  draftConfigFor,
  isDraftConfig,
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
