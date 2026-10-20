import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE, main } from "../../../src/cli/main.js";

const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

async function run(argv: string[], cwd?: string, env: NodeJS.ProcessEnv = { ...process.env }) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { code, stdout, stderr };
}

describe("ufo CLI", () => {
  it.each([["--version"], ["-v"]])("prints the package version for %s", async (flag) => {
    expect(await run([flag])).toEqual({ code: EXIT_OK, stdout: `${pkg.version}\n`, stderr: "" });
  });

  it.each([[[]], [["--help"]], [["-h"]], [["status", "--help"]]])(
    "prints usage for %j",
    async (argv) => {
      const result = await run(argv);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toContain("Usage: ufo");
      expect(result.stdout).toContain("extend-budget");
      expect(result.stderr).toBe("");
    },
  );

  it.each([[["frobnicate"]], [["--version", "extra"]], [["--yes"]]])(
    "rejects unknown arguments %j with a usage error",
    async (argv) => {
      const result = await run(argv);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown arguments");
      expect(result.stderr).toContain("Usage: ufo");
    },
  );

  it.each([[["approve", "--yes"]], [["run", "now"]], [["status", "--run"]]])(
    "rejects bad flags of a command %j with a usage error",
    async (argv) => {
      const result = await run(argv);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stdout).toBe("");
    },
  );

  // Code review CR-N11: main() filters the PATH of the environment it is given, never the test
  // process's own.
  it("filters the PATH of the environment it is given, not the process's", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ufo-cli-"));
    const before = process.env.PATH;
    try {
      const env = {
        ...process.env,
        PATH: ["/p/node_modules/.bin", "/usr/bin"].join(path.delimiter),
      };
      await run(["status", "--json"], dir, env);
      expect(env.PATH).toBe("/usr/bin");
      expect(process.env.PATH).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a directory outside any repository as a usage error, in JSON with --json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ufo-cli-"));
    try {
      const result = await run(["status", "--json"], dir);
      expect(result.code).toBe(EXIT_USAGE);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        command: "status",
        error: { code: "not_a_repo" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
