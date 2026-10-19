import { z } from "zod";
import { checkTestSet, type PolicyViolation } from "../core/policy/index.js";
import {
  type DecisionReason,
  type OracleResult,
  OracleResultSchema,
  type OracleSpec,
  type SamplePhase,
  uniqueArray,
} from "../domain/index.js";
import { type CommandResult, describeResult, succeeded } from "./commands.js";
import type { TestSnapshot } from "./events.js";
import type { ArmSpec, WorkloadSession } from "./workload.js";

/**
 * Test results as a `test_pass_set` oracle command reports them: one line on stdout holding
 * `{"ufoTestResults":1,"tests":[{"id":"<unique id>","outcome":"pass"|"fail"|"skip"}]}`.
 * Other stdout lines are ignored, so a runner may print its own report as well.
 */
export const TestResultsSchema = z.strictObject({
  ufoTestResults: z.literal(1),
  tests: uniqueArray(
    z.strictObject({
      id: z
        .string()
        .min(1)
        .max(1000)
        .regex(/^[^\p{Cc}]*$/u, "must be one line"),
      outcome: z.enum(["pass", "fail", "skip"]),
    }),
    100_000,
    (test) => test.id,
    "test ids",
  ),
});
export type TestResults = z.infer<typeof TestResultsSchema>;

export interface TestOutcome {
  readonly passed: string[];
  readonly failed: string[];
  /** Ran, passed or failed; skipped tests did not run. */
  readonly executed: number;
}

export function parseTestResults(
  stdout: string,
): { ok: true; outcome: TestOutcome } | { ok: false; reason: string } {
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith("{") && line.includes('"ufoTestResults"'));
  if (lines.length !== 1) {
    return {
      ok: false,
      reason: `expected one ufoTestResults line on stdout, got ${lines.length}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? "");
  } catch {
    return { ok: false, reason: "the ufoTestResults line is not JSON" };
  }
  const parsed = TestResultsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `invalid ufoTestResults: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
    };
  }
  const passed = parsed.data.tests.filter((t) => t.outcome === "pass").map((t) => t.id);
  const failed = parsed.data.tests.filter((t) => t.outcome === "fail").map((t) => t.id);
  return { ok: true, outcome: { passed, failed, executed: passed.length + failed.length } };
}

/** The baseline pass set from two runs: tests whose outcome differs are known-flaky. */
export function snapshotFromRuns(first: TestOutcome, second: TestOutcome): TestSnapshot {
  const firstPassed = new Set(first.passed);
  const secondPassed = new Set(second.passed);
  const all = new Set([...first.passed, ...first.failed, ...second.passed, ...second.failed]);
  const passed: string[] = [];
  const knownFlaky: string[] = [];
  for (const id of all) {
    if (firstPassed.has(id) && secondPassed.has(id)) passed.push(id);
    else if (firstPassed.has(id) || secondPassed.has(id)) knownFlaky.push(id);
  }
  const secondFailed = new Set(second.failed);
  return {
    passed: passed.sort(),
    knownFlaky: knownFlaky.sort(),
    knownFailing: first.failed.filter((id) => secondFailed.has(id)).sort(),
    executed: Math.min(first.executed, second.executed),
  };
}

function summary(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length > 1000 ? `${line.slice(0, 997)}...` : line || "no output";
}

function oracleResult(
  spec: OracleSpec,
  arm: ArmSpec,
  passed: boolean,
  text: string,
  changeId?: string,
): OracleResult {
  return OracleResultSchema.parse({
    oracle: spec.name,
    sha: arm.sha,
    ...(changeId === undefined ? {} : { changeId }),
    passed,
    summary: summary(text),
  });
}

function testSummary(outcome: TestOutcome): string {
  return `${outcome.passed.length} passed, ${outcome.failed.length} failed, ${outcome.executed} executed`;
}

async function runOracle(
  session: WorkloadSession,
  spec: OracleSpec,
  arm: ArmSpec,
  phase: SamplePhase,
  label: string,
): Promise<CommandResult> {
  return session.runInArm(spec.command, arm, phase, `oracle ${spec.name}${label}`);
}

