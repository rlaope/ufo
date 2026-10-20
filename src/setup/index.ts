import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askTerminal } from "../app/terminal.js";
import { ufoHome } from "../core/paths.js";
import { PolicyError } from "../core/policy/index.js";
import { SetupError } from "./errors.js";
import { formatSetupPlan } from "./format.js";
import {
  type CommandRunner,
  type DetectedHost,
  detectHosts,
  HOST_NAMES,
  type HostId,
  hostPaths,
  processRunner,
  tilde,
} from "./hosts.js";
import {
  type ChangeView,
  hostNames,
  type PlanContext,
  planChanges,
  recordedHosts,
  type UnchangedView,
} from "./plan.js";
import { readSkillSource } from "./skills.js";
import { backupsDir, openStore, readRecord, withSetupLock, writeRecord } from "./store.js";

// `ufo setup`, `ufo uninstall`, `ufo update` (plan §2.7, M2 D): register UFO's MCP server and
// skill with Claude Code, Codex, and Cursor, show every change as a diff, back up each config file
// before the first write, and remove exactly what setup added. Nothing here holds credentials.

export { SetupError } from "./errors.js";
export { formatSetupPlan, formatSetupReport } from "./format.js";
export {
  type CommandResult,
  type CommandRunner,
  type DetectedHost,
  HOST_IDS,
  type HostId,
  parseHostIds,
} from "./hosts.js";
export type { ChangeAction, ChangeView, UnchangedView } from "./plan.js";

export type SetupCommand = "setup" | "uninstall" | "update";

/** Where setup looks and what it runs. Production uses the defaults; tests pass their own. */
export interface SetupEnvironment {
  /** The user's home directory; every host path derives from it. Default: `os.homedir()`. */
  readonly home?: string;
  /** `$UFO_HOME`, where setup keeps its record and backups. Default: `UFO_HOME`, else `<home>/.ufo`. */
  readonly ufoHome?: string;
  /** `PATH` for detection, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `UFO_HOME`. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Runs `claude`. Default: `execFile` with `env`. */
  readonly run?: CommandRunner;
  /** Where macOS apps live. Default: `/Applications`. */
  readonly applications?: string;
  /** The `ufo-agents` version entries pin. Default: this package's version. */
  readonly version?: string;
  /** The skill directory to install. Default: this package's `skills/ufo-optimize`. */
  readonly skillSource?: string;
}

export interface SetupOptions extends SetupEnvironment {
  /** Only these hosts (`--host`). Default: setup, every host found; the others, every host set up. */
  readonly hosts?: readonly HostId[];
  /** Apply without asking (`--yes`). */
  readonly yes?: boolean;
  /** Where the planned changes are printed before the question. */
  readonly print: (text: string) => void;
  /** Asks the human; default: the controlling terminal (`/dev/tty`). */
  readonly confirm?: (prompt: string) => Promise<string>;
}

export interface SetupReport {
  readonly command: SetupCommand;
  /** The `ufo-agents` version the entries pin. */
  readonly version: string;
  /** The hosts acted on. */
  readonly hosts: HostId[];
  /** `ufo setup`: every host and whether it was found. */
  readonly detected?: DetectedHost[];
  readonly changes: ChangeView[];
  readonly unchanged: UnchangedView[];
  /** False when there was nothing to change (a second `ufo setup`). */
  readonly changed: boolean;
  /** Where the backups of edited config files are. */
  readonly backups: string;
  readonly notes: string[];
}

// Resolves to the package root from both src/setup and dist/setup.
const PACKAGE_ROOT = new URL("../../", import.meta.url);

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL("package.json", PACKAGE_ROOT), "utf8"));
  if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
    const { version } = pkg;
    if (typeof version === "string") return version;
  }
  throw new Error("package.json has no version field");
}

function terminalConfirm(command: SetupCommand) {
  return async (prompt: string) => {
    try {
      return await askTerminal(prompt);
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      throw new SetupError(
        "no_terminal",
        `no terminal to ask on; run ufo ${command} in a terminal, or pass --yes`,
      );
    }
  };
}

