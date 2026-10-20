import { isDeepStrictEqual } from "node:util";
import { redact } from "../app/api.js";
import { unifiedDiff } from "./diff.js";
import { SetupError } from "./errors.js";
import { readConfig, removeConfig, sha256, writeConfig } from "./files.js";
import {
  type CommandResult,
  type CommandRunner,
  desiredEntry,
  HOST_IDS,
  HOST_NAMES,
  type HostId,
  type HostPaths,
  howItEnded,
  type Launch,
  SERVER_NAME,
  SKILL_NAME,
  sameEntry,
  tilde,
} from "./hosts.js";
import {
  insertJsonEntry,
  locateJsonEntry,
  removeJsonEntry,
  replaceJsonEntry,
} from "./json-edit.js";
import {
  installedIntegrity,
  installedSkill,
  installPackage,
  PACKAGE_NAME,
  type PackageSource,
  prefixFor,
  REGISTRY,
  removePackage,
} from "./package.js";
import {
  type FileHashes,
  firstDifference,
  hashFiles,
  installSkill,
  readSkillHashes,
  removeSkill,
  sameFiles,
} from "./skills.js";
import { repinEdit, type SpanEdit, undoEdit } from "./span.js";
import {
  type FileState,
  type HostRecord,
  readBackup,
  removeBackup,
  type SetupRecord,
  type Store,
  writeBackup,
} from "./store.js";
import {
  insertTomlEntry,
  locateTomlEntry,
  removeTomlEntry,
  replaceTomlEntry,
} from "./toml-edit.js";

// What setup, update, and uninstall would change, worked out before anything is written. Each
// step re-reads its target before it writes and refuses (`changed_during_setup`) when it is no
// longer what the plan showed, and records the change before it makes it.

export type ChangeKind = "package" | "mcp_server" | "skill";
export type ChangeAction = "install" | "replace" | "add" | "repin" | "remove" | "restore";

export interface ChangeView {
  readonly hosts: HostId[];
  readonly kind: ChangeKind;
  /** The file or directory, with the home directory as `~`. */
  readonly target: string;
  readonly action: ChangeAction;
  /** One line, redacted. */
  readonly detail: string;
  /** The unified diff of a config file edit, redacted. */
  readonly diff?: string;
}

export interface UnchangedView {
  readonly hosts: HostId[];
  readonly kind: ChangeKind;
  readonly target: string;
  readonly reason: string;
}

/** Saves the record now; a step calls it before the write the record describes. */
export type Save = (record: SetupRecord) => Promise<void>;

export interface Step {
  readonly view: ChangeView;
  /** Makes the change and records it in `record`. */
  readonly apply: (record: SetupRecord, save: Save) => Promise<void>;
}

export interface Plan {
  readonly steps: Step[];
  readonly unchanged: UnchangedView[];
  /** Record updates that change no file (an entry someone else removed is forgotten). */
  readonly bookkeeping: ((record: SetupRecord) => Promise<void>)[];
}

export interface PlanContext {
  readonly paths: HostPaths;
  readonly run: CommandRunner;
  /** The environment host CLIs and npm run with; its PATH is filtered. */
  readonly env: NodeJS.ProcessEnv;
  readonly store: Store;
  /** `claude` and `npm` as absolute paths, when in scope and found. */
  readonly claude: string | undefined;
  readonly npm: string | undefined;
  /**
   * Setup and update: the package to install, how hosts start it, and the environment each entry
   * passes (`UFO_HOME` when it is not `~/.ufo`).
   */
  readonly install?: {
    readonly source: PackageSource;
    readonly launch: Launch;
    readonly env?: Readonly<Record<string, string>>;
  };
  /** The run holding the machine lock, if any: its worker may run from an installed copy. */
  readonly runLock?: { readonly runId: string | undefined };
}

export type Mode = "setup" | "update" | "remove";

const changed = (label: string) =>
  new SetupError(
    "changed_during_setup",
    `${label} changed while UFO was working on it; nothing more was written. Run the command again`,
  );

