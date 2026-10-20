import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyError, violation } from "../../../src/core/policy/index.js";
import { SetupError, type SetupOptions, setup, terminalConfirm } from "../../../src/setup/index.js";
import {
  fakePackage,
  NODE,
  put,
  type Sandbox,
  SKILL_TEXT,
  sandbox,
  tarball,
  VERSION,
} from "./sandbox.js";

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
const agentsSkill = () => path.join(box.home, ".agents", "skills", "ufo-optimize");
const setupDir = () => path.join(box.ufoHome, "private", "setup");
const prefix = (version = VERSION) => path.join(box.ufoHome, "pkg", version);
const read = (file: string) => readFile(file, "utf8");
const record = async () => JSON.parse(await read(path.join(setupDir(), "setup.json")));
const codexTable = (version = VERSION) =>
  `[mcp_servers.ufo]\ncommand = "${NODE}"\nargs = ["${box.script(version)}", "mcp", "--host", "codex"]\nstartup_timeout_sec = 60\n`;

async function refusal(promise: Promise<unknown>): Promise<SetupError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error("expected a SetupError");
}

/** Every file under the sandbox home and UFO home with its content. */
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

describe("ufo setup", () => {
  it("sets up every host it finds from one installed copy, showing each change", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await mkdir(path.join(box.home, ".cursor"));
    let printed = "";
    const report = await setup(options({ print: (text) => (printed += text) }));
    expect(report.hosts).toEqual(["claude-code", "codex", "cursor"]);
    expect(report.changes.map((c) => [c.hosts.join("+"), c.kind, c.action])).toEqual([
      ["claude-code+codex+cursor", "package", "install"],
      ["claude-code", "mcp_server", "add"],
      ["codex", "mcp_server", "add"],
      ["cursor", "mcp_server", "add"],
      ["claude-code", "skill", "install"],
      ["codex+cursor", "skill", "install"],
    ]);
    // The plan names the programs it runs by their absolute paths.
    expect(printed).toContain(`claude at ${box.bin}/claude (2.1.304 (Claude Code))`);
    expect(printed).toContain(`run ${box.bin}/claude mcp add --scope user ufo -- ${NODE} `);
    expect(printed).toContain(`with ${box.bin}/npm (no install scripts`);
    expect(printed).toContain("+[mcp_servers.ufo]");
    expect(report.notes.join(" ")).toContain("Restart Claude Code, Codex, and Cursor");
    expect(report.notes.join(" ")).toContain("list the ufo-optimize skill twice");
    expect(await read(codexFile())).toBe(codexTable());
    expect((await stat(cursorFile())).mode & 0o777).toBe(0o600);
    expect((await stat(prefix())).mode & 0o777).toBe(0o700);
    expect(await read(path.join(agentsSkill(), "SKILL.md"))).toBe(SKILL_TEXT);
    expect((await record()).packages).toEqual({
      [VERSION]: { source: "registry", integrity: fakePackage(VERSION).integrity },
    });
  });

  it("installs the exact version with npm: no scripts, the public registry, no npm_config_*", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    const [npm] = box.fakes.calls.filter((call) => call.program === "npm");
    expect(npm?.file).toBe(path.join(box.bin, "npm"));
    expect(npm?.args).toEqual([
      "install",
      "--prefix",
      npm?.cwd,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--save=true",
      "--dry-run=false",
      "--global=false",
      "--registry=https://registry.npmjs.org/",
      `ufo-agents@${VERSION}`,
    ]);
    expect(path.dirname(npm?.cwd ?? "")).toBe(path.join(box.ufoHome, "pkg"));
    expect(Object.keys(npm?.env ?? {}).filter((name) => /^npm_config_/i.test(name))).toEqual([]);
    expect(await read(path.join(prefix(), "node_modules", "ufo-agents", "package.json"))).toContain(
      `"version":"${VERSION}"`,
    );
  });

  it("refuses an unreleased, inexact, or unpublished version and says to use --package", async () => {
    await mkdir(path.join(box.home, ".codex"));
    // The registry has each of them, but only 9.9.9 is refused for being missing from it.
    box.fakes.registry.set("0.0.0", fakePackage("0.0.0"));
    box.fakes.registry.set("^1.2.3", fakePackage("1.2.3"));
    for (const [version, why] of [
      ["0.0.0", "ufo-agents@0.0.0 is not a released version"],
      ["^1.2.3", "ufo-agents@^1.2.3 is not a released version"],
      ["9.9.9", "the npm registry has no ufo-agents@9.9.9 (the name is not published yet)"],
    ] as const) {
      if (version === "9.9.9") box.fakes.registry.delete("9.9.9");
      const error = await refusal(setup(options({ hosts: ["codex"], version })));
      expect(error.code).toBe("package_unavailable");
      expect(error.message).toBe(`${why}; install from a tarball with --package <file.tgz>`);
    }
    expect(box.fakes.calls.filter((call) => call.program === "npm")).toEqual([]);
    expect(existsSync(codexFile())).toBe(false);
  });

  it("refuses a copy whose integrity is not the registry's, and sets nothing up", async () => {
    await mkdir(path.join(box.home, ".codex"));
    // Same version and skill, other code: only the integrity tells it from the registry's.
    box.fakes.npmServes = fakePackage(VERSION, SKILL_TEXT, "// tampered\n");
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error.code).toBe("integrity_mismatch");
    expect(existsSync(prefix())).toBe(false);
    expect(existsSync(codexFile())).toBe(false);
    expect(await readdir(path.join(box.ufoHome, "pkg"))).toEqual([]);
  });

  it("refuses an installed copy whose skill is not the one this UFO ships", async () => {
    await mkdir(path.join(box.home, ".codex"));
    // The registry's own 1.2.3, integrity and all, but with another skill than the running one.
    box.fakes.registry.set(VERSION, fakePackage(VERSION, `${SKILL_TEXT}Other.\n`));
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error.code).toBe("integrity_mismatch");
    expect(error.message).toContain("is not the one shown in the plan");
    expect(existsSync(prefix())).toBe(false);
  });

  it("installs a local tarball with --package and records its sha512", async () => {
    await mkdir(path.join(box.home, ".codex"));
    const pkg = fakePackage("0.0.0");
    const file = path.join(box.root, "ufo-agents-0.0.0.tgz");
    await writeFile(file, pkg.tarball);
    const report = await setup(options({ hosts: ["codex"], package: file }));
    expect(report.version).toBe("0.0.0");
    expect(await read(codexFile())).toBe(codexTable("0.0.0"));
    expect((await record()).packages).toEqual({
      "0.0.0": { source: "tarball", integrity: pkg.integrity, tarball: file },
    });
    expect(box.fakes.calls.find((call) => call.program === "npm")?.args.at(-1)).toBe(file);
    // The same tarball again changes nothing; a rebuilt one replaces the copy.
    expect((await setup(options({ hosts: ["codex"], package: file }))).changed).toBe(false);
    await writeFile(file, fakePackage("0.0.0", `${SKILL_TEXT}More.\n`).tarball);
    const again = await setup(options({ hosts: ["codex"], package: file }));
    expect(again.changes.map((c) => [c.kind, c.action])).toEqual([
      ["package", "replace"],
      ["skill", "replace"],
    ]);
  });

  it("refuses a --package file that is not a ufo-agents tarball", async () => {
    await mkdir(path.join(box.home, ".codex"));
    const other = path.join(box.root, "other.tgz");
    await writeFile(other, tarball({ "package.json": '{"name":"left-pad","version":"1.0.0"}' }));
    const error = await refusal(setup(options({ hosts: ["codex"], package: other })));
    expect(error).toMatchObject({ code: "usage" });
    expect(error.message).toContain("is not a ufo-agents tarball");
  });

  // Code review M1: your home a git repository (dotfiles), setup from it or a folder under it
  // takes a UFO home there and finds what is installed under it.
  it("works from a home that is a git repository", async () => {
    execFileSync("git", ["init", "--quiet"], { cwd: box.home });
    await mkdir(path.join(box.home, "notes"));
    await mkdir(path.join(box.home, ".codex"));
    const ufoHome = path.join(box.home, ".ufo");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(box.home);
    try {
      for (const cwd of [box.home, path.join(box.home, "notes")]) {
        const report = await setup(options({ hosts: ["codex"], cwd, ufoHome }));
        expect(report.hosts, cwd).toEqual(["codex"]);
      }
      expect(readFileSync(codexFile(), "utf8")).toContain(path.join(ufoHome, "pkg", VERSION));
    } finally {
      homedir.mockRestore();
    }
  });

  it("probes only the hosts in scope", async () => {
    await mkdir(path.join(box.home, ".codex"));
    const report = await setup(options({ hosts: ["codex"] }));
    expect(report.detected?.map((host) => host.id)).toEqual(["codex"]);
    expect(box.fakes.calls.filter((call) => call.program === "claude")).toEqual([]);
  });

  it("finds claude only outside the working directory and node_modules, and runs it in the home", async () => {
    const work = box.environment.cwd ?? "";
    for (const dir of [path.join(work, "bin"), path.join(box.root, "x", "node_modules", ".bin")]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "claude"), "#!/bin/sh\n");
      await chmod(path.join(dir, "claude"), 0o755);
    }
    const PATH = [
      "relative/bin",
      "",
      path.join(work, "bin"),
      path.join(box.root, "x", "node_modules", ".bin"),
      box.bin,
    ].join(path.delimiter);
    await setup(options({ hosts: ["claude-code"], env: { PATH } }));
    const claude = box.fakes.calls.filter((call) => call.program === "claude");
    expect(new Set(claude.map((call) => call.file))).toEqual(
      new Set([path.join(box.bin, "claude")]),
    );
    expect(new Set(claude.map((call) => call.cwd))).toEqual(new Set([box.home]));
  });

  it("restores an untouched file from its backup, keeping its mode", async () => {
    const pre = 'model = "o3"';
    await put(codexFile(), pre);
    await chmod(codexFile(), 0o640);
    await setup(options({ hosts: ["codex"] }));
    expect(await read(codexFile())).toBe(`${pre}\n\n${codexTable()}`);
    expect((await stat(codexFile())).mode & 0o777).toBe(0o640);
    const { uninstall } = await import("../../../src/setup/index.js");
    const removed = await uninstall(options());
    expect(removed.changes[0]?.action).toBe("restore");
    expect(await read(codexFile())).toBe(pre);
    expect((await stat(codexFile())).mode & 0o777).toBe(0o640);
  });

  it("writes through a symbolic link to the config, which stays a link", async () => {
    const real = path.join(box.root, "dotfiles", "config.toml");
    await put(real, "a = 1\n");
    await mkdir(path.join(box.home, ".codex"));
    await symlink(real, codexFile());
    await setup(options({ hosts: ["codex"] }));
    expect((await lstat(codexFile())).isSymbolicLink()).toBe(true);
    expect(await read(real)).toBe(`a = 1\n\n${codexTable()}`);
  });

  it("shows diffs redacted, in context and removed lines alike", async () => {
    await put(codexFile(), 'model = "o3"\n[profiles.x]\nAPI_KEY = "sk-abcdefghijklmnopqrstuvwx"\n');
    let printed = "";
    const report = await setup(options({ hosts: ["codex"], print: (text) => (printed += text) }));
    const diff = report.changes.find((c) => c.kind === "mcp_server")?.diff ?? "";
    expect(diff).toContain(' API_KEY = "<redacted:api_key>"');
    expect(diff).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(diff).toContain(
      '+args = ["~/.ufo/pkg/1.2.3/node_modules/ufo-agents/dist/cli/index.js", "mcp", "--host", "codex"]',
    );
    expect(printed).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(printed).not.toContain(box.home);
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
    expect(box.claudeCalls()).toEqual([]);
    expect(box.fakes.calls.filter((call) => call.program === "npm")).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a config file that does not parse, or is not UTF-8", async () => {
    await put(codexFile(), 'model = "o3\n');
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error.code).toBe("host_config_invalid");
    expect(error.message).toContain("~/.codex/config.toml is not valid TOML");
    expect(await read(codexFile())).toBe('model = "o3\n');
    await writeFile(codexFile(), Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x22, 0xff, 0x22, 0x0a]));
    expect((await refusal(setup(options({ hosts: ["codex"] })))).message).toContain(
      "is not UTF-8 text",
    );
  });

  it("refuses a skill directory it did not install, naming the file that differs", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await put(path.join(agentsSkill(), "SKILL.md"), "---\nname: ufo-optimize\n---\nmine\n");
    const error = await refusal(setup(options({ hosts: ["codex"] })));
    expect(error.code).toBe("entry_conflict");
    expect(error.message).toContain(
      "~/.agents/skills/ufo-optimize holds a ufo-optimize skill that UFO did not install (SKILL.md differs)",
    );
    expect(existsSync(codexFile())).toBe(false);
  });

  it("leaves an identical entry it did not write alone, then and at uninstall", async () => {
    await put(codexFile(), codexTable());
    const report = await setup(options({ hosts: ["codex"] }));
    expect(report.unchanged.find((u) => u.kind === "mcp_server")?.reason).toContain(
      "not written by UFO; uninstall leaves it",
    );
    const { uninstall } = await import("../../../src/setup/index.js");
    await uninstall(options());
    expect(await read(codexFile())).toBe(codexTable());
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
    expect(existsSync(prefix())).toBe(false);
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
    const none = await refusal(setup(options({ env: { PATH: path.join(box.root, "empty") } })));
    expect(none.code).toBe("host_not_found");
  });

  it("asks before going back to an older version, even with --yes", async () => {
    await mkdir(path.join(box.home, ".codex"));
    box.fakes.registry.set("2.0.0", fakePackage("2.0.0"));
    await setup(options({ hosts: ["codex"], version: "2.0.0" }));
    const written = await read(codexFile());
    let asked = "";
    const declined = await refusal(
      setup(
        options({
          hosts: ["codex"],
          confirm: async (prompt) => {
            asked = prompt;
            return "yes";
          },
        }),
      ),
    );
    expect(asked).toBe(
      'ufo-agents@2.0.0 is set up; type "downgrade" to replace it with the older 1.2.3: ',
    );
    expect(declined.code).toBe("approval_declined");
    expect(await read(codexFile())).toBe(written);
    await setup(options({ hosts: ["codex"], confirm: async () => "downgrade" }));
    expect(await read(codexFile())).toBe(codexTable());
  });

  it("is busy while another setup holds its lock", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    await writeFile(path.join(setupDir(), "setup.lock"), String(process.pid));
    const error = await refusal(setup(options({ hosts: ["codex"], lockWaitMs: 200 })));
    expect(error.failure).toMatchObject({
      code: "busy",
      exitCode: 1,
      retryable: true,
      hint: "wait for it to finish, then run this command again",
    });
  });

  it("reports failures redacted: a parse error can quote a host config", () => {
    const error = new SetupError(
      "host_config_invalid",
      'near "ghp_abcdefghijklmnopqrstuvwxyz0123"',
    );
    expect(error.failure.message).toBe('near "<redacted:api_key>"');
  });

  it("says there is no terminal to ask on, and to pass --yes", async () => {
    const ask = terminalConfirm("setup", async () => {
      throw new PolicyError(violation("non_tty_approval", "no interactive terminal"));
    });
    const error = await refusal(ask("Apply? "));
    expect(error.failure).toMatchObject({ code: "no_terminal", exitCode: 2 });
    expect(error.message).toContain("pass --yes");
  });
});

