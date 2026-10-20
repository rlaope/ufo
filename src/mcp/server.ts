// `ufo mcp`: UFO's tools over stdio, bound to one repository for the server's whole life.
// stdout carries only protocol messages; logs go to stderr.

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  type AppContext,
  packageVersion,
  type Repo,
  refuseChangedRepository,
  refuseForeignGitDir,
  trustProcessPath,
} from "../app/api.js";
import { registerTools } from "./tools.js";

/**
 * How long a tool call waits for another control operation on its run before it fails `busy`:
 * with `get_job`'s 25 s wait the longest call, it keeps every call under the 60 s Codex and
 * Cursor give a tool.
 */
export const MCP_CONTROL_LOCK_WAIT_MS = 20_000;

/** The hosts `ufo mcp --host` serves; also the run's host agent. */
export const HOSTS = ["claude-code", "codex", "cursor"] as const;
export type Host = (typeof HOSTS)[number];

export function isHost(value: unknown): value is Host {
  return HOSTS.some((host) => host === value);
}

/**
 * The directory the server binds to (plan: repository binding): `--repo` when given, which must
 * be an absolute path as the host wrote it (a `${workspaceFolder}` the host did not substitute,
 * or a relative path, is refused, never resolved against the working directory); else, for
 * Claude Code, `CLAUDE_PROJECT_DIR`, then the working directory; for Codex, the working
 * directory. Cursor needs `--repo`.
 */
export function bindDirectory(options: {
  readonly host: Host;
  readonly repo?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): { dir: string } | { error: string } {
  const absolute = (value: string, what: string) =>
    !value.includes("${") && path.isAbsolute(value)
      ? { dir: value }
      : { error: `${what} must be an absolute path, not ${JSON.stringify(value)}` };
  if (options.repo !== undefined) return absolute(options.repo, "--repo");
  if (options.host === "cursor") return { error: "--host cursor needs --repo <absolute path>" };
  const project = options.env.CLAUDE_PROJECT_DIR;
  if (options.host === "claude-code" && project !== undefined && project !== "") {
    return absolute(project, "CLAUDE_PROJECT_DIR");
  }
  return { dir: options.cwd };
}

export interface McpServeOptions {
  /** The directory to bind to (`bindDirectory`); the server acts on the repository there. */
  readonly dir: string;
  readonly host: Host;
  /**
   * The rest of every call's app context, fixed for the server's life: the UFO home, card
   * directories, worker entry, environment source, command runner, and resolver. No tool
   * argument sets any of them (safety.md R6).
   */
  readonly context?: Omit<AppContext, "cwd" | "controlLockWaitMs"> | undefined;
  readonly log: (line: string) => void;
}

/** One server instance with every UFO tool registered, acting on the pinned repository. */
export function createServer(options: McpServeOptions & { readonly repo: Repo }): McpServer {
  const server = new McpServer(
    { name: "ufo", version: packageVersion() },
    { capabilities: { tools: {} } },
  );
  const context: AppContext = {
    ...options.context,
    cwd: options.repo.root,
    controlLockWaitMs: MCP_CONTROL_LOCK_WAIT_MS,
  };
  registerTools(server, {
    context,
    hostAgent: options.host,
    // Before every call: the repository is still the one pinned at startup.
    guard: () => refuseChangedRepository(options.repo, "ufo mcp"),
  });
  return server;
}

/**
 * Serves UFO's tools on this process's stdin and stdout until stdin closes, bound to the
 * repository at `dir` (its real top level). The PATH is filtered first, before UFO runs git to
 * find that repository. A 2025-era client's `initialize` is answered too (the SDK's
 * `legacy: 'serve'`), whatever version it asks for.
 */
export async function serveMcp(options: McpServeOptions): Promise<void> {
  const repo = await trustProcessPath({
    cwd: process.cwd(),
    repoDir: options.dir,
    home: options.context?.home,
    requireRepo: true,
  });
  if (repo === undefined) throw new Error(`${options.dir} is not inside a git working tree`);
  await refuseForeignGitDir(repo);
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  serveStdio(() => createServer({ ...options, repo }), {
    legacy: "serve",
    onerror: (error) => options.log(`ufo mcp: ${error.message}`),
  });
  await closed;
}
