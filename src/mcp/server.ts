// `ufo mcp`: UFO's tools over stdio, bound to one repository for the server's whole life.
// stdout carries only protocol messages; logs go to stderr.

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  type AppContext,
  bindRepository,
  packageVersion,
  type Repo,
  refuseChangedRepository,
  refuseHomeDirectory,
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

/** Where the bound directory came from: `--repo`, `CLAUDE_PROJECT_DIR`, or the working directory. */
export type BoundFrom = "repo-flag" | "project-env" | "cwd";

/** How a message names the setting the bound directory came from. */
const FROM_NAMES: Record<BoundFrom, string> = {
  "repo-flag": "--repo",
  "project-env": "CLAUDE_PROJECT_DIR",
  cwd: "the working directory",
};

/**
 * The directory the server binds to (plan: repository binding), with where it came from:
 * `--repo` when given, which must be an absolute path as the host wrote it (a
 * `${workspaceFolder}` the host did not substitute, or a relative path, is refused, never
 * resolved against the working directory); else, for Claude Code, `CLAUDE_PROJECT_DIR`, then the
 * working directory; for Codex, the working directory. Cursor needs `--repo`. Only that
 * directory is the session's: a host that names it may start its servers anywhere (Claude Code
 * launched from the desktop with `/`), so the working directory counts only when it is the one.
 */
export function bindDirectory(options: {
  readonly host: Host;
  readonly repo?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): { dir: string; from: BoundFrom } | { error: string } {
  const absolute = (value: string, from: BoundFrom) =>
    !value.includes("${") && path.isAbsolute(value)
      ? { dir: value, from }
      : { error: `${FROM_NAMES[from]} must be an absolute path, not ${JSON.stringify(value)}` };
  if (options.repo !== undefined) return absolute(options.repo, "repo-flag");
  if (options.host === "cursor") return { error: "--host cursor needs --repo <absolute path>" };
  const project = options.env.CLAUDE_PROJECT_DIR;
  if (options.host === "claude-code" && project !== undefined && project !== "") {
    return absolute(project, "project-env");
  }
  return { dir: options.cwd, from: "cwd" };
}

export interface McpServeOptions {
  /** The directory to bind to (`bindDirectory`); the server acts on the repository there. */
  readonly dir: string;
  /** Where `dir` came from (`bindDirectory`), for the messages that name it. */
  readonly from: BoundFrom;
  readonly host: Host;
  /**
   * The rest of every call's app context, fixed for the server's life: the UFO home, card
   * directories, worker entry, environment source, command runner, and resolver. No tool
   * argument sets any of them (safety.md R6).
   */
  readonly context?: Omit<AppContext, "cwd" | "controlLockWaitMs" | "repo"> | undefined;
  /** The environment whose PATH is filtered; `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly log: (line: string) => void;
}

/**
 * The repository the server acts on: pinned when it is first found, at startup or, outside a
 * repository then, on the first call that finds one (`bind`); before every call after that, it
 * must still be the one pinned (security N1).
 */
export interface Binding {
  readonly root: () => string;
  /** The pinned repository, which every call's workflow acts on (code review R4). */
  readonly repo: () => Repo | undefined;
  readonly guard: () => Promise<void>;
}

export function bindingFor(
  dir: string,
  repo: Repo | undefined,
  bind: () => Promise<Repo | undefined>,
): Binding {
  let pinned = repo;
  // Calls that arrive together before the first bind share it; one that failed is tried again.
  let binding: Promise<Repo | undefined> | undefined;
  return {
    root: () => pinned?.root ?? dir,
    repo: () => pinned,
    guard: async () => {
      if (pinned === undefined) {
        binding ??= bind().finally(() => {
          binding = undefined;
        });
        pinned = await binding;
        return;
      }
      await refuseChangedRepository(pinned, "ufo mcp");
    },
  };
}

/** One server instance with every UFO tool registered, acting on the bound repository. */
export function createServer(options: McpServeOptions & { readonly binding: Binding }): McpServer {
  const server = new McpServer(
    { name: "ufo", version: packageVersion() },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    context: () => {
      const repo = options.binding.repo();
      return {
        ...options.context,
        cwd: options.binding.root(),
        ...(repo === undefined ? {} : { repo }),
        controlLockWaitMs: MCP_CONTROL_LOCK_WAIT_MS,
      };
    },
    hostAgent: options.host,
    guard: options.binding.guard,
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
  const bind = async (requireRepo: boolean) => {
    // The working directory is the session's only when it is the bound one (`bindDirectory`).
    const { repo, dropped } = await bindRepository({
      dir: options.dir,
      cwd: options.dir,
      home: options.context?.home,
      requireRepo,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    // So a host's log says why a program on its PATH is not found.
    if (dropped.length > 0) {
      const shown = dropped.map((entry) => (entry === "" ? '""' : entry)).join(path.delimiter);
      options.log(`ufo mcp: left out of PATH, so nothing there runs: ${shown}`);
    }
    return repo;
  };
  const binding = await refuseHomeDirectory(options.dir, FROM_NAMES[options.from]).then(
    async () => {
      // A user-scope server starts in every session, a repository or not: outside one, or in one
      // at your home (no project, `resolveRepo`), it answers every tool with not_a_repo until the
      // folder is a project (code review CR-N8, R5).
      const repo = await bind(false);
      if (repo === undefined) {
        options.log(
          `ufo mcp: ${options.dir} is in no project's git working tree; every tool answers not_a_repo until it is`,
        );
      }
      return bindingFor(options.dir, repo, () => bind(true));
    },
    // At your home or above it, no git runs and every tool answers not_a_repo (security S2-2).
    (error: unknown): Binding => {
      options.log(`ufo mcp: ${error instanceof Error ? error.message : String(error)}`);
      return {
        root: () => options.dir,
        repo: () => undefined,
        guard: () => Promise.reject(error),
      };
    },
  );
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  serveStdio(() => createServer({ ...options, binding }), {
    legacy: "serve",
    onerror: (error) => options.log(`ufo mcp: ${error.message}`),
  });
  await closed;
}
