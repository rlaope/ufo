import { z } from "zod";
import {
  DecideInputError,
  decideDeterministic,
  decideStochastic,
  INITIAL_PAIRS,
  MAX_NOISE_FLOOR,
  MIN_NOISE_SAMPLES,
  noiseFloor,
  type StochasticResult,
} from "../../core/decide/index.js";
import {
  applyToB,
  commitKeep,
  diffFromFiles,
  headOfA,
  listChangeIds,
  readFileAtA,
  resetArms,
  revertB,
} from "../../core/git/index.js";
import {
  appendLedger,
  type JobRecord,
  readLedger,
  readRun,
  updateRun,
} from "../../core/jobs/index.js";
import { MeasurementError, type RunSample, runInterleaved } from "../../core/measure/index.js";
import {
  checkOptIn,
  checkPaths,
  checkProtectedPaths,
  protectedPathsFor,
  violation,
} from "../../core/policy/index.js";
import {
  type Change,
  ChangeSchema,
  type Decision,
  GitShaSchema,
  HypothesisSchema,
  IdSchema,
  type OracleResult,
  type Pair,
  RepoPathSchema,
  type TechniqueCard,
  UnifiedDiffSchema,
} from "../../domain/index.js";
import {
  applyRecipeEdits,
  defaultParams,
  RecipeEditError,
  resolveCard,
  substitute,
} from "../../techniques/index.js";
import type { JobContext } from "../../worker/index.js";
import { describeResult, succeeded } from "../commands.js";
import {
  budgetStatus,
  currentNoiseValues,
  type DecisionData,
  decisionFor,
  EVENTS,
  latestBaseline,
} from "../events.js";
import { checkCandidate } from "../oracles.js";
import { configProtectedPaths } from "../script-tables.js";
import { approvalViolation, jsonData, type OpenRun, openRun, toJson } from "../state.js";
import { type ArmSpec, WorkloadError, type WorkloadSession } from "../workload.js";
import {
  guardrailChecks,
  type HandlerOptions,
  metricTrailer,
  newSession,
  refusal,
  unmeasured,
} from "./shared.js";

const changeJobFields = {
  changeId: z.uuid(),
  cardId: IdSchema,
  hypothesis: HypothesisSchema,
  evidenceRefs: z.array(RepoPathSchema).max(32).default([]),
  baseSha: GitShaSchema.optional(),
};

/** `agent`: a diff from `submitChange`; `recipe`: UFO computes the diff from the card's edits. */
export const ChangeJobInputSchema = z.discriminatedUnion("source", [
  z.strictObject({ ...changeJobFields, source: z.literal("agent"), diff: UnifiedDiffSchema }),
  z.strictObject({ ...changeJobFields, source: z.literal("recipe") }),
]);
export type ChangeJobInput = z.input<typeof ChangeJobInputSchema>;

export interface ChangeResult {
  changeId: string;
  cardId: string;
  decision: Decision;
  /** The commit on the run branch when the change was kept. */
  commit?: string;
}

/** The cards the run's approved ufo.yaml enables, from the catalog captured at start. */
function enabledCards(open: OpenRun): TechniqueCard[] {
  return open.config.cards.flatMap((id) => {
    const card = open.catalog.cards.get(id);
    return card === undefined ? [] : [card];
  });
}

/** The card's reset hook: its command template with id `reset`, run in B after a drop. */
const RESET_TEMPLATE_ID = "reset";

interface Outcome {
  decision: Decision;
  attempted: boolean;
  change?: Change;
  samples?: DecisionData["samples"];
  oracleResults?: OracleResult[];
  commands?: string[];
  /** Resets B and runs the card's reset hook after a measured drop; runs once it is recorded. */
  cleanup?: () => Promise<void>;
}

/**
 * Decides one change (plan §2.3 steps 7–8): policy (approval, card, opt-in, budget, protected
 * paths) →
 * apply to B → protected-path backstop on git's own list → setup in both arms (B failing is
 * `build_failed`) → oracles in B → interleaved measurement with at most one escalation →
 * decision. The decision is recorded first. A keep is then committed and the commit recorded
 * (`change_committed`); anything else then resets B and runs the card's reset hook, whose
 * failure is recorded as its own event and fails the job without losing the decision. A job
 * re-run after a crash returns the recorded decision instead of measuring again, and commits a
 * recorded keep that never reached the run branch.
 */
