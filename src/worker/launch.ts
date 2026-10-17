import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChildGroup,
  ContainerLabelSchema,
  isPidAlive,
  LOGS_DIR,
  PgidSchema,
  PortSchema,
  type RunRecord,
  readProcessStartTime,
  readRun,
  updateRun,
  type WorkerRecord,
} from "../core/jobs/index.js";

/** The CLI subcommand that runs the worker main loop. */
export const WORKER_COMMAND = "worker";

/**
 * The built CLI entry, `dist/cli/index.js`, resolved from this module's location in `dist/worker`.
 * From the TypeScript sources the file does not exist; tests pass their own entry.
 */
export const DEFAULT_WORKER_ENTRY = fileURLToPath(new URL("../cli/index.js", import.meta.url));

export const WORKER_OUT_LOG = "worker.out.log";
export const WORKER_ERR_LOG = "worker.err.log";

/** Arguments after the entry script: `worker --run-dir <runDir>`. */
export function workerArgv(runDir: string): string[] {
  return [WORKER_COMMAND, "--run-dir", runDir];
}

/** Parses the arguments `workerArgv` produces; `argv` starts at the `worker` subcommand. */
export function parseWorkerArgv(argv: readonly string[]): { runDir: string } {
  const index = argv.indexOf("--run-dir");
  const runDir = index === -1 ? undefined : argv[index + 1];
  if (argv[0] !== WORKER_COMMAND || runDir === undefined || !path.isAbsolute(runDir)) {
    throw new Error("usage: ufo worker --run-dir <absolute path>");
  }
  return { runDir };
}

export interface LaunchWorkerOptions {
  /** Script that `process.execPath` runs. Defaults to `DEFAULT_WORKER_ENTRY`. */
  entry?: string;
  /** Appended after `worker --run-dir <runDir>`. */
  extraArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Starts `node <entry> worker --run-dir <runDir>` detached, as the leader of its own process
 * group, with stdout and stderr appended to `logs/` in the run directory, and records it in
 * `run.json`. The worker outlives the caller: a host restarting its MCP server does not stop it.
 */
export async function launchWorker(
  runDir: string,
  options: LaunchWorkerOptions = {},
): Promise<WorkerRecord> {
  const logs = path.join(runDir, LOGS_DIR);
  await mkdir(logs, { recursive: true });
  const out = await open(path.join(logs, WORKER_OUT_LOG), "a");
  const err = await open(path.join(logs, WORKER_ERR_LOG), "a");
  let child: ReturnType<typeof spawn>;
  let started: Promise<unknown>;
  try {
    child = spawn(
      process.execPath,
      [options.entry ?? DEFAULT_WORKER_ENTRY, ...workerArgv(runDir), ...(options.extraArgs ?? [])],
      {
        cwd: runDir,
        detached: true,
        env: options.env ?? process.env,
        stdio: ["ignore", out.fd, err.fd],
      },
    );
    // Rejects on the `error` event, which `once` listens for alongside `spawn`.
    started = once(child, "spawn");
  } finally {
    // The child holds its own copies of the descriptors once spawn returns.
    await out.close();
    await err.close();
  }
  await started;
  const { pid } = child;
  if (pid === undefined) throw new Error("the worker process has no pid");
  child.unref();
  const startTime = await readProcessStartTime(pid);
  const worker: WorkerRecord = {
    pid,
    ...(startTime === undefined ? {} : { startTime }),
    launchedAt: new Date().toISOString(),
  };
  await updateRun(runDir, (run) => ({ ...run, worker }));
  return worker;
}

/** Whether the recorded worker is still running (and its PID was not reused). */
export async function isWorkerAlive(run: RunRecord): Promise<boolean> {
  const { worker } = run;
  if (worker === undefined || worker.exitedAt !== undefined || !isPidAlive(worker.pid)) {
    return false;
  }
  if (worker.startTime === undefined) return true;
  const current = await readProcessStartTime(worker.pid);
  return current === undefined ? isPidAlive(worker.pid) : current === worker.startTime;
}

/** Records a child process group the worker started, so resume and cancel can stop it. */
export async function trackChildGroup(runDir: string, pgid: number): Promise<ChildGroup> {
  PgidSchema.parse(pgid);
  const startTime = await readProcessStartTime(pgid);
  const group: ChildGroup = { pgid, ...(startTime === undefined ? {} : { startTime }) };
  await updateRun(runDir, (run) => ({
    ...run,
    childGroups: [...run.childGroups.filter((g) => g.pgid !== pgid), group],
  }));
  return group;
}

/** Forgets a child group that exited on its own. */
export async function untrackChildGroup(runDir: string, pgid: number): Promise<void> {
  await updateRun(runDir, (run) => ({
    ...run,
    childGroups: run.childGroups.filter((g) => g.pgid !== pgid),
  }));
}

export async function trackPort(runDir: string, port: number): Promise<void> {
  PortSchema.parse(port);
  await updateRun(runDir, (run) =>
    run.ports.includes(port) ? run : { ...run, ports: [...run.ports, port] },
  );
}

/** Docker label every container of a run carries. */
export function runContainerLabel(runId: string): string {
  return `ufo.run=${runId}`;
}

/**
 * Records a container label of this run. Only `ufo.run=<runId>` and `ufo.run=<runId>.<suffix>`
 * are accepted, so cleanup can never reach containers of another run or unlabeled ones.
 */
export async function trackContainerLabel(runDir: string, label: string): Promise<void> {
  ContainerLabelSchema.parse(label);
  const { runId } = await readRun(runDir);
  const own = runContainerLabel(runId);
  if (label !== own && !label.startsWith(`${own}.`)) {
    throw new Error(`container label ${label} does not belong to run ${runId}`);
  }
  await updateRun(runDir, (run) =>
    run.containerLabels.includes(label)
      ? run
      : { ...run, containerLabels: [...run.containerLabels, label] },
  );
}
