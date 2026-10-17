import { type PolicyViolation, preview, violation } from "./rules.js";

export interface TestRun {
  /** Ids of the tests that passed. */
  readonly passed: Iterable<string>;
  /** How many tests ran, whatever their outcome. */
  readonly executed: number;
}

function checkCount(name: string, count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${count}`);
  }
}

/**
 * The candidate must pass every test that passed at baseline (except known-flaky ones) and run
 * at least as many tests. Deleting, skipping, or breaking a test is a violation even when the
 * change is faster.
 */
export function checkTestSet(
  baseline: TestRun,
  candidate: TestRun,
  knownFlaky: Iterable<string> = [],
): PolicyViolation | undefined {
  checkCount("baseline executed", baseline.executed);
  checkCount("candidate executed", candidate.executed);
  const flaky = new Set(knownFlaky);
  const passed = new Set(candidate.passed);
  const lost = [...new Set(baseline.passed)]
    .filter((test) => !flaky.has(test) && !passed.has(test))
    .sort();
  const problems: string[] = [];
  if (lost.length > 0) {
    problems.push(`${lost.length} baseline-passing tests are missing or failing: ${preview(lost)}`);
  }
  if (candidate.executed < baseline.executed) {
    problems.push(`${candidate.executed} tests ran, ${baseline.executed} at baseline`);
  }
  return problems.length > 0 ? violation("test_set_shrunk", problems.join("; "), lost) : undefined;
}
