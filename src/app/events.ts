import { z } from "zod";
import { COMMITTED_EVENT, type LedgerEvent } from "../core/jobs/index.js";
import {
  type BudgetCounter,
  consume,
  type PolicyViolation,
  startBudget,
  violation,
} from "../core/policy/index.js";
import {
  type Budget,
  ChangeSchema,
  CommandLineSchema,
  DecisionSchema,
  GitShaSchema,
  IdSchema,
  MAX_TECHNIQUES,
  MAX_WALL_CLOCK_MINUTES,
  OracleResultSchema,
  SampleSchema,
} from "../domain/index.js";

// Ledger event types the app writes, and the shape of their `data`. Events are append-only:
// whatever a job learned stays in the ledger even when the run is cancelled.
export const EVENTS = {
  baselineMeasured: "baseline_measured",
  baselineFailed: "baseline_failed",
  changeStarted: "change_started",
  decision: "decision",
  committed: COMMITTED_EVENT,
  budgetExtended: "budget_extended",
  /** The card's reset hook failed after a recorded drop. */
  resetFailed: "reset_failed",
  /** B was reset and the card's reset hook ran after a recorded drop. */
  resetDone: "reset_done",
  /** Removing an ended run's arms failed; the next start tries again. */
  cleanupFailed: "cleanup_failed",
  /** A start cut short was found and ended by a later start or a cancel. */
  startAbandoned: "start_abandoned",
  finalCheck: "final_check",
  runFinished: "run_finished",
  runCancelled: "run_cancelled",
  runResumed: "run_resumed",
  jobRequeued: "job_requeued",
} as const;

const TestIdSchema = z.string().min(1).max(1000);

/** The baseline pass set of one `test_pass_set` oracle. */
export const TestSnapshotSchema = z.strictObject({
  /** Passed in both baseline runs. */
  passed: z.array(TestIdSchema),
  /** Different outcomes in the two baseline runs: excluded from the pass set. */
  knownFlaky: z.array(TestIdSchema),
  /** Failed in both baseline runs. */
  knownFailing: z.array(TestIdSchema),
  /** Tests executed (passed or failed) in the smaller of the two runs. */
  executed: z.number().int().min(0),
});
export type TestSnapshot = z.infer<typeof TestSnapshotSchema>;

const CommandsSchema = z.array(CommandLineSchema).max(256);

export const BaselineDataSchema = z.strictObject({
  sha: GitShaSchema,
  values: z.array(z.number().min(0)).min(1),
  median: z.number(),
  noiseFloor: z.number().min(0).optional(),
  refusal: z.strictObject({ reason: z.string(), detail: z.string() }).optional(),
  tests: z.record(IdSchema, TestSnapshotSchema),
  samples: z.array(SampleSchema),
  oracleResults: z.array(OracleResultSchema),
  limitations: z.array(z.string()),
  commands: CommandsSchema,
});
export type BaselineData = z.infer<typeof BaselineDataSchema>;

export const ChangeStartedDataSchema = z.strictObject({
  change: ChangeSchema,
  source: z.enum(["agent", "recipe"]),
});

export const DecisionDataSchema = z.strictObject({
  decision: DecisionSchema,
  cardId: IdSchema,
  /** The change got past the policy checks; it counts against the technique cap. */
  attempted: z.boolean(),
  /** A measured drop: B is reset and the card's reset hook runs after this record. */
  cleanupDue: z.boolean(),
  samples: z.array(SampleSchema),
  oracleResults: z.array(OracleResultSchema),
  commands: CommandsSchema,
});
export type DecisionData = z.infer<typeof DecisionDataSchema>;

export const BudgetExtendedDataSchema = z.strictObject({
  maxTechniques: z.number().int().min(1).max(MAX_TECHNIQUES),
  wallClockMinutes: z.number().int().min(1).max(MAX_WALL_CLOCK_MINUTES),
});

export const FinalCheckDataSchema = z.strictObject({
  baselineSha: GitShaSchema,
  finalSha: GitShaSchema,
  samples: z.array(SampleSchema),
  commands: CommandsSchema,
});

