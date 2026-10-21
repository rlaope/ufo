import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ChildGroup,
  DOCKER_PROBE_TIMEOUT_MS,
  execBounded,
  isPidAlive,
  isProcessGroupAlive,
  readProcessCommand,
  readProcessStartTime,
  readRun,
} from "../core/jobs/index.js";
import { readChildGroups, runContainerLabel, workerArgv } from "./launch.js";

/**
 * Runs a program with array arguments; rejects when it cannot start, exits non-zero, or runs
 * past `timeoutMs` (it is then killed).
 */
export type Exec = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

/** `docker ps` and `docker rm -f` of a reachable Docker. */
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;

export interface KillOptions {
  /** How long groups get after SIGTERM before SIGKILL. */
  graceMs?: number;
  /** Runs `docker`; injectable for tests. */
  exec?: Exec;
}

export type SkipReason =
  | "self"
  | "not_running"
  | "pid_reused"
  | "not_permitted"
  | "unverified"
  | "not_ufo_worker";

/** Skips that leave nothing of the run running: the group is gone, reused, or this process. */
const GONE: ReadonlySet<SkipReason> = new Set(["self", "not_running", "pid_reused"]);

/**
 * Whether nothing the run started is left running after `report`'s stop: no survivor, and no
 * group skipped while it may still be alive (unverified, not permitted, not the worker).
 */
export function nothingLeftRunning(report: Pick<KillReport, "survivors" | "skipped">): boolean {
  return report.survivors.length === 0 && report.skipped.every((skip) => GONE.has(skip.reason));
}

export interface KillReport {
  /** Groups sent SIGTERM. */
  terminated: number[];
  /** Groups still alive after the grace period and sent SIGKILL. */
  killed: number[];
  /** Groups still alive after SIGKILL. Empty unless a process is stuck in the kernel. */
  survivors: number[];
  skipped: { pgid: number; reason: SkipReason }[];
  containers: { dockerAvailable: boolean; removed: string[]; error?: string };
}

const POLL_MS = 50;
const SIGKILL_WAIT_MS = 2000;

/**
 * Stops everything a run started: the worker's process group first (so it cannot start more),
 * then every child group in `run.json` re-read after the worker stopped, then containers labeled
 * `ufo.run=<runId>`. Nothing is signalled on the word of `run.json` alone: a group whose leader
 * now has a different start time was reused by an unrelated process and is skipped, and the
 * worker's leader must also still run `worker --run-dir <runDir>`. Container labels are
 * filtered to this run's own (`ufo.run=<runId>` or `ufo.run=<runId>.<suffix>`), the run id
 * being the run directory's name. Used by resume and cancel; does not change `run.json`.
 */
export async function killRunProcesses(
  runDir: string,
  options: KillOptions = {},
): Promise<KillReport> {
  const runId = path.basename(runDir);
  const graceMs = options.graceMs ?? 3000;
  const report: KillReport = {
    terminated: [],
    killed: [],
    survivors: [],
    skipped: [],
    containers: { dockerAvailable: false, removed: [] },
  };
  const { worker } = await readRun(runDir);
  if (worker !== undefined) {
    const command = workerArgv(runDir).join(" ");
    await stopGroups([{ pgid: worker.pid, startTime: worker.startTime }], graceMs, report, command);
  }
  const run = await readRun(runDir);
  const seen = new Set(worker === undefined ? [] : [worker.pid]);
  await stopGroups(
    (await readChildGroups(runDir)).filter((group) => !seen.has(group.pgid)),
    graceMs,
    report,
  );
  const own = runContainerLabel(runId);
  const labels = [own, ...run.containerLabels].filter(
    (label) => label === own || label.startsWith(`${own}.`),
  );
  report.containers = await removeContainers(labels, options.exec ?? execBounded);
  return report;
}

async function stopGroups(
  groups: readonly ChildGroup[],
  graceMs: number,
  report: KillReport,
  leaderCommand?: string,
): Promise<void> {
  const signalled: number[] = [];
  for (const { pgid, startTime } of groups) {
    const reason = (await skipReason(pgid, startTime, leaderCommand)) ?? signal(pgid, "SIGTERM");
    if (reason === undefined) {
      signalled.push(pgid);
    } else {
      report.skipped.push({ pgid, reason });
    }
  }
  report.terminated.push(...signalled);
  const leftover = await waitForExit(signalled, graceMs);
  for (const pgid of leftover) {
    if (signal(pgid, "SIGKILL") === undefined) report.killed.push(pgid);
  }
  report.survivors.push(...(await waitForExit(leftover, SIGKILL_WAIT_MS)));
}

/**
 * Why the group must not be signalled. While the leader lives, its start time (and, for the
 * worker, its command line) identifies the group; a leader whose start time cannot be read is
 * not trusted. Once only members remain, the id cannot have been reused: a PID is not handed
 * out while a group with that id exists.
 */
async function skipReason(
  pgid: number,
  startTime: string,
  leaderCommand: string | undefined,
): Promise<SkipReason | undefined> {
  if (pgid === process.pid) return "self";
  if (!isProcessGroupAlive(pgid)) return "not_running";
  if (!isPidAlive(pgid)) return undefined;
  const current = await readProcessStartTime(pgid);
  if (current === undefined) return isPidAlive(pgid) ? "unverified" : undefined;
  if (current !== startTime) return "pid_reused";
  if (leaderCommand !== undefined) {
    const command = await readProcessCommand(pgid);
    if (command === undefined || !command.includes(leaderCommand)) return "not_ufo_worker";
  }
  return undefined;
}

/** Signals the group; returns why it could not, or `undefined` when the signal was sent. */
function signal(pgid: number, name: NodeJS.Signals): SkipReason | undefined {
  try {
    process.kill(-pgid, name);
    return undefined;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH") return "not_running";
    // The id now belongs to another user's processes, so it is not ours any more.
    if (code === "EPERM") return "not_permitted";
    throw error;
  }
}

/** Polls until every group is gone or `ms` passes; returns the groups still alive. */
async function waitForExit(groups: readonly number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let alive = groups.filter(isProcessGroupAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(POLL_MS);
    alive = alive.filter(isProcessGroupAlive);
  }
  return alive;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

async function removeContainers(
  labels: readonly string[],
  exec: Exec,
): Promise<KillReport["containers"]> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"], DOCKER_PROBE_TIMEOUT_MS);
  } catch (error) {
    return { dockerAvailable: false, removed: [], error: describe(error) };
  }
  const ids = new Set<string>();
  try {
    for (const label of new Set(labels)) {
      // `-a` includes stopped containers; the label filter keeps unlabeled containers out.
      const { stdout } = await exec(
        "docker",
        ["ps", "-aq", "--filter", `label=${label}`],
        DOCKER_COMMAND_TIMEOUT_MS,
      );
      for (const id of stdout.split(/\s+/)) {
        if (CONTAINER_ID.test(id)) ids.add(id);
      }
    }
    if (ids.size > 0) await exec("docker", ["rm", "-f", ...ids], DOCKER_COMMAND_TIMEOUT_MS);
  } catch (error) {
    return { dockerAvailable: true, removed: [], error: describe(error) };
  }
  return { dockerAvailable: true, removed: [...ids] };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] || error.name : String(error);
}
