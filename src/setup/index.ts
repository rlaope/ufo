import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFailure, packageVersion, trustProcessPath } from "../app/api.js";
import { askTerminal, ufoHome } from "../app/api-cli.js";
import { SetupError } from "./errors.js";
import { formatSetupPlan } from "./format.js";
import {
  type CommandRunner,
  type DetectedHost,
  detectHosts,
  findExecutable,
  HOST_IDS,
  HOST_NAMES,
  type HostId,
  hostPaths,
  processRunner,
  tilde,
} from "./hosts.js";
import {
  compareVersions,
  type Fetcher,
  httpFetcher,
  launchFor,
  nodeCommand,
  PACKAGE_NAME,
  prefixFor,
  registrySource,
  tarballSource,
} from "./package.js";
import {
  type ChangeView,
  hostNames,
  type PlanContext,
  planChanges,
  recordedHosts,
  type UnchangedView,
} from "./plan.js";
import {
  backupsDir,
  openStore,
  readRecord,
  type SetupRecord,
  withSetupLock,
  writeRecord,
} from "./store.js";

// `ufo setup`, `ufo uninstall`, `ufo update` (plan §2.7, M2 D): install one exact version of UFO
// into UFO's home, register its MCP server and skill with Claude Code, Codex, and Cursor, show
// every change, back up each config file before the first write, and remove exactly what setup
// added. Nothing here holds credentials.

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
export type { Fetcher } from "./package.js";
export type { ChangeAction, ChangeKind, ChangeView, UnchangedView } from "./plan.js";

export type SetupCommand = "setup" | "uninstall" | "update";

/** Where setup looks and what it runs. Production uses the defaults; tests pass their own. */
export interface SetupEnvironment {
  /** The user's home directory; every host path derives from it. Default: `os.homedir()`. */
  readonly home?: string;
  /** `$UFO_HOME`, where setup keeps its record, backups, and packages. Default: `UFO_HOME`, else `<home>/.ufo`. */
  readonly ufoHome?: string;
  /** `PATH` (filtered before use), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `UFO_HOME`. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The working directory, whose project is kept off `PATH`. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Runs `claude` and `npm`. Default: `execFile`. */
  readonly run?: CommandRunner;
  /** Fetches the registry's metadata. Default: `fetch`. */
  readonly fetch?: Fetcher;
  /** Where macOS apps live. Default: `/Applications`. */
  readonly applications?: string;
  /** The version to install from the registry. Default: this package's version. */
  readonly version?: string;
  /** This version's skill directory. Default: this package's `skills/ufo-optimize`. */
  readonly skillSource?: string;
  /** The node binary hosts start when no `node` on PATH is it. Default: `process.execPath`. */
  readonly execPath?: string;
  /** How long to wait for another setup, uninstall, or update. Default: 10 s. */
  readonly lockWaitMs?: number;
}

export interface SetupOptions extends SetupEnvironment {
  /** Only these hosts (`--host`). Default: setup, every host found; the others, every host set up. */
  readonly hosts?: readonly HostId[];
  /** Apply without asking (`--yes`); a downgrade is still asked. */
  readonly yes?: boolean;
  /** `--package`: install this `ufo-agents` tarball instead of the registry's version. */
  readonly package?: string;
  /** Where the planned changes are printed before the question. */
  readonly print: (text: string) => void;
  /** Asks the person; default: the controlling terminal (`/dev/tty`). */
  readonly confirm?: (prompt: string) => Promise<string>;
}

export interface SetupReport {
  readonly command: SetupCommand;
  /** The `ufo-agents` version hosts start (setup, update). */
  readonly version?: string;
  /** The hosts acted on. */
  readonly hosts: HostId[];
  /** `ufo setup`: each host probed, whether it was found, and the evidence. */
  readonly detected?: DetectedHost[];
  /** `--host` names UFO has not set up (uninstall, update). */
  readonly notSetUp: HostId[];
  readonly changes: ChangeView[];
  readonly unchanged: UnchangedView[];
  /** False when there was nothing to change (a second `ufo setup`). */
  readonly changed: boolean;
  /** Where the backups of edited config files are. */
  readonly backups: string;
  readonly notes: string[];
}

const SKILL_SOURCE = fileURLToPath(new URL("../../skills/ufo-optimize/", import.meta.url));
const LOCK_WAIT_MS = 10_000;

