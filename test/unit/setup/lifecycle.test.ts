import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupError,
  type SetupOptions,
  setup,
  uninstall,
  update,
} from "../../../src/setup/index.js";
import { fakePackage, put, type Sandbox, SKILL_TEXT, sandbox, VERSION } from "./sandbox.js";

let box: Sandbox;
/** The skill a running UFO 2.0.0 ships, which the registry's 2.0.0 holds too. */
let skill2: string;
beforeEach(async () => {
  box = await sandbox();
  box.fakes.registry.set("2.0.0", fakePackage("2.0.0", `${SKILL_TEXT}Version 2.\n`));
  skill2 = await mkdtemp(path.join(box.root, "skill-2-"));
  await writeFile(path.join(skill2, "SKILL.md"), `${SKILL_TEXT}Version 2.\n`);
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

/** Options of a running UFO 2.0.0. */
const v2 = () => options({ version: "2.0.0", skillSource: skill2 });
const codexFile = () => path.join(box.home, ".codex", "config.toml");
const cursorFile = () => path.join(box.home, ".cursor", "mcp.json");
const agentsSkill = () => path.join(box.home, ".agents", "skills", "ufo-optimize");
const setupDir = () => path.join(box.ufoHome, "private", "setup");
const read = (file: string) => readFile(file, "utf8");
const record = async () => JSON.parse(await read(path.join(setupDir(), "setup.json")));

async function refusal(promise: Promise<unknown>): Promise<SetupError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error("expected a SetupError");
}

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

  it("refuses a ufo entry the host extended with [mcp_servers.ufo.env]", async () => {
    await put(codexFile(), "a = 1\n");
    await setup(options({ hosts: ["codex"] }));
    const extended = `${await read(codexFile())}\n[mcp_servers.ufo.env]\nTOKEN_FILE = "x"\n`;
    await writeFile(codexFile(), extended);
    expect((await refusal(uninstall(options()))).code).toBe("entry_conflict");
    expect(await read(codexFile())).toBe(extended);
  });

  it("refuses a skill directory changed since setup installed it, naming the file", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    await writeFile(path.join(agentsSkill(), "notes.md"), "mine\n");
    const error = await refusal(uninstall(options()));
    expect(error.code).toBe("entry_conflict");
    expect(error.message).toContain("was changed since setup installed it (notes.md was added)");
    expect(existsSync(path.join(agentsSkill(), "notes.md"))).toBe(true);
  });

  it("ignores a .DS_Store Finder left in the skill directory", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    await writeFile(path.join(agentsSkill(), ".DS_Store"), "finder");
    await uninstall(options());
    expect(existsSync(agentsSkill())).toBe(false);
  });

  it("keeps the shared skill and the package until the last host that uses them goes", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await mkdir(path.join(box.home, ".cursor"));
    await setup(options({ hosts: ["codex", "cursor"] }));
    const codexOnly = await uninstall(options({ hosts: ["codex"] }));
    expect(codexOnly.unchanged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skill", reason: "kept for Cursor" }),
        expect.objectContaining({ kind: "package", reason: "kept for Cursor" }),
      ]),
    );
    expect(existsSync(agentsSkill())).toBe(true);
    expect(existsSync(path.join(box.ufoHome, "pkg", VERSION))).toBe(true);
    await uninstall(options({ hosts: ["cursor"] }));
    expect(existsSync(agentsSkill())).toBe(false);
    expect(await readdir(path.join(box.ufoHome, "pkg"))).toEqual([]);
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
    expect((await refusal(uninstall(options()))).code).toBe("unsafe_state");
    expect(await read(codexFile())).toBe(written);
  });

  it("gives back whitespace in an empty mcpServers that only setup's own edit records", async () => {
    const pre = '{\n  "mcpServers": {\n  },\n  "theme": "dark"\n}\n';
    await put(cursorFile(), pre);
    await setup(options({ hosts: ["cursor"] }));
    await writeFile(cursorFile(), (await read(cursorFile())).replace("dark", "light"));
    await uninstall(options());
    expect(await read(cursorFile())).toBe(pre.replace("dark", "light"));
  });

  it("gives back a file without a final newline exactly after a host edit", async () => {
    const pre = '# mine\nmodel = "o3"';
    await put(codexFile(), pre);
    await setup(options({ hosts: ["codex"] }));
    await writeFile(codexFile(), (await read(codexFile())).replace("# mine", "# mine, edited"));
    await uninstall(options());
    expect(await read(codexFile())).toBe('# mine, edited\nmodel = "o3"');
  });

  it("says which requested host UFO has not set up", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    const report = await uninstall(options({ hosts: ["cursor"] }));
    expect(report).toMatchObject({ hosts: [], notSetUp: ["cursor"], changed: false });
    expect(existsSync(codexFile())).toBe(true);
  });
});