function selectFound(detected: readonly DetectedHost[], requested?: readonly HostId[]): HostId[] {
  if (requested !== undefined) {
    for (const id of requested) {
      if (detected.find((host) => host.id === id)?.found !== true) {
        throw new SetupError("host_not_found", `${HOST_NAMES[id]} was not found on this machine`);
      }
    }
    return [...requested];
  }
  const found = detected.filter((host) => host.found).map((host) => host.id);
  if (found.length === 0) {
    throw new SetupError(
      "host_not_found",
      "found none of Claude Code, Codex, or Cursor; install one, then run ufo setup again",
    );
  }
  return found;
}

function notes(command: SetupCommand, hosts: readonly HostId[], changes: readonly ChangeView[]) {
  const out: string[] = [];
  const reloaded = [
    ...new Set(changes.filter((c) => c.kind === "mcp_server").flatMap((c) => c.hosts)),
  ];
  if (reloaded.length > 0) {
    out.push(`Restart ${hostNames(reloaded)} (or reconnect with /mcp) to load the change.`);
  }
  if (command !== "uninstall" && hosts.includes("claude-code") && hosts.includes("cursor")) {
    out.push("Cursor also reads ~/.claude/skills, so it may list the ufo-optimize skill twice.");
  }
  return out;
}

async function execute(command: SetupCommand, options: SetupOptions): Promise<SetupReport> {
  const env = options.env ?? process.env;
  const home = path.resolve(options.home ?? os.homedir());
  const store = await openStore(
    options.ufoHome ?? (env.UFO_HOME ? ufoHome(env) : path.join(home, ".ufo")),
  );
  const ctx: PlanContext = {
    paths: hostPaths(home, env),
    run: options.run ?? processRunner(env),
    version: options.version ?? packageVersion(),
    store,
    skill: await readSkillSource(
      options.skillSource ?? fileURLToPath(new URL("skills/ufo-optimize/", PACKAGE_ROOT)),
    ),
  };
  return withSetupLock(store, async () => {
    const record = await readRecord(store);
    let detected: DetectedHost[] | undefined;
    let hosts: HostId[];
    if (command === "setup") {
      detected = await detectHosts({
        paths: ctx.paths,
        env,
        run: ctx.run,
        applications: options.applications ?? "/Applications",
      });
      hosts = selectFound(detected, options.hosts);
    } else {
      const recorded = recordedHosts(record);
      hosts = recorded.filter((host) => options.hosts?.includes(host) ?? true);
      if (command === "update" && hosts.length === 0) {
        throw new SetupError("not_set_up", "UFO has not set up any of these hosts; run ufo setup");
      }
    }
    const plan = await planChanges(
      ctx,
      hosts,
      record,
      command === "uninstall" ? "remove" : "install",
    );
    const changes = plan.steps.map((step) => step.view);
    const report: SetupReport = {
      command,
      version: ctx.version,
      hosts,
      ...(detected === undefined ? {} : { detected }),
      changes,
      unchanged: plan.unchanged,
      changed: changes.length > 0,
      backups: tilde(backupsDir(store), home),
      notes: notes(command, hosts, changes),
    };
    if (changes.length > 0) {
      options.print(formatSetupPlan(report));
      if (options.yes !== true) {
        const confirm = options.confirm ?? terminalConfirm(command);
        const answer = await confirm('Apply these changes? Type "yes": ');
        if (answer.trim() !== "yes") {
          throw new SetupError("approval_declined", "nothing was changed");
        }
      }
    }
    for (const keep of plan.bookkeeping) await keep(record);
    await writeRecord(store, record);
    for (const step of plan.steps) {
      await step.apply(record);
      await writeRecord(store, record);
    }
    return report;
  });
}

/** `ufo setup`: registers the MCP server and installs the skill in every host found. */
export function setup(options: SetupOptions): Promise<SetupReport> {
  return execute("setup", options);
}

/** `ufo uninstall`: removes exactly what setup added; untouched files come back from backup. */
export function uninstall(options: SetupOptions): Promise<SetupReport> {
  return execute("uninstall", options);
}

/** `ufo update`: re-pins the hosts setup configured to this version and refreshes the skill. */
export function update(options: SetupOptions): Promise<SetupReport> {
  return execute("update", options);
}