export async function handleChange(
  job: JobRecord,
  context: JobContext,
  options: HandlerOptions,
): Promise<ChangeResult> {
  const input = ChangeJobInputSchema.parse(job.input);
  const open = await openRun(options.home, context.runDir);
  const events = await readLedger(context.runDir);
  const recorded = decisionFor(events, input.changeId);
  if (recorded !== undefined) {
    return completeRecorded(open, input, recorded, events, context, options);
  }

  const outcome = await decide(open, input, context, options, events);
  await appendLedger(context.runDir, {
    type: EVENTS.decision,
    changeId: input.changeId,
    data: jsonData({
      decision: outcome.decision,
      cardId: input.cardId,
      attempted: outcome.attempted,
      samples: outcome.samples ?? [],
      oracleResults: outcome.oracleResults ?? [],
      commands: outcome.commands ?? [],
    } satisfies DecisionData),
  });
  if (outcome.decision.outcome === "keep" && outcome.change !== undefined) {
    const commit = await commitAndRecord(open, outcome.change, outcome.decision);
    return toJson({
      changeId: input.changeId,
      cardId: input.cardId,
      decision: outcome.decision,
      commit,
    });
  }
  if (outcome.cleanup !== undefined) await cleanUpDrop(context, input.changeId, outcome.cleanup);
  return toJson({ changeId: input.changeId, cardId: input.cardId, decision: outcome.decision });
}

/**
 * Runs a recorded drop's cleanup (revert B, the card's reset hook) and records how it went:
 * `reset_done`, or `reset_failed` and the job fails. A job re-run after a crash between the
 * decision and this record runs the cleanup again (see `completeRecorded`).
 */
async function cleanUpDrop(
  context: JobContext,
  changeId: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    await appendLedger(context.runDir, {
      type: EVENTS.resetFailed,
      changeId,
      data: { message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) },
    });
    throw error;
  }
  await appendLedger(context.runDir, { type: EVENTS.resetDone, changeId });
}

async function commitAndRecord(open: OpenRun, change: Change, decision: Decision): Promise<string> {
  const sha = await commitKeep(open.git, change, {
    metric: metricTrailer(open.config.objective.primary, decision.pairs),
    bundle: open.state.bundleId,
  });
  await appendLedger(open.runDir, {
    type: EVENTS.committed,
    changeId: change.changeId,
    data: { sha },
  });
  await updateRun(open.runDir, (run) => ({ ...run, shas: { ...run.shas, a: sha, b: sha } }));
  return sha;
}

function notCommitted(changeId: string, why: string): never {
  throw new Error(`not committing the recorded keep of ${changeId}: ${why}`);
}

/**
 * A change decided before a crash: return the decision, committing a keep if it is missing.
 * The ledger is not trusted to carry code past the checks: a keep is committed only when the
 * recorded change is the one this job (the trusted job record) enqueued, and it passes the
 * approval, card, opt-in, and protected-path checks a new change gets. Otherwise the job fails
 * and nothing is committed.
 */
