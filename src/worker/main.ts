import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CANCEL_FILE,
  existsNoFollow,
  HEARTBEAT_FILE,
  type JobProgress,
  type JobRecord,
  listJobs,
  readJsonIfExists,
  readRun,
  replaceRun,
  withRunLock,
  writeJob,
  writeJsonAtomic,
} from "../core/jobs/index.js";

export interface JobContext {
  runDir: string;
  /** Aborted when a cancel is requested; handlers stop their work and return or throw. */
  signal: AbortSignal;
  /** Records progress on the job; `get_job` callers see it. Ignored once the job finished. */
  setProgress: (progress: JobProgress) => void;
  /**
   * Makes the worker exit once this job is finished, without waiting `idleExitMs`, e.g. after the
   * job that finishes the run. Queued jobs stay queued for the next worker.
   */
  exitAfterJob: () => void;
}

/** Runs one job. The return value, which must be JSON, becomes the job's `result`. */
export type JobHandler = (job: JobRecord, context: JobContext) => unknown;

export interface RunWorkerOptions {
  runDir: string;
  /** Handlers by job kind. A job of an unknown kind fails. */
  handlers: Readonly<Record<string, JobHandler>>;
  /** How often the heartbeat is written and the cancel flag is checked. */
  heartbeatMs?: number;
  /** How long to wait for new jobs before exiting. */
  idleExitMs?: number;
}

export interface WorkerSummary {
  /** Jobs that ran to a terminal status in this worker. */
  processed: number;
  cancelled: boolean;
}

