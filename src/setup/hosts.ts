import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { oneLine } from "../core/text.js";
import { SetupError } from "./errors.js";

// The three hosts setup knows (plan M2 B0): where each keeps its MCP servers and skills, how to
// tell it is installed, and the `ufo` entry UFO writes for it. Every path derives from the
// environment's `home` (and the host's own config-directory variable), so tests never touch the
// real home.

export const HOST_IDS = ["claude-code", "codex", "cursor"] as const;
export type HostId = (typeof HOST_IDS)[number];

export const HOST_NAMES: Readonly<Record<HostId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** The MCP server's name in every host's config. */
export const SERVER_NAME = "ufo";
export const SKILL_NAME = "ufo-optimize";
const PACKAGE_NAME = "ufo-agents";
/** Codex waits 10 s for a server to start by default; the first `npx` fetch can take longer. */
const CODEX_STARTUP_TIMEOUT_SEC = 60;
/** Cursor's variable for the open workspace, which Cursor substitutes in `args`. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's syntax, not a JS template.
const CURSOR_WORKSPACE = "${workspaceFolder}";

export interface CommandResult {
  /** The exit status; 127 when the program is not on PATH. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a host's CLI (`claude`). Never rejects for a failed command. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

/** The production runner: `execFile` with `env`, a 60 s timeout, and no shell. */
export function processRunner(env: NodeJS.ProcessEnv): CommandRunner {
  return (file, args) =>
    new Promise((resolve) => {
      execFile(file, [...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code =
          typeof error.code === "number" ? error.code : error.code === "ENOENT" ? 127 : 1;
        resolve({ code, stdout, stderr: stderr || error.message });
      });
    });
}

/** Where setup looks and writes, all derived from one home directory and environment. */
export interface HostPaths {
  readonly home: string;
  /** Claude Code's user config (`CLAUDE_CONFIG_DIR`, else ~/.claude.json). Read, never written. */
  readonly claudeJson: string;
  readonly codexConfig: string;
  readonly cursorConfig: string;
  readonly skillDirs: Readonly<Record<HostId, string>>;
}

export function hostPaths(home: string, env: NodeJS.ProcessEnv): HostPaths {
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : undefined;
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  // Codex and Cursor both read ~/.agents/skills.
  const agentsSkill = path.join(home, ".agents", "skills", SKILL_NAME);
  return {
    home,
    claudeJson: path.join(claudeDir ?? home, ".claude.json"),
    codexConfig: path.join(codexHome, "config.toml"),
    cursorConfig: path.join(home, ".cursor", "mcp.json"),
    skillDirs: {
      "claude-code": path.join(claudeDir ?? path.join(home, ".claude"), "skills", SKILL_NAME),
      codex: agentsSkill,
      cursor: agentsSkill,
    },
  };
}

/** `file` with the home directory shown as `~` (docs/cli.md). */
export function tilde(file: string, home: string): string {
  const relative = path.relative(home, file);
  if (relative === "") return "~";
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : `~/${relative}`;
}

/** The `ufo` entry UFO writes for `host`, pinned to `version`. */
export function desiredEntry(host: HostId, version: string): Record<string, unknown> {
  const args = ["-y", `${PACKAGE_NAME}@${version}`, "mcp"];
  switch (host) {
    case "claude-code":
      return { command: "npx", args };
    case "codex":
      return { command: "npx", args, startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC };
    case "cursor":
      // No host documents a stdio server's working directory; Cursor substitutes the workspace.
      return { type: "stdio", command: "npx", args: [...args, "--repo", CURSOR_WORKSPACE] };
  }
}

/** `entry` without the defaults hosts add on their own: `"type": "stdio"` and an empty `env`. */
function normalized(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const copy: Record<string, unknown> = { ...entry };
  if (copy.type === "stdio") delete copy.type;
  const env = copy.env;
  if (typeof env === "object" && env !== null && Object.keys(env).length === 0) delete copy.env;
  return copy;
}

/** Whether two entries run the same server (host-added defaults aside). */
export function sameEntry(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(normalized(a), normalized(b));
}

/** Parses `--host` values; refuses an unknown name (`usage`). */
export function parseHostIds(values: readonly string[]): HostId[] {
  for (const value of values) {
    if (!(HOST_IDS as readonly string[]).includes(value)) {
      throw new SetupError("usage", `unknown host ${value}; use ${HOST_IDS.join(", ")}`);
    }
  }
  return HOST_IDS.filter((id) => values.includes(id));
}

export interface DetectedHost {
  readonly id: HostId;
  readonly name: string;
  readonly found: boolean;
  /** What showed the host is installed, e.g. `~/.codex`. */
  readonly evidence: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `name` in `PATH`'s absolute directories. */
async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export interface DetectOptions {
  readonly paths: HostPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly run: CommandRunner;
  /** macOS application directory; `/Applications` in production. */
  readonly applications: string;
}

/**
 * Which hosts are installed (plan M2 B0). Claude Code: `claude --version` succeeds (setup needs
 * its CLI). Codex: `codex` on PATH, the CLI inside ChatGPT.app, or ~/.codex. Cursor: `agent` or
 * `cursor-agent` on PATH, Cursor.app, or ~/.cursor.
 */
export async function detectHosts(options: DetectOptions): Promise<DetectedHost[]> {
  const { paths, env, run, applications } = options;
  const home = paths.home;
  const found = async (checks: [string, Promise<boolean | string | undefined>][]) => {
    const evidence: string[] = [];
    for (const [label, check] of checks) {
      const result = await check;
      if (result === true) evidence.push(label);
      else if (typeof result === "string") evidence.push(`${label} (${tilde(result, home)})`);
    }
    return evidence;
  };
  const claude = await run("claude", ["--version"]);
  const claudeEvidence =
    claude.code === 0 ? [`claude --version: ${oneLine(claude.stdout, 80, "ok")}`] : [];
  const codexEvidence = await found([
    ["codex on PATH", onPath("codex", env)],
    [
      "the codex CLI in ChatGPT.app",
      exists(path.join(applications, "ChatGPT.app/Contents/Resources/codex-cli/bin/codex")),
    ],
    [tilde(path.dirname(paths.codexConfig), home), exists(path.dirname(paths.codexConfig))],
  ]);
  const cursorEvidence = await found([
    ["agent on PATH", onPath("agent", env)],
    ["cursor-agent on PATH", onPath("cursor-agent", env)],
    ["Cursor.app", exists(path.join(applications, "Cursor.app"))],
    ["~/.cursor", exists(path.join(home, ".cursor"))],
  ]);
  const evidence: Record<HostId, string[]> = {
    "claude-code": claudeEvidence,
    codex: codexEvidence,
    cursor: cursorEvidence,
  };
  return HOST_IDS.map((id) => ({
    id,
    name: HOST_NAMES[id],
    found: evidence[id].length > 0,
    evidence: evidence[id],
  }));
}