async function completeRecorded(
  open: OpenRun,
  input: z.output<typeof ChangeJobInputSchema>,
  recorded: DecisionData,
  events: Awaited<ReturnType<typeof readLedger>>,
  context: JobContext,
  options: HandlerOptions,
): Promise<ChangeResult> {
  const result = { changeId: input.changeId, cardId: input.cardId, decision: recorded.decision };
  if (recorded.decision.outcome !== "keep") {
    // A drop recorded right before a crash: its cleanup (the card's reset hook) may never have
    // run. Run it now unless the ledger says how it went.
    const settled = events.some(
      (e) =>
        e.changeId === input.changeId &&
        (e.type === EVENTS.resetDone || e.type === EVENTS.resetFailed),
    );
    const resolved = resolveCard(open.catalog, input.cardId, open.config.cards);
    if (recorded.attempted && !settled && !("violation" in resolved)) {
      const session = newSession(open, context, options.machine);
      const armB: ArmSpec = { arm: "b", dir: open.git.armB, sha: await headOfA(open.git) };
      await cleanUpDrop(context, input.changeId, () =>
        dropChange(open, resolved.card, session, armB),
      );
    }
    return toJson(result);
  }
  const onBranch = (await listChangeIds(open.git)).find((c) => c.changeId === input.changeId);
  if (onBranch !== undefined) return toJson({ ...result, commit: onBranch.sha });
  const started = events.findLast(
    (e) => e.type === EVENTS.changeStarted && e.changeId === input.changeId,
  );
  const change = ChangeSchema.parse((started?.data as { change?: unknown } | undefined)?.change);
  if (recorded.cardId !== input.cardId || change.cardId !== input.cardId) {
    notCommitted(
      input.changeId,
      `the ledger names card ${change.cardId}, but the job enqueued ${input.cardId}`,
    );
  }
  if (input.source === "agent" && change.diff !== input.diff) {
    notCommitted(input.changeId, "the recorded diff is not the one the job enqueued");
  }
  const unapproved = await approvalViolation(open);
  if (unapproved !== undefined)
    notCommitted(input.changeId, `policy:${unapproved.rule}: ${unapproved.detail}`);
  const resolved = resolveCard(open.catalog, input.cardId, open.config.cards);
  if ("violation" in resolved) {
    notCommitted(input.changeId, `policy:${resolved.violation.rule}: ${resolved.violation.detail}`);
  }
  const { card } = resolved;
  if (input.source === "recipe") {
    const files = await applyRecipeEdits(card, (file) => readFileAtA(open.git, file));
    if ((await diffFromFiles(open.git, files)) !== change.diff) {
      notCommitted(input.changeId, "the recorded diff is not what the card's edits produce");
    }
  }
  const optIn = checkOptIn(card.riskClass, open.optIns);
  if (optIn !== undefined) notCommitted(input.changeId, `policy:${optIn.rule}: ${optIn.detail}`);
  const protectedGlobs = protectedPathsFor(
    card.riskClass,
    open.optIns,
    configProtectedPaths(open.config, enabledCards(open)),
  );
  const before = checkProtectedPaths(change.diff, protectedGlobs);
  if (before !== undefined) notCommitted(input.changeId, `policy:${before.rule}: ${before.detail}`);
  const applied = await applyToB(open.git, change);
  if (!applied.ok) notCommitted(input.changeId, `it no longer applies: ${applied.detail}`);
  const after = checkPaths(applied.changedPaths, protectedGlobs);
  if (after !== undefined) {
    await revertB(open.git);
    notCommitted(input.changeId, `policy:${after.rule}: ${after.detail}`);
  }
  return toJson({ ...result, commit: await commitAndRecord(open, change, recorded.decision) });
}

