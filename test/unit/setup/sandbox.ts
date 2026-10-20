import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandRunner, SetupEnvironment } from "../../../src/setup/index.js";

// A home directory, UFO home, PATH, and application folder under one temp directory, and a fake
// `claude` that keeps its user-scope servers in <home>/.claude.json the way Claude Code does.
// Nothing touches the real home or runs a real host.

export interface FakeClaude {
  readonly run: CommandRunner;
  /** Every `claude mcp ...` call, as its arguments. */
  readonly calls: string[][];
}

export function fakeClaude(configFile: string): FakeClaude {
  const calls: string[][] = [];
  const done = (code: number, stderr = "") => ({ code, stdout: code === 0 ? "ok\n" : "", stderr });
  const run: CommandRunner = async (file, args) => {
    if (file !== "claude") return { code: 127, stdout: "", stderr: `${file}: not found` };
    if (args[0] === "--version") return { code: 0, stdout: "2.1.304 (Claude Code)\n", stderr: "" };
    calls.push([...args]);
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await readFile(configFile, "utf8"));
    } catch {
      // No config yet.
    }
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    const [mcp, action] = args;
    if (mcp !== "mcp") return done(1, "unknown command");
    if (action === "add") {
      const dash = args.indexOf("--");
      const name = args[dash - 1] ?? "";
      const [command, ...rest] = args.slice(dash + 1);
      if (args[2] !== "--scope" || args[3] !== "user") return done(1, "expected --scope user");
      if (Object.hasOwn(servers, name)) {
        return done(1, `MCP server ${name} already exists in user config`);
      }
      servers[name] = { type: "stdio", command, args: rest, env: {} };
    } else if (action === "remove") {
      const name = args[2] ?? "";
      if (args[3] !== "--scope" || args[4] !== "user") return done(1, "expected --scope user");
      if (!Object.hasOwn(servers, name)) return done(1, `No user-scoped MCP server named ${name}`);
      delete servers[name];
    } else {
      return done(1, `unknown action ${action}`);
    }
    config.mcpServers = servers;
    await writeFile(configFile, JSON.stringify(config, null, 2));
    return done(0);
  };
  return { run, calls };
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly ufoHome: string;
  readonly claude: FakeClaude;
  readonly environment: SetupEnvironment;
  cleanup(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-setup-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const applications = path.join(root, "Applications");
  for (const dir of [home, bin, applications]) await mkdir(dir, { mode: 0o700 });
  const ufoHome = path.join(root, "ufo-home");
  const claude = fakeClaude(path.join(home, ".claude.json"));
  return {
    root,
    home,
    bin,
    ufoHome,
    claude,
    environment: {
      home,
      ufoHome,
      env: { PATH: bin },
      run: claude.run,
      applications,
      version: "1.2.3",
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Puts an executable `name` on the sandbox PATH. */
export async function onPath(box: Sandbox, name: string): Promise<void> {
  const file = path.join(box.bin, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}

/** Writes `text` to `file` under the sandbox, creating its directory. */
export async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
