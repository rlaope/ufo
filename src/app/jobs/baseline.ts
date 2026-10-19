import { DecideInputError, MAX_NOISE_FLOOR, median, noiseFloor } from "../../core/decide/index.js";
import { resetArms } from "../../core/git/index.js";
import { appendLedger, type JobRecord } from "../../core/jobs/index.js";
import { PolicyError } from "../../core/policy/index.js";
import type { JobContext } from "../../worker/index.js";
import { describeResult, succeeded } from "../commands.js";
import { type BaselineData, EVENTS } from "../events.js";
import { snapshotOracles } from "../oracles.js";
import { approvalViolation, jsonData, openRun, toJson } from "../state.js";
import { BASELINE_SAMPLES, type HandlerOptions, newSession } from "./shared.js";

export interface BaselineResult {
  sha: string;
  values: number[];
  median: number;
  noiseFloor?: number;
  /** Set when the noise floor is above 10%: decisions will be refused (`policy:noise_floor`). */
  refusal?: { reason: string; detail: string };
  oracles: { oracle: string; passed: boolean; summary?: string }[];
  limitations: string[];
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Baseline at arm A (plan §2.3 step 4): setup, the oracle snapshot (tests twice), then five
 * workload samples and the noise floor. Invalid samples are recorded even when the baseline
 * fails.
 */
export async function handleBaseline(
  job: JobRecord,
  context: JobContext,
  options: HandlerOptions,
): Promise<BaselineResult> {
  void job;
  const open = await openRun(options.home, context.runDir);
  const unapproved = await approvalViolation(open);
  if (unapproved !== undefined) throw new PolicyError(unapproved);
  // Whatever was written into the arms since they were last used is discarded first, so the
  // measured A is exactly its commit (security F11).
  const sha = await resetArms(open.git);
  const arm = { arm: "a" as const, dir: open.git.armA, sha };
  const session = newSession(open, context, options.machine);
  let data: BaselineData;
  try {
    context.setProgress({ done: 0, total: 3, message: "setup" });
    const setup = await session.setup(arm, "baseline");
    if (setup !== undefined && !succeeded(setup)) {
      throw new Error(`workload setup fails at baseline: ${describeResult(setup)}`);
    }
    context.setProgress({ done: 1, total: 3, message: "oracles" });
    const oracles = await snapshotOracles(session, open.config.oracles, arm);
    context.setProgress({ done: 2, total: 3, message: "measuring" });
    await session.start(arm, "baseline");
    const values = await session.sampleArm(arm, BASELINE_SAMPLES, "baseline");
    let floor: number | undefined;
    let refusal: BaselineData["refusal"];
    try {
      floor = noiseFloor(values);
      if (floor > MAX_NOISE_FLOOR) {
        refusal = {
          reason: "policy:noise_floor",
          detail: `noise floor ${percent(floor)} exceeds ${percent(MAX_NOISE_FLOOR)}; likely cause: ${await session.noiseCause()}`,
        };
      }
    } catch (error) {
      if (!(error instanceof DecideInputError)) throw error;
      refusal = { reason: "policy:noise_floor", detail: `no noise floor: ${error.message}` };
    }
    data = {
      sha,
      values,
      median: median(values),
      ...(floor === undefined ? {} : { noiseFloor: floor }),
      ...(refusal === undefined ? {} : { refusal }),
      tests: oracles.tests,
      samples: session.samples,
      oracleResults: oracles.results,
      limitations: oracles.limitations,
      commands: [...session.commands],
    };
  } catch (error) {
    await appendLedger(context.runDir, {
      type: EVENTS.baselineFailed,
      data: jsonData({
        sha,
        message: error instanceof Error ? error.message : String(error),
        samples: session.samples,
        commands: [...session.commands],
      }),
    });
    throw error;
  } finally {
    await session.teardown("baseline");
  }
  await appendLedger(context.runDir, { type: EVENTS.baselineMeasured, data: jsonData(data) });
  // A measure-only run ends here; its caller closes it.
  if (open.state.purpose === "measure") context.exitAfterJob();
  return toJson({
    sha,
    values: data.values,
    median: data.median,
    ...(data.noiseFloor === undefined ? {} : { noiseFloor: data.noiseFloor }),
    ...(data.refusal === undefined ? {} : { refusal: data.refusal }),
    oracles: data.oracleResults.map(({ oracle, passed, summary }) => ({
      oracle,
      passed,
      ...(summary === undefined ? {} : { summary }),
    })),
    limitations: data.limitations,
  });
}