async function decide(
  open: OpenRun,
  input: z.output<typeof ChangeJobInputSchema>,
  context: JobContext,
  options: HandlerOptions,
  events: Awaited<ReturnType<typeof readLedger>>,
): Promise<Outcome> {
  const { changeId } = input;
  // The run's captured ufo.yaml and cards must still be the approved ones before anything runs.
  const unapproved = await approvalViolation(open);
  if (unapproved !== undefined)
    return { decision: refusal(changeId, unapproved), attempted: false };
  const resolved = resolveCard(open.catalog, input.cardId, open.config.cards);
  // A is measured exactly at its commit: whatever was written into it since the last job is
  // discarded first (security F11). B is reset when the change is applied.
  const aHead = await resetArms(open.git);
  let diff = input.source === "agent" ? input.diff : undefined;
  if (input.source === "recipe") {
    if ("violation" in resolved) {
      return { decision: refusal(changeId, resolved.violation), attempted: false };
    }
    try {
      const files = await applyRecipeEdits(resolved.card, (file) => readFileAtA(open.git, file));
      diff = await diffFromFiles(open.git, files);
    } catch (error) {
      if (!(error instanceof RecipeEditError)) throw error;
      return {
        decision: unmeasured(changeId, "drop", "patch_failed", error.message),
        attempted: true,
      };
    }
    if (diff === "") {
      return {
        decision: unmeasured(
          changeId,
          "drop",
          "no_effect",
          "the recipe's edits leave arm A unchanged",
        ),
        attempted: false,
      };
    }
  }
  // Recorded before the card, opt-in, budget, and path checks, so changes they refuse are in the
  // evidence bundle too. Only the approval check above comes first.
  const change = ChangeSchema.parse({
    changeId,
    baseSha: input.baseSha ?? aHead,
    cardId: input.cardId,
    diff,
    hypothesis: input.hypothesis,
    evidenceRefs: input.evidenceRefs,
  });
  await appendLedger(open.runDir, {
    type: EVENTS.changeStarted,
    changeId,
    data: jsonData({ change, source: input.source }),
  });
  if ("violation" in resolved) {
    return { decision: refusal(changeId, resolved.violation), attempted: false, change };
  }
  const { card } = resolved;
  const optIn = checkOptIn(card.riskClass, open.optIns);
  if (optIn !== undefined) return { decision: refusal(changeId, optIn), attempted: false, change };
  const { createdAt } = await readRun(open.runDir);
  const budget = budgetStatus(events, open.config.objective.budget, createdAt);
  if (budget.violation !== undefined) {
    return { decision: refusal(changeId, budget.violation), attempted: false, change };
  }
  const baseline = latestBaseline(events);
  if (baseline === undefined) {
    throw new Error("the run has no completed baseline; a change cannot be decided before it");
  }
  // A diff written against an older A: an earlier change was kept since. Not an attempt.
  if (input.baseSha !== undefined && input.baseSha !== aHead) {
    const stale = violation(
      "stale_base",
      `the diff was written against ${input.baseSha.slice(0, 12)}, but arm A is at ${aHead.slice(0, 12)}; rebase it on the current A`,
      [input.baseSha],
    );
    return { decision: refusal(changeId, stale), attempted: false, change };
  }
  const session = newSession(open, context, options.machine);
  // Too noisy at the current A to decide anything: measuring would only spend the budget.
  const noise = await noiseRefusal(open, events, changeId, session);
  if (noise !== undefined) return { decision: noise, attempted: false, change };

  const protectedGlobs = protectedPathsFor(
    card.riskClass,
    open.optIns,
    configProtectedPaths(open.config, enabledCards(open)),
  );
  const before = checkProtectedPaths(change.diff, protectedGlobs);
  if (before !== undefined)
    return { decision: refusal(changeId, before), attempted: false, change };
  context.setProgress({ done: 0, total: 4, message: "applying" });
  const applied = await applyToB(open.git, change);
  if (!applied.ok) {
    return {
      decision: unmeasured(changeId, "drop", "patch_failed", applied.detail),
      attempted: true,
      change,
    };
  }
  const after = checkPaths(applied.changedPaths, protectedGlobs);
  if (after !== undefined) {
    await revertB(open.git);
    return { decision: refusal(changeId, after), attempted: true, change };
  }

  const armA: ArmSpec = { arm: "a", dir: open.git.armA, sha: aHead };
  const armB: ArmSpec = { arm: "b", dir: open.git.armB, sha: aHead };
  let outcome: Outcome;
  try {
    outcome = await measureChange(open, change, card, session, armA, armB, context, baseline.tests);
  } finally {
    await session.teardown("change");
  }
  outcome = {
    ...outcome,
    change,
    samples: session.samples,
    commands: [...session.commands],
  };
  if (outcome.decision.outcome !== "keep") {
    outcome = { ...outcome, cleanup: () => dropChange(open, card, session, armB) };
  }
  return outcome;
}

/**
 * `policy:noise_floor` (inconclusive, not an attempt) when the samples at the current A already
 * put the noise floor above the limit: every change would end the same way after measuring.
 */
async function noiseRefusal(
  open: OpenRun,
  events: Awaited<ReturnType<typeof readLedger>>,
  changeId: string,
  session: WorkloadSession,
): Promise<Decision | undefined> {
  if (open.config.objective.primary.kind !== "stochastic") return undefined;
  const values = currentNoiseValues(events);
  if (values.length < MIN_NOISE_SAMPLES) return undefined;
  let floor: number;
  try {
    floor = noiseFloor(values);
  } catch (error) {
    // A median of 0 (or another value the floor cannot be computed from) refuses the same way the
    // baseline does: nothing can be decided at this A.
    if (!(error instanceof DecideInputError)) throw error;
    return unmeasured(
      changeId,
      "inconclusive",
      "policy:noise_floor",
      `no noise floor: ${error.message}`,
    );
  }
  if (floor <= MAX_NOISE_FLOOR) return undefined;
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
  return unmeasured(
    changeId,
    "inconclusive",
    "policy:noise_floor",
    `noise floor ${pct(floor)} exceeds ${pct(MAX_NOISE_FLOOR)}; likely cause: ${await session.noiseCause()}`,
  );
}

async function dropChange(
  open: OpenRun,
  card: TechniqueCard,
  session: WorkloadSession,
  armB: ArmSpec,
): Promise<void> {
  await revertB(open.git);
  const reset = card.commandTemplates.find((t) => t.id === RESET_TEMPLATE_ID);
  if (reset !== undefined) {
    const command = substitute(reset.run, defaultParams(card));
    const result = await session.runInArm(command, armB, "change", `card ${card.id} reset`);
    if (!succeeded(result)) {
      throw new Error(`the reset hook of ${card.id} failed: ${describeResult(result)}`);
    }
  }
}

