import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE, main } from "../../../src/cli/main.js";

const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("ufo CLI", () => {
  it.each([["--version"], ["-v"]])("prints the package version for %s", (flag) => {
    expect(run([flag])).toEqual({ code: EXIT_OK, stdout: `${pkg.version}\n`, stderr: "" });
  });

  it.each([[[]], [["--help"]], [["-h"]]])("prints usage for %j", (argv) => {
    const result = run(argv);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Usage: ufo");
    expect(result.stderr).toBe("");
  });

  it.each([[["run"]], [["--version", "extra"]], [["--yes"]]])(
    "rejects unknown arguments %j with a usage error",
    (argv) => {
      const result = run(argv);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown arguments");
      expect(result.stderr).toContain("Usage: ufo");
    },
  );
});
