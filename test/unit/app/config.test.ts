import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "../../../src/app/config.js";

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