export interface BaselineOracles {
  readonly results: OracleResult[];
  readonly tests: Record<string, TestSnapshot>;
  readonly limitations: string[];
}

/**
 * The oracle snapshot at baseline: each `test_pass_set` oracle runs twice (differing tests are
 * known-flaky and recorded as limitations); a `smoke` oracle must pass. Throws when an oracle
 * cannot produce a baseline, since nothing could be checked against it.
 */
export async function snapshotOracles(
  session: WorkloadSession,
  oracles: readonly OracleSpec[],
  arm: ArmSpec,
): Promise<BaselineOracles> {
  const results: OracleResult[] = [];
  const tests: Record<string, TestSnapshot> = {};
  const limitations: string[] = [];
  for (const spec of oracles) {
    if (spec.kind === "test_pass_set") {
      const outcomes: TestOutcome[] = [];
      for (const run of [1, 2]) {
        const result = await runOracle(session, spec, arm, "baseline", ` run ${run}`);
        const parsed = parseTestResults(result.stdout);
        if (!parsed.ok) {
          throw new Error(
            `oracle ${spec.name} at baseline: ${parsed.reason}; ${describeResult(result)}`,
          );
        }
        outcomes.push(parsed.outcome);
      }
      const [first, second] = outcomes as [TestOutcome, TestOutcome];
      const snapshot = snapshotFromRuns(first, second);
      tests[spec.name] = snapshot;
      if (snapshot.knownFlaky.length > 0) {
        limitations.push(
          `oracle ${spec.name}: ${snapshot.knownFlaky.length} flaky tests excluded from the pass set: ${snapshot.knownFlaky.slice(0, 5).join(", ")}`,
        );
      }
      if (snapshot.knownFailing.length > 0) {
        limitations.push(
          `oracle ${spec.name}: ${snapshot.knownFailing.length} tests fail at baseline and are not checked`,
        );
      }
      results.push(oracleResult(spec, arm, true, testSummary(second)));
    } else {
      const result = await runOracle(session, spec, arm, "baseline", "");
      if (!succeeded(result)) {
        throw new Error(`oracle ${spec.name} fails at baseline: ${describeResult(result)}`);
      }
      results.push(oracleResult(spec, arm, true, "passed"));
    }
  }
  return { results, tests, limitations };
}

export interface CandidateOracles {
  readonly results: OracleResult[];
  /** The first failure: `policy:test_set_shrunk` or `oracle:<name>`. */
  readonly failure?: { reason: DecisionReason; detail: string };
}

/** Runs every oracle on the candidate in B, in `ufo.yaml` order, stopping at the first failure. */
export async function checkCandidate(
  session: WorkloadSession,
  oracles: readonly OracleSpec[],
  arm: ArmSpec,
  baseline: Readonly<Record<string, TestSnapshot>>,
  changeId: string,
): Promise<CandidateOracles> {
  const results: OracleResult[] = [];
  for (const spec of oracles) {
    const result = await runOracle(session, spec, arm, "change", "");
    if (spec.kind === "test_pass_set") {
      const parsed = parseTestResults(result.stdout);
      if (!parsed.ok) {
        const detail = `${parsed.reason}; ${describeResult(result)}`;
        results.push(oracleResult(spec, arm, false, detail, changeId));
        return { results, failure: { reason: `oracle:${spec.name}`, detail } };
      }
      const snapshot = baseline[spec.name];
      const shrunk: PolicyViolation | undefined =
        snapshot === undefined
          ? undefined
          : checkTestSet(
              { passed: snapshot.passed, executed: snapshot.executed },
              parsed.outcome,
              snapshot.knownFlaky,
            );
      results.push(
        oracleResult(
          spec,
          arm,
          shrunk === undefined,
          shrunk?.detail ?? testSummary(parsed.outcome),
          changeId,
        ),
      );
      if (shrunk !== undefined) {
        return { results, failure: { reason: `policy:${shrunk.rule}`, detail: shrunk.detail } };
      }
    } else {
      const ok = succeeded(result);
      const detail = ok ? "passed" : describeResult(result);
      results.push(oracleResult(spec, arm, ok, detail, changeId));
      if (!ok) return { results, failure: { reason: `oracle:${spec.name}`, detail } };
    }
  }
  return { results };
}