export const HeartbeatSchema = z.strictObject({
  pid: z.number().int().min(1),
  at: z.iso.datetime({ offset: true }),
  jobId: z.string().optional(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

const MAX_ERROR_LENGTH = 4000;
const IDLE_POLL_MS = 100;

/**
 * The worker main loop: claims queued jobs in sequence order and runs each with its handler,
 * writing a heartbeat every `heartbeatMs`. Exits when no job is queued for `idleExitMs`, or when
 * a cancel is requested; then the running job's signal is aborted and queued jobs are cancelled.
 * One worker runs per run directory.
 */
export async function runWorker(options: RunWorkerOptions): Promise<WorkerSummary> {
  const { runDir, handlers } = options;
  const heartbeatMs = options.heartbeatMs ?? 2000;
  const idleExitMs = options.idleExitMs ?? 1000;
  let cancelled = false;
  let current: { jobId: string; controller: AbortController } | undefined;

  const tick = async () => {
    await writeJsonAtomic(path.join(runDir, HEARTBEAT_FILE), {
      pid: process.pid,
      at: new Date().toISOString(),
      ...(current ? { jobId: current.jobId } : {}),
    });
    if (!cancelled && (await isCancelRequested(runDir))) {
      cancelled = true;
      current?.controller.abort();
    }
  };
  await tick();
  // One tick at a time: a slow disk must not pile up fsyncs that starve the job writes, and the
  // loop below waits for the last tick so nothing writes into the run directory after it returns.
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight !== undefined) return;
    inFlight = tick()
      .catch(() => {
        // A missed heartbeat is visible as a stale `at`; the next tick tries again.
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, heartbeatMs);

  let processed = 0;
  try {
    for (;;) {
      if (!cancelled && (await isCancelRequested(runDir))) cancelled = true;
      if (cancelled) break;
      const job = await nextJobOrExit(runDir, idleExitMs, () => cancelled);
      if (job === undefined || cancelled) break;
      const controller = new AbortController();
      current = { jobId: job.jobId, controller };
      const { exitRequested } = await runJob(runDir, job, handlers, controller);
      current = undefined;
      processed++;
      if (exitRequested && !cancelled) {
        await markExited(runDir);
        break;
      }
    }
    if (cancelled) {
      for (const job of await listJobs(runDir)) {
        if (job.status === "queued") await finishJob(runDir, job, cancelledOutcome());
      }
      await markExited(runDir);
    }
  } finally {
    clearInterval(timer);
    await inFlight;
  }
  return { processed, cancelled };
}

/** Asks the run's worker to stop. It aborts the running job and cancels queued ones. */
export async function requestCancel(runDir: string): Promise<void> {
  await writeJsonAtomic(path.join(runDir, CANCEL_FILE), { requestedAt: new Date().toISOString() });
}

export function isCancelRequested(runDir: string): Promise<boolean> {
  return existsNoFollow(path.join(runDir, CANCEL_FILE));
}

export async function readHeartbeat(runDir: string): Promise<Heartbeat | undefined> {
  const value = await readJsonIfExists(path.join(runDir, HEARTBEAT_FILE));
  return value === undefined ? undefined : HeartbeatSchema.parse(value);
}

/**
 * The first queued job, waiting up to `idleExitMs` for one; `undefined` on cancel. Before giving
 * up, it checks once more under the run lock and marks the worker exited in the same critical
 * section, so a job `enqueueJob` adds is either seen here or added after `exitedAt` is visible.
 */
async function nextJobOrExit(
  runDir: string,
  idleExitMs: number,
  isCancelled: () => boolean,
): Promise<JobRecord | undefined> {
  const deadline = Date.now() + idleExitMs;
  for (;;) {
    if (isCancelled()) return undefined;
    const queued = await firstQueued(runDir);
    if (queued !== undefined) return queued;
    if (Date.now() >= deadline) break;
    await delay(IDLE_POLL_MS);
  }
  return withRunLock(runDir, async () => {
    const queued = await firstQueued(runDir);
    if (queued === undefined) await markExitedLocked(runDir);
    return queued;
  });
}

async function firstQueued(runDir: string): Promise<JobRecord | undefined> {
  return (await listJobs(runDir)).find((job) => job.status === "queued");
}

function markExited(runDir: string): Promise<void> {
  return withRunLock(runDir, () => markExitedLocked(runDir));
}

async function markExitedLocked(runDir: string): Promise<void> {
  const run = await readRun(runDir);
  // The launcher records the worker after spawning it; a worker that finishes first skips this.
  if (run.worker?.pid !== process.pid) return;
  await replaceRun(runDir, {
    ...run,
    worker: { ...run.worker, exitedAt: new Date().toISOString() },
  });
}

type Outcome = Pick<JobRecord, "status"> & Partial<Pick<JobRecord, "result" | "error">>;

async function runJob(
  runDir: string,
  queued: JobRecord,
  handlers: RunWorkerOptions["handlers"],
  controller: AbortController,
): Promise<{ exitRequested: boolean }> {
  const now = () => new Date().toISOString();
  let latest: JobRecord = {
    ...queued,
    status: "running",
    workerPid: process.pid,
    startedAt: now(),
    updatedAt: now(),
  };
  await writeJob(runDir, latest);
  // Progress writes and the final write go through one chain so a late progress write cannot
  // overwrite the terminal status.
  let writes = Promise.resolve();
  let finished = false;
  let exitRequested = false;
  const context: JobContext = {
    runDir,
    signal: controller.signal,
    setProgress: (progress) => {
      if (finished) return;
      latest = { ...latest, progress, updatedAt: now() };
      const snapshot = latest;
      writes = writes.then(() => writeJob(runDir, snapshot)).catch(() => {});
    },
    exitAfterJob: () => {
      exitRequested = true;
    },
  };
  let outcome: Outcome;
  try {
    const handler = Object.hasOwn(handlers, queued.kind) ? handlers[queued.kind] : undefined;
    if (handler === undefined) throw new Error(`no handler for job kind ${queued.kind}`);
    const result = await handler(latest, context);
    outcome = {
      status: "succeeded",
      ...(result === undefined ? {} : { result: z.json().parse(result) }),
    };
  } catch (error) {
    outcome = controller.signal.aborted ? cancelledOutcome() : failedOutcome(error);
  }
  finished = true;
  await writes;
  await finishJob(runDir, latest, outcome);
  return { exitRequested };
}

async function finishJob(runDir: string, job: JobRecord, outcome: Outcome): Promise<void> {
  const at = new Date().toISOString();
  await writeJob(runDir, { ...job, ...outcome, finishedAt: at, updatedAt: at });
}

function cancelledOutcome(): Outcome {
  return { status: "cancelled", error: { message: "cancelled" } };
}

function failedOutcome(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", error: { message: message.slice(0, MAX_ERROR_LENGTH) } };
}
