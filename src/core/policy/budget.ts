import type { Budget } from "../../domain/index.js";
import { type PolicyViolation, violation } from "./rules.js";

/** What a run has used of its budget. Plain data, so it can be persisted in the ledger. */
export interface BudgetCounter {
  readonly limits: Budget;
  readonly techniques: number;
  readonly wallClockMs: number;
}

export interface BudgetSpend {
  readonly techniques?: number;
  readonly wallClockMs?: number;
}

export function startBudget(limits: Budget): BudgetCounter {
  return { limits, techniques: 0, wallClockMs: 0 };
}

function checkSpend(name: string, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`${name} spend must be a non-negative number, got ${amount}`);
  }
}

/**
 * Adds `spent` to the counter. Reaching a cap is a violation: the run stops and asks before it
 * continues.
 */
export function consume(
  counter: BudgetCounter,
  spent: BudgetSpend,
): { counter: BudgetCounter; violation: PolicyViolation | undefined } {
  const techniques = spent.techniques ?? 0;
  const wallClockMs = spent.wallClockMs ?? 0;
  checkSpend("techniques", techniques);
  checkSpend("wall-clock", wallClockMs);
  const next: BudgetCounter = {
    limits: counter.limits,
    techniques: counter.techniques + techniques,
    wallClockMs: counter.wallClockMs + wallClockMs,
  };
  const { maxTechniques, wallClockMinutes } = next.limits;
  const problems: string[] = [];
  if (next.techniques >= maxTechniques) {
    problems.push(`${next.techniques} of ${maxTechniques} techniques tried`);
  }
  if (next.wallClockMs >= wallClockMinutes * 60_000) {
    problems.push(`${Math.floor(next.wallClockMs / 60_000)} of ${wallClockMinutes} minutes used`);
  }
  return {
    counter: next,
    violation: problems.length > 0 ? violation("budget_exceeded", problems.join("; ")) : undefined,
  };
}
