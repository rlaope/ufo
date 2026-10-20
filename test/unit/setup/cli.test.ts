import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../../src/cli/main.js";
import { fakePackage, put, type Sandbox, sandbox } from "./sandbox.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

async function ufo(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd: box.environment.cwd ?? box.root,
    setup: box.environment,
  });
  return { code, stdout, stderr };
}

const codexFile = () => path.join(box.home, ".codex", "config.toml");

describe("ufo setup, uninstall, update on the command line", () => {
  it("prints the plan on stderr and one JSON result on stdout with --json, redacted", async () => {
    await put(codexFile(), 'a = 1\nGITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123"\n');
    const result = await ufo("setup", "--host", "codex", "--yes", "--json");
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      command: "setup",
      result: { command: "setup", version: "1.2.3", hosts: ["codex"], changed: true },
    });
    expect(json.result.changes[1]).toMatchObject({
      hosts: ["codex"],
      kind: "mcp_server",
      target: "~/.codex/config.toml",
      action: "add",
    });
    expect(result.stderr).toContain("+[mcp_servers.ufo]");
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
      expect(text).not.toContain(box.home);
    }
  });

  it("says nothing changed on a second setup", async () => {
    await put(codexFile(), "a = 1\n");
    expect((await ufo("setup", "--host", "codex", "--yes")).code).toBe(0);
    const config = await readFile(codexFile(), "utf8");
    const again = await ufo("setup", "--host", "codex", "--yes");
    expect(again).toMatchObject({ code: 0, stderr: "" });
    expect(again.stdout).toMatch(/^Nothing to change for Codex \(ufo-agents@1\.2\.3\)\./);
    expect(await readFile(codexFile(), "utf8")).toBe(config);
    const removed = await ufo("uninstall", "--yes");
    expect(removed.stdout).toContain("Removed UFO from Codex: 3 changes.");
  });

  it("installs a tarball given with --package, relative to the working directory", async () => {
    await put(codexFile(), "a = 1\n");
    await writeFile(path.join(box.environment.cwd ?? "", "ufo.tgz"), fakePackage("0.0.0").tarball);
    const result = await ufo("setup", "--host", "codex", "--package", "ufo.tgz", "--yes", "--json");
    expect(JSON.parse(result.stdout).result.version).toBe("0.0.0");
  });

  it("reports refusals with their exit codes", async () => {
    expect(await ufo("setup", "--host", "nope")).toMatchObject({
      code: 2,
      stderr: "ufo setup: usage: unknown host nope; use claude-code, codex, cursor\n",
    });
    const update = await ufo("update", "--json");
    expect(update.code).toBe(2);
    expect(JSON.parse(update.stdout).error.code).toBe("not_set_up");
    await put(path.join(box.home, ".cursor", "mcp.json"), '{"mcpServers": {"ufo": {}}}');
    const conflict = await ufo("setup", "--host", "cursor", "--yes");
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toMatch(
      /^ufo setup: entry_conflict: ~\/\.cursor\/mcp\.json already has/,
    );
  });

  it("uninstall says what it has not set up", async () => {
    expect(await ufo("uninstall")).toEqual({
      code: 0,
      stdout: "UFO has not set up any host; nothing to remove.\n",
      stderr: "",
    });
    await put(codexFile(), "a = 1\n");
    await ufo("setup", "--host", "codex", "--yes");
    expect((await ufo("uninstall", "--host", "cursor")).stdout).toBe(
      "UFO has not set up Cursor; nothing to remove.\n",
    );
  });

  it("lists every setup flag in the usage", async () => {
    const help = await ufo("--help");
    for (const word of ["setup", "uninstall", "update", "--host <name>", "--yes", "--package"]) {
      expect(help.stdout).toContain(word);
    }
    expect(help.stdout).toContain("setup, update, and uninstall take:");
  });
});
