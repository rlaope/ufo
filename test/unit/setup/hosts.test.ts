import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unifiedDiff } from "../../../src/setup/diff.js";
import {
  detectHosts,
  findExecutable,
  HOST_IDS,
  hostPaths,
  parseHostIds,
  sameEntry,
} from "../../../src/setup/hosts.js";
import {
  hashFiles,
  installSkill,
  readSkillHashes,
  removeSkill,
} from "../../../src/setup/skills.js";
import { onPath, type Sandbox, sandbox } from "./sandbox.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

const missing = async () => ({ code: 127, stdout: "", stderr: "" });

describe("host detection", () => {
  const detect = (
    run = box.environment.run ?? missing,
    env: NodeJS.ProcessEnv = { PATH: box.bin },
    claude: string | undefined = path.join(box.bin, "claude"),
  ) =>
    detectHosts(HOST_IDS, {
      paths: hostPaths(box.home, env),
      env,
      run,
      applications: path.join(box.root, "Applications"),
      claude,
    });

  it("finds nothing on an empty machine", async () => {
    const found = await detect(missing, { PATH: "" }, undefined);
    expect(found.map((host) => host.found)).toEqual([false, false, false]);
  });

  it("finds Claude Code by its CLI, named by its absolute path", async () => {
    const [claude] = await detect();
    expect(claude).toEqual({
      id: "claude-code",
      name: "Claude Code",
      found: true,
      evidence: [`claude at ${path.join(box.bin, "claude")} (2.1.304 (Claude Code))`],
    });
  });

  it("probes only the hosts asked for", async () => {
    let ran = 0;
    const counted = async () => {
      ran++;
      return { code: 0, stdout: "x", stderr: "" };
    };
    const env = { PATH: box.bin };
    const found = await detectHosts(["codex"], {
      paths: hostPaths(box.home, env),
      env,
      run: counted,
      applications: path.join(box.root, "Applications"),
      claude: path.join(box.bin, "claude"),
    });
    expect(found.map((host) => host.id)).toEqual(["codex"]);
    expect(ran).toBe(0);
  });

  it("finds Codex and Cursor by their CLIs on PATH, their apps, and their config directories", async () => {
    await onPath(box, "codex");
    await onPath(box, "cursor-agent");
    await mkdir(path.join(box.root, "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"), {
      recursive: true,
    });
    await writeFile(
      path.join(box.root, "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"),
      "",
    );
    await mkdir(path.join(box.root, "Applications/Cursor.app"));
    await mkdir(path.join(box.home, ".codex"));
    await mkdir(path.join(box.home, ".cursor"));
    const [, codex, cursor] = await detect(missing);
    expect(codex?.evidence).toEqual([
      `codex at ${path.join(box.bin, "codex")}`,
      "the codex CLI in ChatGPT.app",
      "~/.codex",
    ]);
    expect(cursor?.evidence).toEqual([
      `cursor-agent at ${path.join(box.bin, "cursor-agent")}`,
      "Cursor.app",
      "~/.cursor",
    ]);
  });

  it("ignores a non-executable file and relative or empty PATH entries", async () => {
    await writeFile(path.join(box.bin, "agent"), "");
    await mkdir(path.join(box.root, "rel"));
    const env = { PATH: ["bin", "", box.bin].join(path.delimiter) };
    expect(await findExecutable("agent", env)).toBeUndefined();
    expect(await findExecutable("npm", env)).toBe(path.join(box.bin, "npm"));
  });
});

describe("host paths", () => {
  it("derive from the home directory", () => {
    const paths = hostPaths("/h", {});
    expect(paths).toEqual({
      home: "/h",
      claudeJson: "/h/.claude.json",
      codexConfig: "/h/.codex/config.toml",
      cursorConfig: "/h/.cursor/mcp.json",
      skillDirs: {
        "claude-code": "/h/.claude/skills/ufo-optimize",
        codex: "/h/.agents/skills/ufo-optimize",
        cursor: "/h/.agents/skills/ufo-optimize",
      },
    });
  });

  it("follow CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const paths = hostPaths("/h", { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" });
    expect(paths.claudeJson).toBe("/c/.claude.json");
    expect(paths.skillDirs["claude-code"]).toBe("/c/skills/ufo-optimize");
    expect(paths.codexConfig).toBe("/x/config.toml");
  });
});

describe("entries and --host", () => {
  it("treat the defaults hosts add as the same entry, and nothing else", () => {
    const entry = { command: "npx", args: ["-y", "ufo-agents@1.2.3", "mcp"] };
    expect(sameEntry({ ...entry, type: "stdio", env: {} }, entry)).toBe(true);
    expect(sameEntry({ ...entry, env: { TOKEN: "x" } }, entry)).toBe(false);
    expect(sameEntry({ ...entry, args: ["-y", "ufo-agents@1.2.4", "mcp"] }, entry)).toBe(false);
    expect(sameEntry(undefined, entry)).toBe(false);
  });

  it("parses --host values into host order and refuses unknown ones", () => {
    expect(parseHostIds(["cursor", "claude-code"])).toEqual(["claude-code", "cursor"]);
    expect(() => parseHostIds(["vscode"])).toThrow("unknown host vscode");
  });
});

describe("the diff setup prints", () => {
  it("shows one hunk with three lines of context", () => {
    const before = "1\n2\n3\n4\n5\n";
    const after = "1\n2\n3\n4\n5\n\n[ufo]\nx = 1\n";
    expect(unifiedDiff("~/f", before, after)).toBe(
      "--- ~/f\n+++ ~/f\n@@ -3,3 +3,6 @@\n 3\n 4\n 5\n+\n+[ufo]\n+x = 1\n",
    );
    expect(unifiedDiff("~/f", after, before)).toBe(
      "--- ~/f\n+++ ~/f\n@@ -3,6 +3,3 @@\n 3\n 4\n 5\n-\n-[ufo]\n-x = 1\n",
    );
  });

  it("names a missing file /dev/null and is empty for equal texts", () => {
    expect(unifiedDiff("~/f", undefined, "a\n")).toBe(
      "--- /dev/null\n+++ ~/f\n@@ -0,0 +1,1 @@\n+a\n",
    );
    expect(unifiedDiff("~/f", "a\n", undefined)).toBe(
      "--- ~/f\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n",
    );
    expect(unifiedDiff("~/f", "a\n", "a\n")).toBe("");
  });
});

describe("skill directories", () => {
  const files = new Map([
    ["SKILL.md", Buffer.from("---\nname: ufo-optimize\n---\n")],
    ["refs/cards.md", Buffer.from("cards\n")],
  ]);

  it("install whole, hash every file, and replace in place", async () => {
    const dir = path.join(box.home, ".agents", "skills", "ufo-optimize");
    await installSkill(dir, files, false);
    expect(await readSkillHashes(dir)).toEqual(hashFiles(files));
    const next = new Map([["SKILL.md", Buffer.from("v2\n")]]);
    await installSkill(dir, next, true);
    expect(await readSkillHashes(dir)).toEqual(hashFiles(next));
    await removeSkill(dir);
    expect(await readSkillHashes(dir)).toBeUndefined();
  });

  it("never match a directory holding a link", async () => {
    const dir = path.join(box.home, "skill");
    await installSkill(dir, files, false);
    await symlink("/etc/hosts", path.join(dir, "link.md"));
    expect((await readSkillHashes(dir))?.["link.md"]).toBe("not a regular file");
  });
});