/** Asks on the controlling terminal; `no_terminal` when there is none. */
export function terminalConfirm(
  command: SetupCommand,
  ask: (prompt: string) => Promise<string> = askTerminal,
) {
  return async (prompt: string) => {
    try {
      return await ask(prompt);
    } catch (error) {
      if (describeFailure(error).code !== "policy:non_tty_approval") throw error;
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

function notes(command: SetupCommand, report: Omit<SetupReport, "notes">): string[] {
  const out: string[] = [];
  const reloaded = [
    ...new Set(report.changes.filter((c) => c.kind === "mcp_server").flatMap((c) => c.hosts)),
  ];
  if (reloaded.length > 0) {
    out.push(`Restart ${hostNames(reloaded)} (or reconnect with /mcp) to load the change.`);
  }
  if (
    command !== "uninstall" &&
    report.hosts.includes("claude-code") &&
    report.hosts.includes("cursor")
  ) {
    out.push("Cursor also reads ~/.claude/skills, so it may list the ufo-optimize skill twice.");
  }
  if (report.notSetUp.length > 0 && report.hosts.length > 0) {
    out.push(`UFO has not set up ${hostNames(report.notSetUp)}.`);
  }
  return out;
}

/** The newest version any of `hosts` starts now. */
function newestVersion(record: SetupRecord, hosts: readonly HostId[]): string | undefined {
  const versions = hosts.flatMap((host) => {
    const version = record.hosts[host]?.version;
    return version === undefined ? [] : [version];
  });
  return versions.sort(compareVersions).at(-1);
}

async function execute(command: SetupCommand, options: SetupOptions): Promise<SetupReport> {
  const home = path.resolve(options.home ?? os.homedir());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = { ...(options.env ?? process.env) };
  const ufoHomePath = options.ufoHome ?? (env.UFO_HOME ? ufoHome(env) : path.join(home, ".ufo"));
  // The rules every ufo process applies before it runs anything (safety.md R3b), on a copy.
  await trustProcessPath({ cwd, home: ufoHomePath, env });
  const store = await openStore(ufoHomePath);
  const run = options.run ?? processRunner;
  const paths = hostPaths(home, env);
  return withSetupLock(store.dir, options.lockWaitMs ?? LOCK_WAIT_MS, async () => {
    const record = await readRecord(store.dir);
    let detected: DetectedHost[] | undefined;
    let hosts: HostId[];
    let notSetUp: HostId[] = [];
    let claude: string | undefined;
    if (command === "setup") {
      const scope = options.hosts ?? HOST_IDS;
      if (scope.includes("claude-code")) claude = await findExecutable("claude", env);
      detected = await detectHosts(scope, {
        paths,
        env,
        run,
        applications: options.applications ?? "/Applications",
        claude,
      });
      hosts = selectFound(detected, options.hosts);
    } else {
      const recorded = recordedHosts(record);
      hosts = recorded.filter((host) => options.hosts?.includes(host) ?? true);
      notSetUp = (options.hosts ?? []).filter((host) => !recorded.includes(host));
      if (command === "update" && hosts.length === 0) {
        const which = notSetUp.length > 0 ? hostNames(notSetUp) : "any host";
        throw new SetupError("not_set_up", `UFO has not set up ${which}; run ufo setup`);
      }
      if (hosts.includes("claude-code")) claude = await findExecutable("claude", env);
    }
    let install: PlanContext["install"];
    if (command !== "uninstall") {
      const source =
        options.package === undefined
          ? await registrySource(
              options.version ?? packageVersion(),
              options.fetch ?? httpFetcher,
              options.skillSource ?? SKILL_SOURCE,
            )
          : await tarballSource(path.resolve(cwd, options.package));
      const node = await nodeCommand(env, options.execPath ?? process.execPath);
      install = { source, launch: launchFor(prefixFor(store.pkgRoot, source.version), node) };
    }
    const ctx: PlanContext = {
      paths,
      run,
      env,
      store,
      claude,
      npm: install === undefined ? undefined : await findExecutable("npm", env),
      ...(install === undefined ? {} : { install }),
    };
    const plan = await planChanges(
      ctx,
      hosts,
      record,
      command === "uninstall" ? "remove" : command,
    );
    const changes = plan.steps.map((step) => step.view);
    const base = {
      command,
      ...(install === undefined ? {} : { version: install.source.version }),
      hosts,
      ...(detected === undefined ? {} : { detected }),
      notSetUp,
      changes,
      unchanged: plan.unchanged,
      changed: changes.length > 0,
      backups: tilde(backupsDir(store.dir), home),
    };
    const report: SetupReport = { ...base, notes: notes(command, base) };
    if (changes.length > 0) {
      options.print(formatSetupPlan(report));
      const confirm = options.confirm ?? terminalConfirm(command);
      const newest = newestVersion(record, hosts);
      if (install !== undefined && newest !== undefined) {
        if (compareVersions(install.source.version, newest) < 0) {
          // Security L1: --yes does not cover going back to an older version.
          const answer = await confirm(
            `${PACKAGE_NAME}@${newest} is set up; type "downgrade" to replace it with the older ${install.source.version}: `,
          );
          if (answer.trim() !== "downgrade") {
            throw new SetupError("approval_declined", `nothing was changed; ${newest} stays`);
          }
        }
      }
      if (options.yes !== true) {
        const answer = await confirm('Apply these changes? Type "yes": ');
        if (answer.trim() !== "yes") {
          throw new SetupError("approval_declined", "nothing was changed");
        }
      }
    }
    const save = (target: SetupRecord) => writeRecord(store.dir, target);
    for (const keep of plan.bookkeeping) await keep(record);
    await save(record);
    for (const step of plan.steps) {
      try {
        await step.apply(record, save);
      } finally {
        // A failed step leaves the record saying what it did, and what it undid.
        await save(record);
      }
    }
    return report;
  });
}

/** `ufo setup`: installs UFO and registers its MCP server and skill in every host found. */
export function setup(options: SetupOptions): Promise<SetupReport> {
  return execute("setup", options);
}

/** `ufo uninstall`: removes exactly what setup added; untouched files come back from backup. */
export function uninstall(options: SetupOptions): Promise<SetupReport> {
  return execute("uninstall", options);
}

/** `ufo update`: installs this version beside the old one and points the hosts at it. */
export function update(options: SetupOptions): Promise<SetupReport> {
  return execute("update", options);
}