/** The hosts' names, e.g. `Codex and Cursor`. */
export function hostNames(hosts: readonly HostId[]): string {
  const names = hosts.map((host) => HOST_NAMES[host]);
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** Text shown to a person or written to --json: redacted, with the home as `~`. */
function shown(ctx: PlanContext, text: string): string {
  return redact(text, { homeDir: ctx.paths.home });
}

function installing(ctx: PlanContext): NonNullable<PlanContext["install"]> {
  if (ctx.install === undefined) throw new Error("setup and update need a package to install");
  return ctx.install;
}

/** Whether `value` is an entry UFO wrote: the recorded one, or one being written. */
function ownsEntry(owned: HostRecord | undefined, value: unknown): boolean {
  if (owned === undefined) return false;
  return (
    sameEntry(value, owned.entry) ||
    (owned.pending !== undefined && sameEntry(value, owned.pending.entry))
  );
}

interface EntryFormat {
  locate(
    text: string,
    label: string,
  ): { found: false } | { found: true; value: unknown; editable: boolean };
  insert(
    text: string | undefined,
    value: Record<string, unknown>,
    label: string,
  ): { text: string; edit: SpanEdit; parentCreated: boolean };
  replace(
    text: string,
    value: Record<string, unknown>,
    label: string,
  ): { text: string; before: string; after: string };
  remove(text: string, parentCreated: boolean, label: string): string;
}

const CODEX: EntryFormat = {
  locate(text, label) {
    const entry = locateTomlEntry(text, "mcp_servers", SERVER_NAME, label);
    return entry.found
      ? { found: true, value: entry.value, editable: entry.table !== undefined }
      : entry;
  },
  insert: (text, value) => ({
    ...insertTomlEntry(text, "mcp_servers", SERVER_NAME, value),
    parentCreated: false,
  }),
  replace: (text, value, label) => replaceTomlEntry(text, "mcp_servers", SERVER_NAME, value, label),
  remove: (text, _parentCreated, label) => removeTomlEntry(text, "mcp_servers", SERVER_NAME, label),
};

const CURSOR: EntryFormat = {
  locate(text, label) {
    if (text.trim() === "") return { found: false };
    const entry = locateJsonEntry(text, "mcpServers", SERVER_NAME, label);
    return entry.found ? { found: true, value: entry.value, editable: true } : { found: false };
  },
  insert: (text, value, label) => insertJsonEntry(text, "mcpServers", SERVER_NAME, value, label),
  replace: (text, value, label) => replaceJsonEntry(text, "mcpServers", SERVER_NAME, value, label),
  remove: (text, parentCreated, label) =>
    removeJsonEntry(text, "mcpServers", SERVER_NAME, parentCreated, label),
};

/** The host's record, refused when it names another config file (HOME or the host's dir moved). */
function hostRecord(ctx: PlanContext, record: SetupRecord, host: HostId, file: string) {
  const entry = record.hosts[host];
  if (entry !== undefined && entry.path !== file) {
    throw new SetupError(
      "entry_conflict",
      `UFO set up ${HOST_NAMES[host]} in ${tilde(entry.path, ctx.paths.home)}, not ${tilde(file, ctx.paths.home)}; run ufo with the environment it was set up with`,
    );
  }
  return entry;
}

function conflict(owned: boolean, label: string, what: string): SetupError {
  return new SetupError(
    "entry_conflict",
    owned
      ? `${what} in ${label} was changed since setup wrote it; restore it or remove it by hand`
      : `${label} already has ${what} that UFO did not write; remove or rename it, or leave this host out with --host`,
  );
}

function skillConflict(owned: boolean, label: string, difference: string | undefined): SetupError {
  const why = difference === undefined ? "" : ` (${difference})`;
  return new SetupError(
    "entry_conflict",
    owned
      ? `${label} was changed since setup installed it${why}; restore it or remove it by hand`
      : `${label} holds a ${SKILL_NAME} skill that UFO did not install${why}; remove or rename it, or leave this host out with --host`,
  );
}

/**
 * `text` without the `ufo` entry: setup's own edit reversed exactly when the host left it alone,
 * else the entry removed by rule. Either result must parse and hold no `ufo` entry.
 */
function withoutEntry(text: string, state: FileState, format: EntryFormat, label: string): string {
  const removed = (candidate: string) => {
    try {
      return !format.locate(candidate, label).found;
    } catch {
      return false;
    }
  };
  if (state.edit !== null) {
    const undone = undoEdit(text, state.edit);
    if (undone !== undefined && removed(undone)) return undone;
  }
  const result = format.remove(text, state.parentCreated, label);
  if (!removed(result)) throw new Error(`removing the ufo server from ${label} left it invalid`);
  return result;
}

async function planFileHost(
  ctx: PlanContext,
  host: "codex" | "cursor",
  record: SetupRecord,
  mode: Mode,
  plan: Plan,
): Promise<void> {
  const file = host === "codex" ? ctx.paths.codexConfig : ctx.paths.cursorConfig;
  const format = host === "codex" ? CODEX : CURSOR;
  const label = tilde(file, ctx.paths.home);
  const owned = hostRecord(ctx, record, host, file);
  const text = await readConfig(file, label);
  const current = text === undefined ? { found: false as const } : format.locate(text, label);
  const where = { hosts: [host], kind: "mcp_server" as const, target: label };
  const diff = (after: string | undefined) => shown(ctx, unifiedDiff(label, text, after));
  const unchangedSincePlan = async () => {
    if ((await readConfig(file, label)) !== text) throw changed(label);
  };
  const forget = async (target: SetupRecord) => {
    delete target.hosts[host];
    await removeBackup(ctx.store.dir, host, file);
  };

  if (mode !== "remove") {
    const { source, launch, env } = installing(ctx);
    const desired = desiredEntry(host, launch, env);
    /** Records, then writes, `next`, backing the file up first when setup never wrote it. */
    const write =
      (next: string, edit: SpanEdit | null, parentCreated: boolean) =>
      async (target: SetupRecord, save: Save) => {
        await unchangedSincePlan();
        const prior = target.hosts[host];
        const priorFile = prior?.file;
        if (priorFile === undefined && text !== undefined) {
          await writeBackup(ctx.store.dir, host, file, text);
        }
        const before = text === undefined ? null : sha256(text);
        const state: FileState = {
          before: priorFile === undefined ? before : priorFile.before,
          after: sha256(next),
          untouched: priorFile === undefined || (priorFile.untouched && before === priorFile.after),
          edit,
          parentCreated,
        };
        target.hosts[host] = {
          path: file,
          version: prior?.version ?? source.version,
          entry: prior?.entry ?? desired,
          pending: { version: source.version, entry: desired },
          file: state,
        };
        await save(target);
        await writeConfig(file, next);
        target.hosts[host] = { path: file, version: source.version, entry: desired, file: state };
      };
    if (!current.found) {
      if (mode === "update" && owned !== undefined) {
        plan.unchanged.push({
          ...where,
          reason: "has no ufo server any more; UFO forgets it (run ufo setup to add it again)",
        });
        plan.bookkeeping.push(forget);
        return;
      }
      const next = format.insert(text, desired, label);
      plan.steps.push({
        view: {
          ...where,
          action: "add",
          detail: text === undefined ? "create the file with the ufo server" : "add the ufo server",
          diff: diff(next.text),
        },
        apply: write(
          next.text,
          next.edit,
          (owned?.file?.parentCreated ?? false) || next.parentCreated,
        ),
      });
      return;
    }
    if (sameEntry(current.value, desired)) {
      plan.unchanged.push({
        ...where,
        reason:
          owned === undefined
            ? "has this ufo server already, not written by UFO; uninstall leaves it"
            : `up to date (${PACKAGE_NAME}@${source.version})`,
      });
      if (owned !== undefined) {
        plan.bookkeeping.push(async (target) => {
          const { pending: _pending, ...rest } = owned;
          target.hosts[host] = { ...rest, version: source.version, entry: desired };
        });
      }
      return;
    }
    if (owned !== undefined && current.editable && text !== undefined) {
      if (ownsEntry(owned, current.value)) {
        const next = format.replace(text, desired, label);
        plan.steps.push({
          view: {
            ...where,
            action: "repin",
            detail: `point the ufo server at ${PACKAGE_NAME}@${source.version}`,
            diff: diff(next.text),
          },
          apply: write(
            next.text,
            repinEdit(owned.file?.edit ?? null, next.before, next.after),
            owned.file?.parentCreated ?? false,
          ),
        });
        return;
      }
    }
    throw conflict(owned !== undefined, label, "a ufo server");
  }

  if (owned === undefined) {
    plan.unchanged.push({ ...where, reason: "not set up by UFO" });
    return;
  }
  const state = owned.file;
  if (state === undefined) {
    throw new SetupError("unsafe_state", `the setup record of ${label} has no file state`);
  }
  /** Writes `next` (`undefined`: removes the file setup created) and forgets the host. */
  const finish = (next: string | undefined) => async (target: SetupRecord) => {
    await unchangedSincePlan();
    if (next === undefined) await removeConfig(file);
    else await writeConfig(file, next);
    await forget(target);
  };
  if (text === undefined) {
    plan.unchanged.push({ ...where, reason: "is gone; nothing to remove" });
    plan.bookkeeping.push(forget);
    return;
  }
  if (state.untouched && sha256(text) === state.after) {
    const original =
      state.before === null ? undefined : await readBackup(ctx.store.dir, host, file, state.before);
    plan.steps.push({
      view: {
        ...where,
        action: "restore",
        detail:
          original === undefined
            ? "delete the file setup created (unchanged since)"
            : "restore the backup (the file is unchanged since setup wrote it)",
        diff: diff(original),
      },
      apply: finish(original),
    });
    return;
  }
  if (!current.found) {
    plan.unchanged.push({ ...where, reason: "has no ufo server left; nothing to remove" });
    plan.bookkeeping.push(forget);
    return;
  }
  if (!current.editable || !ownsEntry(owned, current.value)) {
    throw conflict(true, label, "the ufo server");
  }
  const next = withoutEntry(text, state, format, label);
  const created = state.before === null && next.trim() === "";
  plan.steps.push({
    view: {
      ...where,
      action: "remove",
      detail: created
        ? "delete the file setup created (nothing else is left in it)"
        : "remove the ufo server; every other byte stays",
      diff: diff(created ? undefined : next),
    },
    apply: finish(created ? undefined : next),
  });
}

/** Claude Code's user-scope `ufo` server as its config holds it, or `undefined`. */
async function claudeEntry(file: string, label: string): Promise<unknown> {
  const text = await readConfig(file, label);
  if (text === undefined || text.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupError("host_config_invalid", `${label} is not valid JSON`);
  }
  const servers =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
  if (typeof servers !== "object" || servers === null || !Object.hasOwn(servers, SERVER_NAME)) {
    return undefined;
  }
  return (servers as Record<string, unknown>)[SERVER_NAME];
}

/** Whether a Claude Code entry runs `entry`'s command and arguments, whatever else it holds. */
function sameCommand(value: unknown, entry: Record<string, unknown>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const found = value as Record<string, unknown>;
  return (
    isDeepStrictEqual(found.command, entry.command) && isDeepStrictEqual(found.args, entry.args)
  );
}

/**
 * Claude Code through its own CLI (`claude mcp add|remove --scope user`): its config holds live
 * app state, so setup reads it but never writes it, backs nothing up, and never restores it.
 */
async function planClaudeCode(
  ctx: PlanContext,
  record: SetupRecord,
  mode: Mode,
  plan: Plan,
): Promise<void> {
  const host: HostId = "claude-code";
  const file = ctx.paths.claudeJson;
  const label = tilde(file, ctx.paths.home);
  const owned = hostRecord(ctx, record, host, file);
  const current = await claudeEntry(file, label);
  const claude = ctx.claude;
  if (claude === undefined) {
    throw new SetupError(
      "host_not_found",
      "Claude Code's claude is not on PATH (outside the project); UFO changes its servers only through it",
    );
  }
  const where = { hosts: [host], kind: "mcp_server" as const, target: label };
  const addArgs = (entry: Record<string, unknown>) => [
    "mcp",
    "add",
    "--scope",
    "user",
    SERVER_NAME,
    ...Object.entries((entry.env ?? {}) as Record<string, string>).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    "--",
    String(entry.command),
    ...(entry.args as string[]),
  ];
  const remove = ["mcp", "remove", SERVER_NAME, "--scope", "user"];
  const line = (args: readonly string[]) => `${claude} ${args.join(" ")}`;
  const run = (args: readonly string[]) =>
    ctx.run(claude, args, { cwd: ctx.paths.home, env: ctx.env, timeoutMs: 60_000 });
  const why = (result: CommandResult) => {
    const text = (result.stderr || result.stdout).trim().split("\n").at(-1) ?? "";
    return `${howItEnded(result)}${text === "" ? "" : `: ${text}`}`;
  };
  const unchangedSincePlan = async () => {
    if (!isDeepStrictEqual(await claudeEntry(file, label), current)) throw changed(label);
  };

  if (mode !== "remove") {
    const { source, launch, env } = installing(ctx);
    const desired = desiredEntry(host, launch, env);
    const add = addArgs(desired);
    /**
     * Records, then runs `claude mcp add` (after `remove` for a re-pin). When the add fails or
     * does not show up as UFO's, what this step did is undone: the new server is removed and,
     * for a re-pin, the previous one is added back.
     */
    const install = (repin: boolean) => async (target: SetupRecord, save: Save) => {
      await unchangedSincePlan();
      const prior = target.hosts[host];
      target.hosts[host] = {
        path: file,
        version: prior?.version ?? source.version,
        entry: prior?.entry ?? desired,
        pending: { version: source.version, entry: desired },
      };
      await save(target);
      if (repin) {
        const removed = await run(remove);
        if (removed.code !== 0) {
          if (prior === undefined) delete target.hosts[host];
          else target.hosts[host] = { path: file, version: prior.version, entry: prior.entry };
          throw new SetupError("host_cli_failed", `${line(remove)} ${why(removed)}`);
        }
      }
      const added = await run(add);
      const now = added.code === 0 ? await claudeEntry(file, label) : undefined;
      if (added.code === 0 && sameCommand(now, desired)) {
        // What Claude Code stored, extra defaults included, is the entry UFO owns.
        target.hosts[host] = {
          path: file,
          version: source.version,
          entry: now as Record<string, unknown>,
        };
        return;
      }
      if (added.code === 0) await run(remove);
      let restored = "";
      delete target.hosts[host];
      if (repin && prior !== undefined) {
        const again = await run(addArgs(prior.entry));
        if (again.code === 0 && sameCommand(await claudeEntry(file, label), prior.entry)) {
          target.hosts[host] = { path: file, version: prior.version, entry: prior.entry };
          restored = "; the previous ufo server is back in place";
        } else {
          restored =
            "; the previous ufo server was removed and could not be added back: run ufo setup again";
        }
      }
      throw new SetupError(
        "host_cli_failed",
        added.code === 0
          ? `${line(add)} succeeded, but ${label} shows no matching ufo server (is CLAUDE_CONFIG_DIR set the same way for both?); UFO removed it again${restored}`
          : `${line(add)} ${why(added)}${restored}`,
      );
    };
    if (current === undefined) {
      if (mode === "update" && owned !== undefined) {
        plan.unchanged.push({
          ...where,
          reason: "has no ufo server any more; UFO forgets it (run ufo setup to add it again)",
        });
        plan.bookkeeping.push(async (target) => {
          delete target.hosts[host];
        });
        return;
      }
      plan.steps.push({
        view: { ...where, action: "add", detail: shown(ctx, `run ${line(add)}`) },
        apply: install(false),
      });
    } else if (
      sameEntry(current, desired) ||
      (owned !== undefined && sameCommand(current, desired) && ownsEntry(owned, current))
    ) {
      plan.unchanged.push({
        ...where,
        reason:
          owned === undefined
            ? "has this ufo server already, not added by UFO; uninstall leaves it"
            : `up to date (${PACKAGE_NAME}@${source.version})`,
      });
      if (owned !== undefined) {
        // As for the file hosts: the entry there is confirmed, at this version.
        plan.bookkeeping.push(async (target) => {
          target.hosts[host] = {
            path: file,
            version: source.version,
            entry: current as Record<string, unknown>,
          };
        });
      }
    } else if (ownsEntry(owned, current)) {
      plan.steps.push({
        view: {
          ...where,
          action: "repin",
          detail: shown(ctx, `run ${line(remove)}, then ${line(add)}`),
        },
        apply: install(true),
      });
    } else {
      throw conflict(owned !== undefined, label, "a user-scope ufo server");
    }
    return;
  }

  if (owned === undefined) {
    plan.unchanged.push({ ...where, reason: "not set up by UFO" });
    return;
  }
  if (current === undefined) {
    plan.unchanged.push({ ...where, reason: "has no ufo server left; nothing to remove" });
    plan.bookkeeping.push(async (target) => {
      delete target.hosts[host];
    });
    return;
  }
  if (!ownsEntry(owned, current)) throw conflict(true, label, "the user-scope ufo server");
  plan.steps.push({
    view: { ...where, action: "remove", detail: shown(ctx, `run ${line(remove)}`) },
    apply: async (target) => {
      await unchangedSincePlan();
      const removed = await run(remove);
      if (removed.code !== 0) {
        throw new SetupError("host_cli_failed", `${line(remove)} ${why(removed)}`);
      }
      if ((await claudeEntry(file, label)) !== undefined) {
        throw new SetupError("host_cli_failed", `${line(remove)} left the ufo server in ${label}`);
      }
      delete target.hosts[host];
    },
  });
}

const byHostOrder = (hosts: Iterable<HostId>) => HOST_IDS.filter((id) => [...hosts].includes(id));

async function planSkills(
  ctx: PlanContext,
  hosts: readonly HostId[],
  record: SetupRecord,
  mode: Mode,
  plan: Plan,
): Promise<void> {
  const dirs = new Map<string, HostId[]>();
  for (const host of hosts) {
    const dir = ctx.paths.skillDirs[host];
    dirs.set(dir, [...(dirs.get(dir) ?? []), host]);
  }
  for (const [dir, dirHosts] of dirs) {
    const label = tilde(dir, ctx.paths.home);
    const owned = record.skills[dir];
    const where = { hosts: dirHosts, kind: "skill" as const, target: label };
    const current = await readSkillHashes(dir);
    const ours = (hashes: FileHashes) =>
      owned !== undefined &&
      (sameFiles(hashes, owned.files) ||
        (owned.pending !== undefined && sameFiles(hashes, owned.pending)));
    const withHosts = (target: SetupRecord) =>
      byHostOrder(new Set([...(target.skills[dir]?.hosts ?? []), ...dirHosts]));
    const forget = async (target: SetupRecord) => {
      delete target.skills[dir];
    };
    const unchangedSincePlan = async () => {
      const now = await readSkillHashes(dir);
      const same =
        now === undefined || current === undefined ? now === current : sameFiles(now, current);
      if (!same) throw changed(label);
    };

    if (mode !== "remove") {
      const { source } = installing(ctx);
      const hashes = hashFiles(source.skill);
      if (current === undefined && mode === "update" && owned !== undefined) {
        plan.unchanged.push({
          ...where,
          reason: "is gone; UFO forgets it (run ufo setup to install it again)",
        });
        plan.bookkeeping.push(forget);
        continue;
      }
      if (current !== undefined && sameFiles(current, hashes)) {
        plan.unchanged.push({
          ...where,
          reason:
            owned === undefined
              ? `holds this ${SKILL_NAME} skill already, not installed by UFO; uninstall leaves it`
              : "up to date",
        });
        if (owned !== undefined) {
          // The files on disk are this version's: that is what UFO owns now.
          plan.bookkeeping.push(async (target) => {
            target.skills[dir] = {
              files: hashes,
              hosts: withHosts(target),
              version: source.version,
            };
          });
        }
        continue;
      }
      if (current !== undefined && !ours(current)) {
        throw skillConflict(
          owned !== undefined,
          label,
          firstDifference(current, owned?.files ?? hashes),
        );
      }
      const replace = current !== undefined;
      plan.steps.push({
        view: {
          ...where,
          action: replace ? "replace" : "install",
          detail: `${replace ? "update" : "install"} the ${SKILL_NAME} skill from ${PACKAGE_NAME}@${source.version} (${Object.keys(hashes).sort().join(", ")})`,
        },
        apply: async (target, save) => {
          await unchangedSincePlan();
          const files = await installedSkill(
            prefixFor(ctx.store.pkgRoot, source.version),
            source.skill,
          );
          const prior = target.skills[dir];
          target.skills[dir] = {
            files: prior?.files ?? hashes,
            pending: hashes,
            hosts: withHosts(target),
            version: prior?.version ?? source.version,
          };
          await save(target);
          await installSkill(dir, files, replace);
          target.skills[dir] = { files: hashes, hosts: withHosts(target), version: source.version };
        },
      });
      continue;
    }

    if (owned === undefined) {
      plan.unchanged.push({ ...where, reason: "not installed by UFO" });
      continue;
    }
    const remaining = owned.hosts.filter((host) => !dirHosts.includes(host));
    if (remaining.length > 0) {
      plan.unchanged.push({ ...where, reason: `kept for ${hostNames(remaining)}` });
      plan.bookkeeping.push(async (target) => {
        target.skills[dir] = { ...owned, hosts: remaining };
      });
      continue;
    }
    if (current === undefined) {
      plan.unchanged.push({ ...where, reason: "is gone; nothing to remove" });
      plan.bookkeeping.push(forget);
      continue;
    }
    if (!ours(current)) throw skillConflict(true, label, firstDifference(current, owned.files));
    plan.steps.push({
      view: { ...where, action: "remove", detail: `remove the ${SKILL_NAME} skill directory` },
      apply: async (target) => {
        await unchangedSincePlan();
        await removeSkill(dir);
        await forget(target);
      },
    });
  }
}

/** Setup and update: install the package version hosts will start, unless it is in place. */
async function planPackage(
  ctx: PlanContext,
  hosts: readonly HostId[],
  record: SetupRecord,
  plan: Plan,
): Promise<void> {
  const { source } = installing(ctx);
  const prefix = prefixFor(ctx.store.pkgRoot, source.version);
  const where = {
    hosts: [...hosts],
    kind: "package" as const,
    target: tilde(prefix, ctx.paths.home),
  };
  const owned = record.packages[source.version];
  const installed = await installedIntegrity(prefix, source.version);
  if (owned?.integrity === source.integrity && installed === source.integrity) {
    plan.unchanged.push({ ...where, reason: `${PACKAGE_NAME}@${source.version} is installed` });
    return;
  }
  if (installed !== undefined) refuseWhileRunning(ctx, prefix);
  if (ctx.npm === undefined) {
    throw new SetupError("install_failed", "npm is not on PATH (outside the project)");
  }
  const from = source.tarball === undefined ? REGISTRY : source.tarball;
  plan.steps.push({
    view: {
      ...where,
      action: installed === undefined ? "install" : "replace",
      detail: shown(
        ctx,
        `install ${PACKAGE_NAME}@${source.version} from ${from} with ${ctx.npm} (no install scripts, no npm_config_* settings), then check its version and integrity ${source.integrity}`,
      ),
    },
    apply: async (target, save) => {
      target.packages[source.version] = {
        source: source.kind,
        integrity: source.integrity,
        ...(source.tarball === undefined ? {} : { tarball: source.tarball }),
      };
      await save(target);
      await installPackage(
        { pkgRoot: ctx.store.pkgRoot, npm: ctx.npm, env: ctx.env, run: ctx.run },
        source,
      );
    },
  });
}

/** Refuses (`run_in_progress`) to replace or remove `prefix` while a run holds the machine lock. */
function refuseWhileRunning(ctx: PlanContext, prefix: string): void {
  if (ctx.runLock === undefined) return;
  const run = ctx.runLock.runId === undefined ? "a UFO run" : `UFO run ${ctx.runLock.runId}`;
  throw new SetupError(
    "run_in_progress",
    `${run} holds the machine lock, and its worker may be running from ${tilde(prefix, ctx.paths.home)}; finish or cancel the run first (ufo status, ufo cancel), then run this again`,
  );
}

/** Uninstall: remove each installed copy no host left set up still starts. */
function planPackageRemoval(
  ctx: PlanContext,
  hosts: readonly HostId[],
  record: SetupRecord,
  plan: Plan,
): void {
  const kept = new Map<string, HostId[]>();
  for (const host of HOST_IDS) {
    const entry = record.hosts[host];
    if (entry === undefined || hosts.includes(host)) continue;
    for (const version of [entry.version, entry.pending?.version]) {
      if (version !== undefined) kept.set(version, [...(kept.get(version) ?? []), host]);
    }
  }
  for (const version of Object.keys(record.packages).sort()) {
    const where = {
      hosts: [...hosts],
      kind: "package" as const,
      target: tilde(prefixFor(ctx.store.pkgRoot, version), ctx.paths.home),
    };
    const users = kept.get(version);
    if (users !== undefined) {
      plan.unchanged.push({ ...where, reason: `kept for ${hostNames(users)}` });
      continue;
    }
    refuseWhileRunning(ctx, prefixFor(ctx.store.pkgRoot, version));
    plan.steps.push({
      view: { ...where, action: "remove", detail: `remove ${PACKAGE_NAME}@${version}` },
      apply: async (target) => {
        await removePackage(ctx.store.pkgRoot, version);
        delete target.packages[version];
      },
    });
  }
}

/**
 * Every change for `hosts`, in order: the package (setup, update), each host's MCP server entry,
 * the skill directories, then (uninstall) the installed copies no one starts any more.
 */
export async function planChanges(
  ctx: PlanContext,
  hosts: readonly HostId[],
  record: SetupRecord,
  mode: Mode,
): Promise<Plan> {
  const plan: Plan = { steps: [], unchanged: [], bookkeeping: [] };
  if (mode !== "remove") await planPackage(ctx, hosts, record, plan);
  for (const host of hosts) {
    if (host === "claude-code") await planClaudeCode(ctx, record, mode, plan);
    else await planFileHost(ctx, host, record, mode, plan);
  }
  await planSkills(ctx, hosts, record, mode, plan);
  if (mode === "remove") planPackageRemoval(ctx, hosts, record, plan);
  return plan;
}

/** The hosts the record says setup configured, in host order. */
export function recordedHosts(record: SetupRecord): HostId[] {
  const hosts = new Set<HostId>(Object.keys(record.hosts) as HostId[]);
  for (const skill of Object.values(record.skills)) for (const host of skill.hosts) hosts.add(host);
  return byHostOrder(hosts);
}
