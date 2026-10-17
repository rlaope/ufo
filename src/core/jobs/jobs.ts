import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdSchema } from "../../domain/index.js";
import { readJsonIfExists, writeJsonAtomic } from "./atomic-file.js";
import { JOBS_DIR } from "./paths.js";
import { PidSchema } from "./process.js";
import { withRunLock } from "./run-record.js";

const IsoSchema = z.iso.datetime({ offset: true });

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** `job-000001`: the zero-padded sequence number, so ids sort in claim order. */
export const JobIdSchema = z.string().regex(/^job-\d{6,9}$/, "must be a job id");

export const JobProgressSchema = z.strictObject({
  done: z.number().min(0),
  total: z.number().min(0).optional(),
  message: z.string().max(1000).optional(),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const JobRecordSchema = z.strictObject({
  jobId: JobIdSchema,
  seq: z.number().int().min(1),
  /** Selects the worker's handler, e.g. `baseline`, `submit_change`, `finish`. */
  kind: IdSchema,
  input: z.json(),
  status: JobStatusSchema,
  progress: JobProgressSchema.optional(),
  result: z.json().optional(),
  error: z.strictObject({ message: z.string().max(4000) }).optional(),
  workerPid: PidSchema.optional(),
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
  startedAt: IsoSchema.optional(),
  finishedAt: IsoSchema.optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export function jobIdFor(seq: number): string {
  return `job-${String(seq).padStart(6, "0")}`;
}

function jobFile(runDir: string, jobId: string): string {
  return path.join(runDir, JOBS_DIR, `${JobIdSchema.parse(jobId)}.json`);
}

/**
 * Adds a queued job with the next sequence number. Runs under the run lock, which the worker
 * also holds when it decides to exit, so a job is never enqueued unseen by an exiting worker.
 */
export function enqueueJob(
  runDir: string,
  request: { kind: string; input: z.input<typeof JobRecordSchema>["input"] },
  now: Date = new Date(),
): Promise<JobRecord> {
  return withRunLock(runDir, async () => {
    const jobs = await listJobs(runDir);
    const seq = (jobs.at(-1)?.seq ?? 0) + 1;
    const at = now.toISOString();
    const job = JobRecordSchema.parse({
      jobId: jobIdFor(seq),
      seq,
      kind: request.kind,
      input: request.input,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    });
    await writeJob(runDir, job);
    return job;
  });
}

export async function readJob(runDir: string, jobId: string): Promise<JobRecord> {
  const value = await readJsonIfExists(jobFile(runDir, jobId));
  if (value === undefined) throw new Error(`unknown job ${jobId}`);
  return JobRecordSchema.parse(value);
}

/** Replaces a job record. Only the worker writes a job after it was enqueued. */
export async function writeJob(runDir: string, job: JobRecord): Promise<void> {
  const parsed = JobRecordSchema.parse(job);
  await writeJsonAtomic(jobFile(runDir, parsed.jobId), parsed);
}

/** All jobs in sequence order. Temp files of in-flight writes are skipped. */
export async function listJobs(runDir: string): Promise<JobRecord[]> {
  const names = await readdir(path.join(runDir, JOBS_DIR));
  const ids = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => JobIdSchema.safeParse(id).success);
  const jobs = await Promise.all(ids.map((id) => readJob(runDir, id)));
  return jobs.sort((x, y) => x.seq - y.seq);
}

/** Long-poll bound. Host agents time out tool calls; 25 s stays below every known limit. */
export const MAX_WAIT_S = 25;

export function clampWaitS(waitS: number): number {
  return Number.isFinite(waitS) ? Math.min(Math.max(waitS, 0), MAX_WAIT_S) : 0;
}

/**
 * Returns the job once it reaches a terminal status, or its current record after `waitS`
 * seconds (clamped to `MAX_WAIT_S`), whichever comes first.
 */
export async function waitForJob(
  runDir: string,
  jobId: string,
  waitS: number,
  options: { pollMs?: number } = {},
): Promise<JobRecord> {
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + clampWaitS(waitS) * 1000;
  for (;;) {
    const job = await readJob(runDir, jobId);
    const remaining = deadline - Date.now();
    if (TERMINAL_JOB_STATUSES.has(job.status) || remaining <= 0) return job;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}
