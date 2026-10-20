import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupError,
  type SetupOptions,
  setup,
  uninstall,
  update,
} from "../../../src/setup/index.js";
import { put, type Sandbox, sandbox } from "./sandbox.js";

// AC 11: `setup` twice yields identical config; after setup, a host edit, and uninstall, each
// file equals the pre-setup file plus the host's edit, with no UFO entry left.

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

const codexFile = () => path.join(box.home, ".codex", "config.toml");
const cursorFile = () => path.join(box.home, ".cursor", "mcp.json");
const claudeFile = () => path.join(box.home, ".claude.json");
const agentsSkill = () => path.join(box.home, ".agents", "skills", "ufo-optimize");
const claudeSkill = () => path.join(box.home, ".claude", "skills", "ufo-optimize");
const setupDir = () => path.join(box.ufoHome, "private", "setup");
const read = (file: string) => readFile(file, "utf8");
const SKILL = readFile(new URL("../../../skills/ufo-optimize/SKILL.md", import.meta.url), "utf8");

// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's variable, not a JS template.
const WORKSPACE = "${workspaceFolder}";

const CODEX_TABLE = `[mcp_servers.ufo]
command = "npx"
args = ["-y", "ufo-agents@1.2.3", "mcp"]
startup_timeout_sec = 60
`;

async function refusal(promise: Promise<unknown>): Promise<SetupError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error("expected a SetupError");
}

