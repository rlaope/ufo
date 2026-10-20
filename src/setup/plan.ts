import { isDeepStrictEqual } from "node:util";
import { oneLine } from "../core/text.js";
import { unifiedDiff } from "./diff.js";
import { SetupError } from "./errors.js";
import { readConfig, removeConfig, sha256, writeConfig } from "./files.js";
import {
  type CommandRunner,
  desiredEntry,
  HOST_IDS,
  HOST_NAMES,
  type HostId,
  type HostPaths,
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
import { hashFiles, installSkill, readSkillHashes, removeSkill, sameFiles } from "./skills.js";
import { repinEdit, type SpanEdit, undoEdit } from "./span.js";
import {
  type FileState,
  readBackup,
  removeBackup,
  type SetupRecord,
  writeBackup,
} from "./store.js";
import {
  insertTomlEntry,
  locateTomlEntry,
  removeTomlEntry,
  replaceTomlEntry,
} from "./toml-edit.js";

// What setup, uninstall, and update would change, worked out before anything is written. Each
// step re-reads its target before it writes and refuses (`changed_during_setup`) when it is no
// longer what the plan showed.

export type ChangeAction = "add" | "repin" | "remove" | "restore" | "install" | "replace";

export interface ChangeView {
  readonly hosts: HostId[];
  readonly kind: "mcp_server" | "skill";
  /** The file or directory, with the home directory as `~`. */
  readonly target: string;
  readonly action: ChangeAction;
  readonly detail: string;
  /** The unified diff of a config file edit. */
  readonly diff?: string;
}

export interface UnchangedView {
  readonly hosts: HostId[];
  readonly kind: "mcp_server" | "skill";
  readonly target: string;
  readonly reason: string;
}

export interface Step {
  readonly view: ChangeView;
  /** Makes the change and records it in `record`. */
  readonly apply: (record: SetupRecord) => Promise<void>;
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
  readonly version: string;
  /** `$UFO_HOME/private/setup`. */
  readonly store: string;
  readonly skill: ReadonlyMap<string, Buffer>;
}

/** `install`: setup and update; `remove`: uninstall. */
export type Mode = "install" | "remove";

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

function skillConflict(owned: boolean, label: string): SetupError {
  return new SetupError(
    "entry_conflict",
    owned
      ? `${label} was changed since setup installed it; restore it or remove it by hand`
      : `${label} holds a ${SKILL_NAME} skill that UFO did not install; remove or rename it, or leave this host out with --host`,
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
  const desired = desiredEntry(host, ctx.version);
  const where = { hosts: [host], kind: "mcp_server" as const, target: label };
  const unchangedSincePlan = async () => {
    if ((await readConfig(file, label)) !== text) throw changed(label);
  };

  if (mode === "install") {
    /** Writes `next`, backing the file up first when setup has never written it. */
    const write =
      (next: string, edit: SpanEdit | null, parentCreated: boolean) =>
      async (target: SetupRecord) => {
        await unchangedSincePlan();
        const prior = target.hosts[host]?.file;
        if (prior === undefined && text !== undefined) {
          await writeBackup(ctx.store, host, file, text);
        }
        await writeConfig(file, next);
        const before = text === undefined ? null : sha256(text);
        target.hosts[host] = {
          path: file,
          entry: desired,
          file: {
            before: prior === undefined ? before : prior.before,
            after: sha256(next),
            untouched: prior === undefined || (prior.untouched && before === prior.after),
            edit,
            parentCreated,
          },
        };
      };
    if (!current.found) {
      const next = format.insert(text, desired, label);
      plan.steps.push({
        view: {
          ...where,
          action: "add",
          detail: text === undefined ? "create the file with the ufo server" : "add the ufo server",
          diff: unifiedDiff(label, text, next.text),
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
            : `up to date (ufo-agents@${ctx.version})`,
      });
      return;
    }
    if (
      owned !== undefined &&
      current.editable &&
      text !== undefined &&
      sameEntry(current.value, owned.entry)
    ) {
      const next = format.replace(text, desired, label);
      plan.steps.push({
        view: {
          ...where,
          action: "repin",
          detail: `re-pin the ufo server to ufo-agents@${ctx.version}`,
          diff: unifiedDiff(label, text, next.text),
        },
        apply: write(
          next.text,
          repinEdit(owned.file?.edit ?? null, next.before, next.after),
          owned.file?.parentCreated ?? false,
        ),
      });
      return;
    }
    throw conflict(owned !== undefined, label, "a ufo server");
  }

  if (owned === undefined) {
    plan.unchanged.push({ ...where, reason: "not set up by UFO" });
    return;
  }
  const state = owned.file;
  if (state === undefined)
    throw new SetupError("unsafe_state", `the setup record of ${label} has no file state`);
  const forget = async (target: SetupRecord) => {
    delete target.hosts[host];
    await removeBackup(ctx.store, host, file);
  };
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
      state.before === null ? undefined : await readBackup(ctx.store, host, file, state.before);
    plan.steps.push({
      view: {
        ...where,
        action: "restore",
        detail:
          original === undefined
            ? "delete the file setup created (unchanged since)"
            : "restore the backup (the file is unchanged since setup wrote it)",
        diff: unifiedDiff(label, text, original),
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
  if (!current.editable || !sameEntry(current.value, owned.entry)) {
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
      diff: unifiedDiff(label, text, created ? undefined : next),
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
  const desired = desiredEntry(host, ctx.version);
  const add = [
    "mcp",
    "add",
    "--scope",
    "user",
    SERVER_NAME,
    "--",
    "npx",
    ...(desired.args as string[]),
  ];
  const remove = ["mcp", "remove", SERVER_NAME, "--scope", "user"];
  const where = { hosts: [host], kind: "mcp_server" as const, target: label };
  const claude = async (args: readonly string[]) => {
    const result = await ctx.run("claude", args);
    if (result.code !== 0) {
      throw new SetupError(
        "host_cli_failed",
        `claude ${args.join(" ")} exited ${result.code}: ${oneLine(result.stderr || result.stdout, 300, "no output")}`,
      );
    }
  };
  const unchangedSincePlan = async () => {
    if (!isDeepStrictEqual(await claudeEntry(file, label), current)) throw changed(label);
  };
  const install = (repin: boolean) => async (target: SetupRecord) => {
    await unchangedSincePlan();
    if (repin) await claude(remove);
    await claude(add);
    if (!sameEntry(await claudeEntry(file, label), desired)) {
      throw new SetupError(
        "host_cli_failed",
        `claude ${add.join(" ")} succeeded, but ${label} has no matching ufo server (is CLAUDE_CONFIG_DIR set the same way for both?)`,
      );
    }
    target.hosts[host] = { path: file, entry: desired };
  };

  if (mode === "install") {
    if (current === undefined) {
      plan.steps.push({
        view: { ...where, action: "add", detail: `run claude ${add.join(" ")}` },
        apply: install(false),
      });
    } else if (sameEntry(current, desired)) {
      plan.unchanged.push({
        ...where,
        reason:
          owned === undefined
            ? "has this ufo server already, not added by UFO; uninstall leaves it"
            : `up to date (ufo-agents@${ctx.version})`,
      });
    } else if (owned !== undefined && sameEntry(current, owned.entry)) {
      plan.steps.push({
        view: {
          ...where,
          action: "repin",
          detail: `run claude ${remove.join(" ")}, then claude ${add.join(" ")}`,
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
  if (!sameEntry(current, owned.entry)) throw conflict(true, label, "the user-scope ufo server");
  plan.steps.push({
    view: { ...where, action: "remove", detail: `run claude ${remove.join(" ")}` },
    apply: async (target) => {
      await unchangedSincePlan();
      await claude(remove);
      if ((await claudeEntry(file, label)) !== undefined) {
        throw new SetupError(
          "host_cli_failed",
          `claude ${remove.join(" ")} left the ufo server in ${label}`,
        );
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
  const source = hashFiles(ctx.skill);
  for (const [dir, dirHosts] of dirs) {
    const label = tilde(dir, ctx.paths.home);
    const owned = record.skills[dir];
    const where = { hosts: dirHosts, kind: "skill" as const, target: label };
    const current = await readSkillHashes(dir);
    const withHosts = (target: SetupRecord) =>
      byHostOrder(new Set([...(target.skills[dir]?.hosts ?? []), ...dirHosts]));
    const unchangedSincePlan = async () => {
      const now = await readSkillHashes(dir);
      if (
        now === undefined
          ? current !== undefined
          : current === undefined || !sameFiles(now, current)
      ) {
        throw changed(label);
      }
    };

    if (mode === "install") {
      if (
        current === undefined ||
        (owned !== undefined && !sameFiles(current, source) && sameFiles(current, owned.files))
      ) {
        const replace = current !== undefined;
        plan.steps.push({
          view: {
            ...where,
            action: replace ? "replace" : "install",
            detail: `${replace ? "update" : "install"} the ${SKILL_NAME} skill (${Object.keys(source).sort().join(", ")})`,
          },
          apply: async (target) => {
            await unchangedSincePlan();
            await installSkill(dir, ctx.skill, replace);
            target.skills[dir] = { files: source, hosts: withHosts(target) };
          },
        });
      } else if (sameFiles(current, source)) {
        plan.unchanged.push({
          ...where,
          reason:
            owned === undefined
              ? `holds this ${SKILL_NAME} skill already, not installed by UFO; uninstall leaves it`
              : "up to date",
        });
        if (owned !== undefined) {
          plan.bookkeeping.push(async (target) => {
            target.skills[dir] = { files: owned.files, hosts: withHosts(target) };
          });
        }
      } else {
        throw skillConflict(owned !== undefined, label);
      }
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
        target.skills[dir] = { files: owned.files, hosts: remaining };
      });
      continue;
    }
    if (current === undefined) {
      plan.unchanged.push({ ...where, reason: "is gone; nothing to remove" });
      plan.bookkeeping.push(async (target) => {
        delete target.skills[dir];
      });
      continue;
    }
    if (!sameFiles(current, owned.files)) throw skillConflict(true, label);
    plan.steps.push({
      view: { ...where, action: "remove", detail: `remove the ${SKILL_NAME} skill directory` },
      apply: async (target) => {
        await unchangedSincePlan();
        await removeSkill(dir);
        delete target.skills[dir];
      },
    });
  }
}

/** Every change for `hosts`: each host's MCP server entry, then the skill directories. */
export async function planChanges(
  ctx: PlanContext,
  hosts: readonly HostId[],
  record: SetupRecord,
  mode: Mode,
): Promise<Plan> {
  const plan: Plan = { steps: [], unchanged: [], bookkeeping: [] };
  for (const host of hosts) {
    if (host === "claude-code") await planClaudeCode(ctx, record, mode, plan);
    else await planFileHost(ctx, host, record, mode, plan);
  }
  await planSkills(ctx, hosts, record, mode, plan);
  return plan;
}

/** The hosts the record says setup configured, in host order. */
export function recordedHosts(record: SetupRecord): HostId[] {
  const hosts = new Set<HostId>(Object.keys(record.hosts) as HostId[]);
  for (const skill of Object.values(record.skills)) for (const host of skill.hosts) hosts.add(host);
  return byHostOrder(hosts);
}