function dataOf<T extends z.ZodType>(event: LedgerEvent, schema: T): z.output<T> {
  return schema.parse(event.data);
}

/** The latest completed baseline. */
export function latestBaseline(events: readonly LedgerEvent[]): BaselineData | undefined {
  const event = events.findLast((e) => e.type === EVENTS.baselineMeasured);
  return event === undefined ? undefined : dataOf(event, BaselineDataSchema);
}

export function decisionsOf(events: readonly LedgerEvent[]): DecisionData[] {
  return events.filter((e) => e.type === EVENTS.decision).map((e) => dataOf(e, DecisionDataSchema));
}

export function decisionFor(
  events: readonly LedgerEvent[],
  changeId: string,
): DecisionData | undefined {
  const event = events.findLast((e) => e.type === EVENTS.decision && e.changeId === changeId);
  return event === undefined ? undefined : dataOf(event, DecisionDataSchema);
}

export function startedChanges(events: readonly LedgerEvent[]) {
  return events
    .filter((e) => e.type === EVENTS.changeStarted)
    .map((e) => dataOf(e, ChangeStartedDataSchema));
}

export function committedChangeIds(events: readonly LedgerEvent[]): Set<string> {
  return new Set(
    events.filter((e) => e.type === EVENTS.committed && e.changeId).map((e) => e.changeId ?? ""),
  );
}

/**
 * Primary-metric values at the current A, for the noise floor: the B values of the latest kept
 * change (fewer than five when it was a deterministic keep), or the latest baseline before any
 * keep. Never an older keep's values: they were measured at an earlier A.
 */
export function currentNoiseValues(events: readonly LedgerEvent[]): number[] {
  const kept = decisionsOf(events).findLast((d) => d.decision.outcome === "keep");
  if (kept !== undefined) return kept.decision.pairs.map((pair) => pair.b);
  return latestBaseline(events)?.values ?? [];
}

export interface BudgetStatus {
  readonly limits: Budget;
  readonly counter: BudgetCounter;
  /** Set once a cap is reached: the run stops until `extendBudget` raises it. */
  readonly violation: PolicyViolation | undefined;
}

/**
 * `budget_exceeded` once the wall-clock budget is spent, whatever the technique count: work that
 * is no technique (a profile) still runs only within the run's time (security N2).
 */
export function wallClockViolation(status: BudgetStatus): PolicyViolation | undefined {
  const { wallClockMs } = status.counter;
  const { wallClockMinutes } = status.limits;
  if (wallClockMs < wallClockMinutes * 60_000) return undefined;
  return violation(
    "budget_exceeded",
    `${Math.floor(wallClockMs / 60_000)} of ${wallClockMinutes} minutes used`,
  );
}

/**
 * Techniques tried (changes that got past the policy checks) and wall-clock time against the
 * budget, with every `budget_extended` raise applied. `pending` counts queued changes too.
 */
export function budgetStatus(
  events: readonly LedgerEvent[],
  budget: Budget,
  startedAt: string,
  options: { pending?: number; now?: Date } = {},
): BudgetStatus {
  let limits = budget;
  for (const event of events) {
    if (event.type !== EVENTS.budgetExtended) continue;
    // A raise the schema rejects changes nothing: the ledger is append-only, so a throw here
    // would make the run unusable for good.
    const raise = BudgetExtendedDataSchema.safeParse(event.data);
    if (raise.success) limits = raise.data;
  }
  const tried = decisionsOf(events).filter((d) => d.attempted).length;
  const elapsed = Math.max(0, (options.now ?? new Date()).getTime() - Date.parse(startedAt));
  const { counter, violation } = consume(startBudget(limits), {
    techniques: tried + (options.pending ?? 0),
    wallClockMs: elapsed,
  });
  return {
    limits,
    counter,
    // The detail is recorded in decisions; how to raise the budget is the failure's hint
    // (`hintFor`), which adapters add.
    violation,
  };
}