/** Every file under the sandbox home with its content, to show a refusal wrote nothing. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const root of [box.home, box.ufoHome]) {
    if (!existsSync(root)) continue;
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "setup.lock") continue;
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(box.root, file)] = await read(file);
    }
  }
  return files;
}

describe("AC 11 per host", () => {
  it("Codex: identical second setup; uninstall keeps the host's edit and drops only UFO's table", async () => {
    const pre = `# my settings\nmodel = "o3" # default\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n`;
    await put(codexFile(), pre);

    const first = await setup(options({ hosts: ["codex"] }));
    expect(first.changes.map((c) => [c.kind, c.action])).toEqual([
      ["mcp_server", "add"],
      ["skill", "install"],
    ]);
    const written = await read(codexFile());
    expect(written).toBe(`${pre}\n${CODEX_TABLE}`);
    expect(await read(path.join(agentsSkill(), "SKILL.md"))).toBe(await SKILL);
    expect(await read(path.join(setupDir(), "backups", "codex-config.toml"))).toBe(pre);

    const second = await setup(options({ hosts: ["codex"] }));
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
    expect(await read(codexFile())).toBe(written);

    // The host rewrites a setting and appends its own server after UFO's table.
    const edit = (text: string) =>
      `${text.replace('model = "o3" # default', 'model = "gpt-5"')}\n[mcp_servers.later]\ncommand = "later"\n`;
    await writeFile(codexFile(), edit(written));

    const removed = await uninstall(options());
    expect(removed.changes.map((c) => [c.kind, c.action])).toEqual([
      ["mcp_server", "remove"],
      ["skill", "remove"],
    ]);
    expect(await read(codexFile())).toBe(edit(pre));
    expect(existsSync(agentsSkill())).toBe(false);
    expect(await readdir(path.join(setupDir(), "backups"))).toEqual([]);
    expect(existsSync(path.join(setupDir(), "setup.json"))).toBe(false);
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
          command: "npx",
          args: ["-y", "ufo-agents@1.2.3", "mcp", "--repo", WORKSPACE],
        },
      },
      theme: "dark",
    });
    expect(
      written.startsWith(
        `{\n  "mcpServers": {\n    "docs": { "command": "docs-mcp" },\n    "ufo": {\n      "type": "stdio",`,
      ),
    ).toBe(true);

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
    expect(box.claude.calls).toEqual([
      ["mcp", "add", "--scope", "user", "ufo", "--", "npx", "-y", "ufo-agents@1.2.3", "mcp"],
    ]);
    const written = await read(claudeFile());
    expect(JSON.parse(written).mcpServers.ufo).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "ufo-agents@1.2.3", "mcp"],
      env: {},
    });
    expect(await read(path.join(claudeSkill(), "SKILL.md"))).toBe(await SKILL);
    // No backup: Claude Code's config holds live state and is never restored.
    expect(await readdir(path.join(setupDir(), "backups"))).toEqual([]);

    expect((await setup(options({ hosts: ["claude-code"] }))).changed).toBe(false);
    expect(box.claude.calls).toHaveLength(1);
    expect(await read(claudeFile())).toBe(written);

    // Claude Code rewrites its state.
    const live = JSON.parse(written);
    live.numStartups = 4;
    await writeFile(claudeFile(), JSON.stringify(live, null, 2));

    await uninstall(options());
    expect(box.claude.calls.at(-1)).toEqual(["mcp", "remove", "ufo", "--scope", "user"]);
    expect(JSON.parse(await read(claudeFile()))).toEqual({ ...pre, numStartups: 4 });
    expect(existsSync(claudeSkill())).toBe(false);
  });
});

describe("ufo setup", () => {
  it("sets up every host it finds, showing each change as a diff", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await mkdir(path.join(box.home, ".cursor"));
    let printed = "";
    const report = await setup(options({ print: (text) => (printed += text) }));
    expect(report.hosts).toEqual(["claude-code", "codex", "cursor"]);
    expect(report.detected?.map((host) => [host.id, host.found])).toEqual([
      ["claude-code", true],
      ["codex", true],
      ["cursor", true],
    ]);
    expect(report.changes.map((c) => [c.hosts.join("+"), c.kind, c.action])).toEqual([
      ["claude-code", "mcp_server", "add"],
      ["codex", "mcp_server", "add"],
      ["cursor", "mcp_server", "add"],
      ["claude-code", "skill", "install"],
      ["codex+cursor", "skill", "install"],
    ]);
    expect(printed).toContain("run claude mcp add --scope user ufo -- npx -y ufo-agents@1.2.3 mcp");
    expect(printed).toContain("--- /dev/null\n    +++ ~/.codex/config.toml");
    expect(printed).toContain("+[mcp_servers.ufo]");
    expect(printed).toContain("+++ ~/.cursor/mcp.json");
    expect(report.notes.join(" ")).toContain("Restart Claude Code, Codex, and Cursor");
    expect(report.notes.join(" ")).toContain("list the ufo-optimize skill twice");
    // A file setup created has no backup; uninstall deletes it.
    expect(await read(codexFile())).toBe(CODEX_TABLE);
    expect((await stat(cursorFile())).mode & 0o777).toBe(0o600);

    const removed = await uninstall(options());
    expect(removed.changes.map((c) => c.action)).toEqual([
      "remove",
      "restore",
      "restore",
      "remove",
      "remove",
    ]);
    expect(existsSync(codexFile())).toBe(false);
    expect(existsSync(cursorFile())).toBe(false);
    expect(await snapshot()).toEqual({
      "home/.claude.json": JSON.stringify({ mcpServers: {} }, null, 2),
    });
  });

  it("restores an untouched file from its backup, keeping its mode", async () => {
    const pre = 'model = "o3"';
    await put(codexFile(), pre);
    await chmod(codexFile(), 0o640);
    await setup(options({ hosts: ["codex"] }));
    expect(await read(codexFile())).toBe(`${pre}\n\n${CODEX_TABLE}`);
    expect((await stat(codexFile())).mode & 0o777).toBe(0o640);
    const removed = await uninstall(options());
    expect(removed.changes[0]?.action).toBe("restore");
    expect(await read(codexFile())).toBe(pre);
    expect((await stat(codexFile())).mode & 0o777).toBe(0o640);
  });

  it("reverses its own edit exactly after a host edit, even where the rule alone could not", async () => {
    // Without a final newline the table goes in after two line endings; removing it by rule
    // would leave one behind, so uninstall puts back the recorded edit instead.
    const pre = '# mine\nmodel = "o3"';
    await put(codexFile(), pre);
    await setup(options({ hosts: ["codex"] }));
    await writeFile(codexFile(), (await read(codexFile())).replace("# mine", "# mine, edited"));
    await uninstall(options());
    expect(await read(codexFile())).toBe('# mine, edited\nmodel = "o3"');

    // Whitespace inside an empty mcpServers comes back the same way.
    const cursorPre = '{\n  "mcpServers": {\n  },\n  "theme": "dark"\n}\n';
    await put(cursorFile(), cursorPre);
    await setup(options({ hosts: ["cursor"] }));
    await writeFile(cursorFile(), (await read(cursorFile())).replace("dark", "light"));
    await uninstall(options());
    expect(await read(cursorFile())).toBe(cursorPre.replace("dark", "light"));
  });

  it("writes through a symbolic link to the config, which stays a link", async () => {
    const real = path.join(box.root, "dotfiles", "config.toml");
    await put(real, "a = 1\n");
    await mkdir(path.join(box.home, ".codex"));
    await symlink(real, codexFile());
    await setup(options({ hosts: ["codex"] }));
    expect((await lstat(codexFile())).isSymbolicLink()).toBe(true);
    expect(await read(real)).toBe(`a = 1\n\n${CODEX_TABLE}`);
    await uninstall(options());
    expect((await lstat(codexFile())).isSymbolicLink()).toBe(true);
    expect(await read(real)).toBe("a = 1\n");
  });

  it("refuses a config file that is not UTF-8", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await writeFile(codexFile(), Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x22, 0xff, 0x22, 0x0a]));
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error).toMatchObject({ code: "host_config_invalid" });
    expect(error.message).toContain("is not UTF-8 text");
  });

  it("refuses a host's ufo server it did not write, and writes nothing anywhere", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await put(cursorFile(), '{"mcpServers": {"ufo": {"command": "my-own-ufo"}}}\n');
    const before = await snapshot();
    const error = await refusal(setup(options()));
    expect(error.code).toBe("entry_conflict");
    expect(error.message).toContain(
      "~/.cursor/mcp.json already has a ufo server that UFO did not write",
    );
    expect(box.claude.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a config file that does not parse", async () => {
    await put(codexFile(), 'model = "o3\n');
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error.code).toBe("host_config_invalid");
    expect(error.message).toContain("~/.codex/config.toml is not valid TOML");
    expect(await read(codexFile())).toBe('model = "o3\n');
  });

  it("refuses a skill directory it did not install", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await put(path.join(agentsSkill(), "SKILL.md"), "---\nname: ufo-optimize\n---\nmine\n");
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error.code).toBe("entry_conflict");
    expect(error.message).toContain(
      "~/.agents/skills/ufo-optimize holds a ufo-optimize skill that UFO did not install",
    );
    expect(existsSync(codexFile())).toBe(false);
  });

  it("leaves an identical entry it did not write alone, then and at uninstall", async () => {
    await put(codexFile(), CODEX_TABLE);
    const report = await setup(options({ hosts: ["codex"] }));
    expect(report.unchanged[0]?.reason).toContain("not written by UFO; uninstall leaves it");
    await uninstall(options());
    expect(await read(codexFile())).toBe(CODEX_TABLE);
  });

  it("asks first, and a declined answer writes nothing", async () => {
    await put(codexFile(), "");
    let asked = "";
    const error = await refusal(
      setup(
        options({
          hosts: ["codex"],
          yes: false,
          confirm: async (prompt) => {
            asked = prompt;
            return "no";
          },
        }),
      ),
    );
    expect(asked).toBe('Apply these changes? Type "yes": ');
    expect(error.code).toBe("approval_declined");
    expect(await read(codexFile())).toBe("");
    expect(existsSync(path.join(setupDir(), "setup.json"))).toBe(false);
  });

  it("refuses to write a file that changed after the plan was shown", async () => {
    await put(codexFile(), "a = 1\n");
    const error = await refusal(
      setup(
        options({
          hosts: ["codex"],
          yes: false,
          confirm: async () => {
            await writeFile(codexFile(), "a = 2\n");
            return "yes";
          },
        }),
      ),
    );
    expect(error.code).toBe("changed_during_setup");
    expect(await read(codexFile())).toBe("a = 2\n");
  });

  it("refuses a requested host that is not installed, and none at all", async () => {
    expect((await refusal(setup(options({ hosts: ["cursor"] })))).code).toBe("host_not_found");
    const none = await refusal(
      setup(options({ run: async () => ({ code: 127, stdout: "", stderr: "" }) })),
    );
    expect(none.code).toBe("host_not_found");
  });
});

describe("ufo uninstall", () => {
  it("refuses a ufo entry that was changed since setup wrote it", async () => {
    await put(codexFile(), "");
    await setup(options({ hosts: ["codex"] }));
    const mine = (await read(codexFile())).replace(
      "startup_timeout_sec = 60",
      "startup_timeout_sec = 90",
    );
    await writeFile(codexFile(), mine);
    const error = await refusal(uninstall(options()));
    expect(error.code).toBe("entry_conflict");
    expect(error.message).toContain("was changed since setup wrote it");
    expect(await read(codexFile())).toBe(mine);
  });

  it("refuses a skill directory changed since setup installed it", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    await writeFile(path.join(agentsSkill(), "notes.md"), "mine\n");
    const error = await refusal(uninstall(options()));
    expect(error.code).toBe("entry_conflict");
    expect(error.message).toContain("was changed since setup installed it");
    expect(existsSync(path.join(agentsSkill(), "notes.md"))).toBe(true);
  });

  it("keeps the shared skill until the last host that uses it is uninstalled", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await mkdir(path.join(box.home, ".cursor"));
    await setup(options({ hosts: ["codex", "cursor"] }));
    const codexOnly = await uninstall(options({ hosts: ["codex"] }));
    expect(codexOnly.unchanged).toContainEqual(
      expect.objectContaining({ kind: "skill", reason: "kept for Cursor" }),
    );
    expect(existsSync(agentsSkill())).toBe(true);
    await uninstall(options({ hosts: ["cursor"] }));
    expect(existsSync(agentsSkill())).toBe(false);
  });

  it("forgets an entry someone else already removed", async () => {
    await put(codexFile(), "a = 1\n");
    await setup(options({ hosts: ["codex"] }));
    await writeFile(codexFile(), "a = 1\nb = 2\n");
    const report = await uninstall(options());
    expect(report.unchanged[0]?.reason).toBe("has no ufo server left; nothing to remove");
    expect(await read(codexFile())).toBe("a = 1\nb = 2\n");
    expect(existsSync(path.join(setupDir(), "backups", "codex-config.toml"))).toBe(false);
  });

  it("refuses to restore a backup that is not the file setup backed up", async () => {
    await put(codexFile(), "a = 1\n");
    await setup(options({ hosts: ["codex"] }));
    const written = await read(codexFile());
    await writeFile(path.join(setupDir(), "backups", "codex-config.toml"), "planted = true\n");
    const error = await refusal(uninstall(options()));
    expect(error.code).toBe("unsafe_state");
    expect(await read(codexFile())).toBe(written);
  });

  it("says so when UFO set nothing up", async () => {
    const report = await uninstall(options());
    expect(report).toMatchObject({ hosts: [], changes: [], changed: false });
  });
});

describe("ufo update", () => {
  it("re-pins every entry to the installed version; an untouched file still restores exactly", async () => {
    await put(codexFile(), "a = 1\n");
    await put(cursorFile(), "{}\n");
    await setup(options());
    const report = await update(options({ version: "2.0.0" }));
    expect(report.changes.map((c) => [c.hosts.join("+"), c.action])).toEqual([
      ["claude-code", "repin"],
      ["codex", "repin"],
      ["cursor", "repin"],
    ]);
    expect(await read(codexFile())).toBe(`a = 1\n\n${CODEX_TABLE.replace("1.2.3", "2.0.0")}`);
    expect(await read(cursorFile())).toContain('"ufo-agents@2.0.0"');
    expect(box.claude.calls.slice(-2)).toEqual([
      ["mcp", "remove", "ufo", "--scope", "user"],
      ["mcp", "add", "--scope", "user", "ufo", "--", "npx", "-y", "ufo-agents@2.0.0", "mcp"],
    ]);
    expect((await update(options({ version: "2.0.0" }))).changed).toBe(false);
    await uninstall(options({ version: "2.0.0" }));
    expect(await read(codexFile())).toBe("a = 1\n");
    expect(await read(cursorFile())).toBe("{}\n");
  });

  it("after a host edit, uninstall removes the re-pinned entry instead of restoring the backup", async () => {
    await put(cursorFile(), '{\n  "mcpServers": {}\n}\n');
    await setup(options({ hosts: ["cursor"] }));
    const edited = (await read(cursorFile())).replace(
      '{\n  "mcpServers"',
      '{\n  "theme": "light",\n  "mcpServers"',
    );
    await writeFile(cursorFile(), edited);
    await update(options({ version: "2.0.0" }));
    await uninstall(options({ version: "2.0.0" }));
    expect(await read(cursorFile())).toBe('{\n  "theme": "light",\n  "mcpServers": {}\n}\n');
  });

  it("refuses when UFO set nothing up", async () => {
    expect((await refusal(update(options()))).code).toBe("not_set_up");
  });
});
