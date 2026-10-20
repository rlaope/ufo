import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SetupError } from "./errors.js";

// The three hosts setup knows (plan M2 B0): where each keeps its MCP servers and skills, how to
// tell it is installed, and the `ufo` entry UFO writes for it. Every path derives from the
// environment's `home` (and the host's own config-directory variable), so tests never touch the
// real home. Programs are found as absolute paths on a PATH the caller already filtered.

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
/** Codex waits 10 s for a server to start by default; a cold start can take longer. */
const CODEX_STARTUP_TIMEOUT_SEC = 60;
/** Cursor's variable for the open workspace, which Cursor substitutes in `args`. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's syntax, not a JS template.
const CURSOR_WORKSPACE = "${workspaceFolder}";

export interface CommandResult {
  /** The exit status; 127 when the program could not be started. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

/** Runs a program given by absolute path, without a shell. Never rejects for a failed command. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<CommandResult>;

export const processRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 16 << 20 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === "number" ? error.code : 127;
        resolve({ code, stdout, stderr: stderr || error.message });
      },
    );
  });

/**
 * The first executable regular file `name` in the absolute entries of `env.PATH`, which the
 * caller filtered like every `ufo` process does (no relative or empty entry, none in the working
 * directory or the project, none with a `node_modules` segment).
 */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
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

/** What a host starts: an absolute node and the installed package's CLI. */
export interface Launch {
  readonly node: string;
  readonly script: string;
}

/** The `ufo` entry UFO writes for `host`: `ufo mcp --host <host>` from the installed package. */
export function desiredEntry(host: HostId, launch: Launch): Record<string, unknown> {
  const args = [launch.script, "mcp", "--host", host];
  switch (host) {
    case "claude-code":
      return { command: launch.node, args };
    case "codex":
      return { command: launch.node, args, startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC };
    case "cursor":
      // No host documents a stdio server's working directory; Cursor substitutes the workspace.
      return {
        type: "stdio",
        command: launch.node,
        args: [...args, "--repo", CURSOR_WORKSPACE],
      };
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

async function present(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export interface DetectOptions {
  readonly paths: HostPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly run: CommandRunner;
  /** macOS application directory; `/Applications` in production. */
  readonly applications: string;
  /** `claude` on the filtered PATH, if any. */
  readonly claude: string | undefined;
}

/** One line of a program's output, at most 80 characters. */
function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

async function evidenceFor(host: HostId, options: DetectOptions): Promise<string[]> {
  const { paths, env, applications } = options;
  const home = paths.home;
  const found: string[] = [];
  const program = async (name: string) => {
    const file = await findExecutable(name, env);
    if (file !== undefined) found.push(`${name} at ${tilde(file, home)}`);
  };
  const dir = async (label: string, file: string) => {
    if (await present(file)) found.push(label);
  };
  switch (host) {
    case "claude-code": {
      if (options.claude === undefined) return found;
      const version = await options.run(options.claude, ["--version"], {
        cwd: home,
        env,
        timeoutMs: 30_000,
      });
      if (version.code === 0) {
        found.push(`claude at ${tilde(options.claude, home)} (${firstLine(version.stdout)})`);
      }
      return found;
    }
    case "codex":
      await program("codex");
      await dir(
        "the codex CLI in ChatGPT.app",
        path.join(applications, "ChatGPT.app/Contents/Resources/codex-cli/bin/codex"),
      );
      await dir(tilde(path.dirname(paths.codexConfig), home), path.dirname(paths.codexConfig));
      return found;
    case "cursor":
      await program("agent");
      await program("cursor-agent");
      await dir("Cursor.app", path.join(applications, "Cursor.app"));
      await dir("~/.cursor", path.join(home, ".cursor"));
      return found;
  }
}

/**
 * Which of `hosts` are installed (plan M2 B0); only those are probed. Claude Code: its `claude`
 * answers `--version` (setup needs its CLI). Codex: `codex` on PATH, the CLI inside ChatGPT.app,
 * or ~/.codex. Cursor: `agent` or `cursor-agent` on PATH, Cursor.app, or ~/.cursor.
 */
export async function detectHosts(
  hosts: readonly HostId[],
  options: DetectOptions,
): Promise<DetectedHost[]> {
  const detected: DetectedHost[] = [];
  for (const id of hosts) {
    const evidence = await evidenceFor(id, options);
    detected.push({ id, name: HOST_NAMES[id], found: evidence.length > 0, evidence });
  }
  return detected;
}