describe("ufo setup through Claude Code's CLI", () => {
  const failing = { code: 1, stdout: "", stderr: "boom" };

  it("records the change before it runs claude mcp add", async () => {
    let recorded: unknown;
    box.fakes.claudeFail = (args) => {
      if (args[1] === "add") {
        recorded = JSON.parse(readFileSync(path.join(setupDir(), "setup.json"), "utf8")).hosts[
          "claude-code"
        ];
      }
      return undefined;
    };
    await setup(options({ hosts: ["claude-code"] }));
    expect(recorded).toMatchObject({ pending: { version: VERSION } });
    expect((await record()).hosts["claude-code"].pending).toBeUndefined();
  });

  it("owns what Claude Code stored when it adds fields of its own", async () => {
    box.fakes.claudeAdds = { timeout: 30000 };
    await setup(options({ hosts: ["claude-code"] }));
    expect((await setup(options({ hosts: ["claude-code"] }))).changed).toBe(false);
    await (await import("../../../src/setup/index.js")).uninstall(options());
    const claudeJson = JSON.parse(await read(path.join(box.home, ".claude.json")));
    expect(claudeJson.mcpServers).toEqual({});
  });

  it("records nothing when claude mcp add fails", async () => {
    box.fakes.claudeFail = (args) => (args[1] === "add" ? failing : undefined);
    const error = await refusal(setup(options({ hosts: ["claude-code"] })));
    expect(error.code).toBe("host_cli_failed");
    expect(error.message).toContain("mcp add --scope user ufo");
    expect(error.message).toContain("exited 1: boom");
    expect((await record()).hosts).toEqual({});
  });

  it("takes out an added server that does not show up as UFO's", async () => {
    box.fakes.claudeFail = (args) =>
      args[1] === "add" ? { code: 0, stdout: "", stderr: "" } : undefined;
    const error = await refusal(setup(options({ hosts: ["claude-code"] })));
    expect(error.message).toContain("shows no matching ufo server");
    expect(box.claudeCalls().map((args) => args[1])).toEqual(["add", "remove"]);
    expect((await record()).hosts).toEqual({});
  });

  it("puts the previous server back when a re-pin's add fails", async () => {
    await setup(options({ hosts: ["claude-code"] }));
    box.fakes.registry.set("2.0.0", fakePackage("2.0.0"));
    box.fakes.claudeFail = (args) =>
      args[1] === "add" && args.includes(box.script("2.0.0")) ? failing : undefined;
    const error = await refusal(setup(options({ hosts: ["claude-code"], version: "2.0.0" })));
    expect(error.message).toContain("the previous ufo server is back in place");
    const claudeJson = JSON.parse(await read(path.join(box.home, ".claude.json")));
    expect(claudeJson.mcpServers.ufo.args[0]).toBe(box.script());
    expect((await record()).hosts["claude-code"]).toMatchObject({ version: VERSION });
  });

  it("says the server is gone when a re-pin can add neither the new nor the old one", async () => {
    await setup(options({ hosts: ["claude-code"] }));
    box.fakes.registry.set("2.0.0", fakePackage("2.0.0"));
    box.fakes.claudeFail = (args) => (args[1] === "add" ? failing : undefined);
    const error = await refusal(setup(options({ hosts: ["claude-code"], version: "2.0.0" })));
    expect(error.message).toContain(
      "the previous ufo server was removed and could not be added back: run ufo setup again",
    );
    expect((await record()).hosts["claude-code"]).toBeUndefined();
  });
});
