import path from "node:path";
import { resetArms } from "../../core/git/index.js";
import { ARTIFACTS_DIR, type JobRecord, writeJsonAtomic } from "../../core/jobs/index.js";
import { PolicyError } from "../../core/policy/index.js";
import type { JobContext } from "../../worker/index.js";
import { describeResult, succeeded } from "../commands.js";
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
}

/**
 * `profile_target`: the run's workload once in arm A at its commit, with the run's command
 * environment, timing each step. Decides nothing and is no technique (`profileTarget` keeps it
 * within the wall-clock budget); the result is kept as an artifact in the run state.
 */
export async function handleProfile(
  job: JobRecord,
  context: JobContext,
  options: HandlerOptions,
): Promise<ProfileResult> {
  const open = await openRun(options.home, context.runDir);
  const unapproved = await approvalViolation(open);
  if (unapproved !== undefined) throw new PolicyError(unapproved);
  // As every job: A is measured exactly at its commit (security F11).
  const sha = await resetArms(open.git);
  const arm = { arm: "a" as const, dir: open.git.armA, sha };
  const { workload } = open.config;
  const session = newSession(open, context, options.machine);
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
  const result = toJson({ sha, phases, sample, artifact });
  await writeJsonAtomic(path.join(context.runDir, artifact), result);
  return result;
}