describe("ufo update", () => {
  it("installs the new version beside the old, points every host at it, and uninstall restores exactly", async () => {
    await put(codexFile(), "a = 1\n");
    await put(cursorFile(), "{}\n");
    await setup(options());
    const report = await update(v2());
    expect(report.changes.map((c) => [c.hosts.join("+"), c.kind, c.action])).toEqual([
      ["claude-code+codex+cursor", "package", "install"],
      ["claude-code", "mcp_server", "repin"],
      ["codex", "mcp_server", "repin"],
      ["cursor", "mcp_server", "repin"],
      ["claude-code", "skill", "replace"],
      ["codex+cursor", "skill", "replace"],
    ]);
    expect(await read(codexFile())).toContain(box.script("2.0.0"));
    expect(await read(cursorFile())).toContain(box.script("2.0.0"));
    expect(
      box
        .claudeCalls()
        .slice(-2)
        .map((args) => args[1]),
    ).toEqual(["remove", "add"]);
    expect(await read(path.join(agentsSkill(), "SKILL.md"))).toBe(`${SKILL_TEXT}Version 2.\n`);
    expect((await readdir(path.join(box.ufoHome, "pkg"))).sort()).toEqual(["1.2.3", "2.0.0"]);
    expect((await update(v2())).changed).toBe(false);
    await uninstall(options());
    expect(await read(codexFile())).toBe("a = 1\n");
    expect(await read(cursorFile())).toBe("{}\n");
    expect(await readdir(path.join(box.ufoHome, "pkg"))).toEqual([]);
  });

  it("after a host edit, uninstall removes the re-pinned entry instead of restoring the backup", async () => {
    await put(cursorFile(), '{\n  "mcpServers": {}\n}\n');
    await setup(options({ hosts: ["cursor"] }));
    const edited = (await read(cursorFile())).replace(
      '{\n  "mcpServers"',
      '{\n  "theme": "light",\n  "mcpServers"',
    );
    await writeFile(cursorFile(), edited);
    await update(v2());
    await uninstall(options());
    expect(await read(cursorFile())).toBe('{\n  "theme": "light",\n  "mcpServers": {}\n}\n');
  });

  it("forgets an entry or skill someone removed instead of adding it back", async () => {
    await put(codexFile(), "a = 1\n");
    await setup(options({ hosts: ["codex"] }));
    await writeFile(codexFile(), "a = 1\n");
    await rm(agentsSkill(), { recursive: true });
    const report = await update(v2());
    expect(report.unchanged.map((u) => [u.kind, u.reason])).toEqual(
      expect.arrayContaining([
        [
          "mcp_server",
          "has no ufo server any more; UFO forgets it (run ufo setup to add it again)",
        ],
        ["skill", "is gone; UFO forgets it (run ufo setup to install it again)"],
      ]),
    );
    expect(await read(codexFile())).toBe("a = 1\n");
    expect(existsSync(agentsSkill())).toBe(false);
    expect((await record()).hosts).toEqual({});
    expect((await record()).skills).toEqual({});
  });

  it("records the new skill files when the directory already holds them", async () => {
    await mkdir(path.join(box.home, ".codex"));
    await setup(options({ hosts: ["codex"] }));
    // The skill directory already holds 2.0.0's files (say, copied by hand).
    await writeFile(path.join(agentsSkill(), "SKILL.md"), `${SKILL_TEXT}Version 2.\n`);
    const report = await update(v2());
    expect(report.unchanged.find((u) => u.kind === "skill")?.reason).toBe("up to date");
    await uninstall(options());
    expect(existsSync(agentsSkill())).toBe(false);
  });

  it("refuses when UFO set nothing up, naming a requested host", async () => {
    expect((await refusal(update(options()))).message).toBe(
      "UFO has not set up any host; run ufo setup",
    );
    expect((await refusal(update(options({ hosts: ["cursor"] })))).message).toBe(
      "UFO has not set up Cursor; run ufo setup",
    );
  });
});
