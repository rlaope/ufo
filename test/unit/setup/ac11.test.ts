import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SetupOptions, setup, uninstall } from "../../../src/setup/index.js";
import { NODE, put, type Sandbox, SKILL_TEXT, sandbox } from "./sandbox.js";

// AC 11: `setup` twice yields identical config; after setup, a host edit, and uninstall, each
// file equals the pre-setup file plus the host's edit, with no UFO entry left.
//
// fixtures/codex-0.163 was captured from the Codex CLI bundled in ChatGPT.app (codex-cli
// 0.163.0-alpha.10.2), run with HOME and CODEX_HOME in scratch directories: `pre-setup.toml`
// and `after-setup.toml` (pre-setup plus UFO's table, as setup writes it), then `codex mcp add
// other -- other-mcp --flag` and `codex mcp remove other` on each. Codex rewrites UFO's
// `startup_timeout_sec = 60` as `60.0` and keeps every other byte. The fixture names neutral
// paths; the test puts its own in.

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

const options = (extra: Partial<SetupOptions> = {}): SetupOptions => ({
  ...box.environment,
  print: () => {},
  yes: true,
  ...extra,
});

const read = (file: string) => readFile(file, "utf8");
const FIXTURE_NODE = "/usr/local/bin/node";
const FIXTURE_SCRIPT = "/home/user/.ufo/pkg/1.2.3/node_modules/ufo-agents/dist/cli/index.js";
const fixture = async (name: string) =>
  (await read(new URL(`fixtures/codex-0.163/${name}`, import.meta.url).pathname))
    .replaceAll(FIXTURE_SCRIPT, box.script())
    .replaceAll(FIXTURE_NODE, NODE);
// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's variable, not a JS template.
const WORKSPACE = "${workspaceFolder}";

const codexFile = () => path.join(box.home, ".codex", "config.toml");
const cursorFile = () => path.join(box.home, ".cursor", "mcp.json");
const claudeFile = () => path.join(box.home, ".claude.json");
const setupDir = () => path.join(box.ufoHome, "private", "setup");

describe("AC 11 per host", () => {
  it("Codex: what the real Codex CLI does to the file in between is kept, and only UFO's table goes", async () => {
    const pre = await fixture("pre-setup.toml");
    await put(codexFile(), pre);

    await setup(options({ hosts: ["codex"] }));
    const written = await read(codexFile());
    expect(written).toBe(await fixture("after-setup.toml"));
    expect(await read(path.join(setupDir(), "backups", "codex-config.toml"))).toBe(pre);

    const second = await setup(options({ hosts: ["codex"] }));
    expect(second.changed).toBe(false);
    expect(await read(codexFile())).toBe(written);

    // `codex mcp add other ...`: Codex adds its table and writes UFO's timeout as 60.0.
    await writeFile(codexFile(), await fixture("with-ufo.after-add-other.toml"));
    const added = await setup(options({ hosts: ["codex"] }));
    expect(added.changed).toBe(false);
    const removed = await uninstall(options());
    expect(removed.changes.map((c) => [c.kind, c.action])).toEqual([
      ["mcp_server", "remove"],
      ["skill", "remove"],
      ["package", "remove"],
    ]);
    // Exactly what the same `codex mcp add` makes of the file without UFO's table.
    expect(await read(codexFile())).toBe(await fixture("without-ufo.after-add-other.toml"));
    expect(existsSync(path.join(box.home, ".agents", "skills", "ufo-optimize"))).toBe(false);
    expect(await readdir(path.join(setupDir(), "backups"))).toEqual([]);
    expect(await readdir(path.join(box.ufoHome, "pkg"))).toEqual([]);
    expect(existsSync(path.join(setupDir(), "setup.json"))).toBe(false);
  });

  it("Codex: after `codex mcp add` and `remove` of another server, uninstall gives back the pre-setup file", async () => {
    const pre = await fixture("pre-setup.toml");
    await put(codexFile(), pre);
    await setup(options({ hosts: ["codex"] }));
    await writeFile(codexFile(), await fixture("with-ufo.after-remove-other.toml"));
    await uninstall(options());
    expect(await read(codexFile())).toBe(await fixture("without-ufo.after-remove-other.toml"));
    expect(await read(codexFile())).toBe(pre);
  });

  it("Cursor: identical second setup; uninstall keeps the host's edits and drops only the ufo member", async () => {
    const pre = `{\n  "mcpServers": {\n    "docs": { "command": "docs-mcp" }\n  },\n  "theme": "dark"\n}\n`;
    await put(cursorFile(), pre);

    await setup(options({ hosts: ["cursor"] }));
    const written = await read(cursorFile());
    expect(JSON.parse(written)).toEqual({
      mcpServers: {
        docs: { command: "docs-mcp" },
        ufo: {
          type: "stdio",
          command: NODE,
          args: [box.script(), "mcp", "--host", "cursor", "--repo", WORKSPACE],
        },
      },
      theme: "dark",
    });

    expect((await setup(options({ hosts: ["cursor"] }))).changed).toBe(false);
    expect(await read(cursorFile())).toBe(written);

    // The host adds a server after UFO's and changes a setting.
    const edited = written
      .replace('"theme": "dark"', '"theme": "light"')
      .replace(
        `"${WORKSPACE}"\n      ]\n    }\n`,
        `"${WORKSPACE}"\n      ]\n    },\n    "later": { "command": "l" }\n`,
      );
    expect(edited).not.toBe(written);
    await writeFile(cursorFile(), edited);

    await uninstall(options());
    expect(await read(cursorFile())).toBe(
      pre
        .replace('"theme": "dark"', '"theme": "light"')
        .replace(
          '"docs": { "command": "docs-mcp" }\n',
          '"docs": { "command": "docs-mcp" },\n    "later": { "command": "l" }\n',
        ),
    );
  });

  it("Claude Code: through its CLI only; uninstall leaves the config as the host left it", async () => {
    const pre = {
      numStartups: 3,
      mcpServers: { docs: { type: "stdio", command: "docs-mcp", args: [] } },
    };
    await put(claudeFile(), JSON.stringify(pre, null, 2));

    await setup(options({ hosts: ["claude-code"] }));
    expect(box.claudeCalls()).toEqual([
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "ufo",
        "--",
        NODE,
        box.script(),
        "mcp",
        "--host",
        "claude-code",
      ],
    ]);
    const written = await read(claudeFile());
    expect(JSON.parse(written).mcpServers.ufo).toEqual({
      type: "stdio",
      command: NODE,
      args: [box.script(), "mcp", "--host", "claude-code"],
      env: {},
    });
    expect(await read(path.join(box.home, ".claude", "skills", "ufo-optimize", "SKILL.md"))).toBe(
      SKILL_TEXT,
    );
    // No backup: Claude Code's config holds live state and is never restored.
    expect(await readdir(path.join(setupDir(), "backups"))).toEqual([]);

    expect((await setup(options({ hosts: ["claude-code"] }))).changed).toBe(false);
    expect(box.claudeCalls()).toHaveLength(1);
    expect(await read(claudeFile())).toBe(written);

    // Claude Code rewrites its state.
    const live = JSON.parse(written);
    live.numStartups = 4;
    await writeFile(claudeFile(), JSON.stringify(live, null, 2));

    await uninstall(options());
    expect(box.claudeCalls().at(-1)).toEqual(["mcp", "remove", "ufo", "--scope", "user"]);
    expect(JSON.parse(await read(claudeFile()))).toEqual({ ...pre, numStartups: 4 });
    expect(existsSync(path.join(box.home, ".claude", "skills", "ufo-optimize"))).toBe(false);
  });
});
