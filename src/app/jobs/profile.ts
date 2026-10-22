import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createTextRedactor } from "../../core/evidence/index.js";
import { resetArms } from "../../core/git/index.js";
import {
  ARTIFACTS_DIR,
  type JobRecord,
  readLedger,
  readRun,
  writeJsonAtomic,
} from "../../core/jobs/index.js";
import { PolicyError } from "../../core/policy/index.js";
import { type FileHotspots, type Parsed, readProfileDir } from "../../core/profile/index.js";
import { type ProfileFormat, profiledSteps } from "../../domain/index.js";
import type { JobContext } from "../../worker/index.js";
import { describeResult, succeeded } from "../commands.js";
import { resolveRepo } from "../context.js";
import { budgetStatus, wallClockViolation } from "../events.js";
import { convertJfr, findJfr, profileSettings } from "../profiler.js";
import { approvalViolation, openRun, toJson } from "../state.js";
import { type HandlerOptions, newSession } from "./shared.js";

export interface ProfileResult {
  /** Arm A's commit, which the workload ran at. */
  sha: string;
  /** Wall time of each workload step UFO ran, in order: setup, start, sample, teardown. */
  phases: { phase: "setup" | "start" | "sample" | "teardown"; ms: number }[];
  /**
   * The workload's JSON line as UFO read it, the primary metric first, as name and value pairs
   * (the names are the repository's, so they are values, never keys); or why it is not valid.
   */
  sample:
    | { valid: true; values: { name: string; value: number }[] }
    | { valid: false; reason: string };
  /** Where the profile is kept, relative to the run state directory. */
  artifact: string;
  /**
   * With `workload.profile` only: what the profiler wrote into the job's profile directory,
   * the heaviest files first, the others counted in `omitted`. Frame names are the
   * repository's text.
   */
  hotspots?: {
    format: ProfileFormat;
    /** The profile directory, relative to the run state directory. */
    dir: string;
    files: FileHotspots[];
    omitted: number;
    /** Why no file was read: the workload made the directory unreadable or replaced it. */
    reason?: string;
  };
}

/**
 * `profile_target`: the run's workload once in arm A at its commit, with the run's command
 * environment, timing each step. Decides nothing and is no technique, but runs only within the
 * wall-clock budget, checked when it is queued and again when it starts; the result is kept as
 * an artifact in the run state. With `workload.profile`, the job's own directory in the run
 * state (outside both arms) is `UFO_PROFILE_DIR` for every step, the profile's variables go to
 * the profiled steps, and the files written there are read for hot spots (JFR recordings through
 * the JDK's `jfr print`, after teardown).
 */
export async function handleProfile(
  job: JobRecord,
  context: JobContext,
  options: HandlerOptions,
): Promise<ProfileResult> {
  const open = await openRun(options.home, context.runDir);
  const unapproved = await approvalViolation(open);
  if (unapproved !== undefined) throw new PolicyError(unapproved);
  // A profile queued before the wall clock ran out does not run after it (security S2-4).
  const { createdAt } = await readRun(context.runDir);
  const spent = wallClockViolation(
    budgetStatus(await readLedger(context.runDir), open.config.objective.budget, createdAt),
  );
  if (spent !== undefined) throw new PolicyError(spent);
  // As every job: A is measured exactly at its commit (security F11).
  const sha = await resetArms(open.git);
  const arm = { arm: "a" as const, dir: open.git.armA, sha };
  const { workload } = open.config;
  const { profile } = workload;
  const profileDir = path.join(ARTIFACTS_DIR, `profile-${job.jobId}`);
  const dir = path.join(context.runDir, profileDir);
  if (profile !== undefined) {
    // A requeued job starts with an empty directory, not with what an interrupted one wrote.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
  }
  const settings =
    profile === undefined ? undefined : profileSettings(profile, dir, open.state.env);
  const session = newSession(
    open,
    context,
    options.machine,
    settings === undefined ? undefined : { dir, env: settings.env, steps: profiledSteps(workload) },
  );
  const phases: ProfileResult["phases"] = [];
  const timed = async <T>(
    phase: ProfileResult["phases"][number]["phase"],
    step: () => Promise<T>,
  ) => {
    const started = performance.now();
    try {
      return await step();
    } finally {
      phases.push({ phase, ms: Math.round(performance.now() - started) });
    }
  };
  let sample: ProfileResult["sample"];
  try {
    if (workload.setup !== undefined) {
      context.setProgress({ done: 0, total: 3, message: "setup" });
      const setup = await timed("setup", () => session.setup(arm, "profile"));
      if (setup !== undefined && !succeeded(setup)) {
        throw new Error(`workload setup fails: ${describeResult(setup)}`);
      }
    }
    const { start, healthcheck, warmup } = workload;
    if (start !== undefined || healthcheck !== undefined || warmup !== undefined) {
      context.setProgress({ done: 1, total: 3, message: "start" });
      await timed("start", () => session.start(arm, "profile"));
    }
    context.setProgress({ done: 2, total: 3, message: "sample" });
    const outcome = await timed("sample", () => session.sample(arm, 0, "profile"));
    const recorded = session.samples.at(-1);
    sample =
      outcome.valid && recorded !== undefined
        ? {
            valid: true,
            values: [
              { name: recorded.metric, value: recorded.value },
              ...Object.entries(recorded.secondary).map(([name, value]) => ({ name, value })),
            ],
          }
        : { valid: false, reason: outcome.valid ? "no sample was recorded" : outcome.reason };
  } finally {
    await timed("teardown", () => session.teardown("profile"));
  }
  const artifact = path.join(ARTIFACTS_DIR, `profile-${job.jobId}.json`);
  const result: ProfileResult = { sha, phases, sample, artifact };
  if (settings !== undefined) {
    // Names are redacted whole before they are cut, with the run's command environment too.
    const redact = createTextRedactor({ env: { ...process.env, ...open.state.env } });
    // A JFR recording is read by the JDK's jfr tool, with the run's command environment.
    let convert: ((file: string) => Promise<Parsed>) | undefined;
    if (settings.format === "jfr") {
      // The roots the run's PATH was captured without.
      const repo = await resolveRepo(open.git.repoRoot);
      const jfr = await findJfr(open.state.env, [
        repo.root,
        repo.gitDir,
        repo.commonDir,
        options.home,
      ]);
      convert = (file) =>
        convertJfr(file, {
          jfr,
          env: open.state.env,
          runDir: context.runDir,
          cwd: dir,
          signal: context.signal,
          redact,
        });
    }
    result.hotspots = {
      format: settings.format,
      dir: profileDir,
      // Paths in arm A are named relative to the repository. A directory the workload made
      // unreadable or replaced (never followed) costs the hot spots, not the phases and sample.
      ...(await readProfileDir(
        dir,
        settings.format,
        [`file://${arm.dir}/`, `${arm.dir}/`],
        redact,
        convert,
      ).catch((error: unknown) => {
        // A cancelled job stops here, not with a reason.
        context.signal.throwIfAborted();
        const code = (error as { code?: unknown }).code;
        return {
          files: [],
          omitted: 0,
          reason:
            code === "unsafe_state"
              ? "the workload replaced the profile directory; UFO does not follow it"
              : `the profile directory cannot be read (${typeof code === "string" ? code : "error"})`,
        };
      })),
    };
  }
  const json = toJson(result);
  await writeJsonAtomic(path.join(context.runDir, artifact), json);
  return json;
}
