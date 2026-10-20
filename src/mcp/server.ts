// `ufo mcp`: UFO's tools over stdio. stdout carries only protocol messages; logs go to stderr.

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type AppContext, packageVersion } from "../app/api.js";
import { registerTools } from "./tools.js";

/**
 * How long a tool call waits for another control operation on its run before it fails `busy`:
 * with `get_job`'s 25 s wait the longest call, it keeps every call under the 60 s Codex and
 * Cursor give a tool.
 */
export const MCP_CONTROL_LOCK_WAIT_MS = 20_000;

/**
 * The repository a tool call acts on when it names none: `--repo` (Cursor passes
 * `${workspaceFolder}`), else `CLAUDE_PROJECT_DIR` (Claude Code sets it), else the working
 * directory (Codex starts servers in the project).
 */
export function defaultRepository(options: {
  readonly repo?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): string {
  const project = options.env.CLAUDE_PROJECT_DIR;
  return path.resolve(
    options.cwd,
    options.repo ?? (project !== undefined && project !== "" ? project : options.cwd),
  );
}

/** The MCP client's name as a host agent id (`claude-code`), or `mcp` when it makes none. */
export function hostAgentOf(name: string | undefined): string {
  const id = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) ? id : "mcp";
}

export interface McpServeOptions {
  /** The repository of calls that name none (`defaultRepository`). */
  readonly repo: string;
  /**
   * The rest of every call's app context, fixed for the server's life: the UFO home, card
   * directories, worker entry, environment source, command runner, and resolver. No tool
   * parameter sets any of them (safety.md R6).
   */
  readonly context?: Omit<AppContext, "cwd" | "controlLockWaitMs"> | undefined;
  readonly log: (line: string) => void;
}

/** One server instance with every UFO tool registered. */
export function createServer(options: McpServeOptions): McpServer {
  const server = new McpServer(
    { name: "ufo", version: packageVersion() },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    context: (repo) => ({
      ...options.context,
      cwd: repo ?? options.repo,
      controlLockWaitMs: MCP_CONTROL_LOCK_WAIT_MS,
    }),
    hostAgent: () => hostAgentOf(server.server.getClientVersion()?.name),
  });
  return server;
}

/**
 * Serves UFO's tools on this process's stdin and stdout until stdin closes. A 2025-era client's
 * `initialize` is answered too (the SDK's `legacy: 'serve'`), whatever version it asks for.
 */
export async function serveMcp(options: McpServeOptions): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  serveStdio(() => createServer(options), {
    legacy: "serve",
    onerror: (error) => options.log(`ufo mcp: ${error.message}`),
  });
  await closed;
}