async function measureChange(
  open: OpenRun,
  change: Change,
  card: TechniqueCard,
  session: WorkloadSession,
  armA: ArmSpec,
  armB: ArmSpec,
  context: JobContext,
  tests: Parameters<typeof checkCandidate>[3],
): Promise<Outcome> {
  const { changeId } = change;
  const { objective } = open.config;
  context.setProgress({ done: 1, total: 4, message: "building" });
  const setupA = await session.setup(armA, "change");
  if (setupA !== undefined && !succeeded(setupA)) {
    return {
      decision: unmeasured(
        changeId,
        "inconclusive",
        "inconclusive",
        `arm A setup failed, so nothing was compared: ${describeResult(setupA)}`,
      ),
      attempted: true,
    };
  }
  const setupB = await session.setup(armB, "change");
  if (setupB !== undefined && !succeeded(setupB)) {
    return {
      decision: unmeasured(changeId, "drop", "build_failed", describeResult(setupB)),
      attempted: true,
    };
  }

  context.setProgress({ done: 2, total: 4, message: "oracles" });
  const oracles = await checkCandidate(session, open.config.oracles, armB, tests, changeId);
  if (oracles.failure !== undefined) {
    return {
      decision: unmeasured(changeId, "drop", oracles.failure.reason, oracles.failure.detail),
      attempted: true,
      oracleResults: oracles.results,
    };
  }

  context.setProgress({ done: 3, total: 4, message: "measuring" });
  const sampleOf: RunSample = (arm, index) =>
    session.sample(arm === "a" ? armA : armB, index, "change", changeId);
  const changeSamples = () => session.samples.filter((s) => s.changeId === changeId);
  try {
    await session.start(armA, "change");
  } catch (error) {
    if (!(error instanceof WorkloadError)) throw error;
    return {
      decision: unmeasured(changeId, "inconclusive", "inconclusive", error.message),
      attempted: true,
      oracleResults: oracles.results,
    };
  }
  try {
    await session.start(armB, "change");
  } catch (error) {
    if (!(error instanceof WorkloadError)) throw error;
    return {
      decision: unmeasured(changeId, "drop", "build_failed", error.message),
      attempted: true,
      oracleResults: oracles.results,
    };
  }
  try {
    let firstIndex = 0;
    if (objective.primary.kind === "deterministic") {
      const pairs = await runInterleaved(2, sampleOf);
      const [first, repeat] = pairs as [Pair, Pair];
      const result = decideDeterministic({
        changeId,
        direction: objective.primary.direction,
        minEffect: objective.minEffect,
        a: [first.a, repeat.a],
        b: [first.b, repeat.b],
        guardrails: guardrailChecks(changeSamples(), objective, card),
      });
      if (result.kind === "decided") {
        return { decision: result.decision, attempted: true, oracleResults: oracles.results };
      }
      firstIndex = 2;
    }
    const events = await readLedger(open.runDir);
    let pairs = await runInterleaved(INITIAL_PAIRS, sampleOf, { firstIndex });
    // The latest samples at the current A: the kept change's B values or the baseline, else
    // (the latest keep was deterministic) this change's own A samples.
    const recorded = currentNoiseValues(events);
    const noiseSamples = recorded.length >= MIN_NOISE_SAMPLES ? recorded : pairs.map((p) => p.a);
    const stochastic = async (all: Pair[]): Promise<StochasticResult> =>
      decideStochastic({
        changeId,
        direction: objective.primary.direction,
        minEffect: objective.minEffect,
        noiseSamples,
        pairs: all,
        guardrails: guardrailChecks(changeSamples(), objective, card),
        noiseCause: await session.noiseCause(),
      });
    let result = await stochastic(pairs);
    if (result.kind === "needs_escalation") {
      context.setProgress({ done: 3, total: 4, message: "measuring (escalation)" });
      pairs = [
        ...pairs,
        ...(await runInterleaved(result.additionalPairs, sampleOf, {
          firstIndex: firstIndex + pairs.length,
        })),
      ];
      result = await stochastic(pairs);
    }
    if (result.kind !== "decided") throw new Error("a ten-pair decision cannot escalate again");
    return { decision: result.decision, attempted: true, oracleResults: oracles.results };
  } catch (error) {
    if (!(error instanceof MeasurementError) && !(error instanceof DecideInputError)) throw error;
    return {
      decision: unmeasured(
        changeId,
        "inconclusive",
        "inconclusive",
        `measurement failed: ${error.message}`,
      ),
      attempted: true,
      oracleResults: oracles.results,
    };
  }
}
