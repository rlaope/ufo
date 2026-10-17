import type { Arm, Decision, MetricDirection } from "../../domain/index.js";
import { buildDecision, failedGate, type GuardrailCheck, type OracleCheck } from "./gates.js";
import { assertMinEffect, assertSampleValues, pairImprovement } from "./stats.js";

export interface DeterministicInput {
  /** The `Ufo-Change-Id` of the change under test. */
  readonly changeId: string;
  readonly direction: MetricDirection;
  /** `Objective.minEffect`, e.g. 0.03. */
  readonly minEffect: number;
  /** A's value from the first run and from the repeat. */
  readonly a: readonly [number, number];
  /** B's value from the first run and from the repeat. */
  readonly b: readonly [number, number];
  readonly oracles?: readonly OracleCheck[];
  readonly guardrails?: readonly GuardrailCheck[];
}

export type DeterministicResult =
  | { readonly kind: "decided"; readonly decision: Decision }
  | {
      /** The metric did not repeat exactly: measure it as stochastic instead. */
      readonly kind: "reclassify_stochastic";
      readonly arms: readonly Arm[];
    };

/**
 * Decides a deterministic metric (measurement policy §4.2) from one run per arm plus one repeat.
 * The decision records both runs as pairs; the effect is `pairImprovement` of the first pair.
 *
 * 1. A failing oracle, then a failing guardrail → drop `oracle:<name>` / `guardrail:<kind>`.
 * 2. An arm whose repeat differs from its first run → `reclassify_stochastic`.
 * 3. Keep iff the effect is ≥ minEffect. Otherwise drop: `regressed` iff the effect is < 0
 *    (without noise, any worsening is measurable), else `no_effect`.
 */
export function decideDeterministic(input: DeterministicInput): DeterministicResult {
  assertMinEffect(input.minEffect);
  assertSampleValues([...input.a, ...input.b], "deterministic values");
  const [a, aRepeat] = input.a;
  const [b, bRepeat] = input.b;
  const pairs = [
    { a, b },
    { a: aRepeat, b: bRepeat },
  ];
  const effect = pairImprovement({ a, b }, input.direction);
  const measured = { changeId: input.changeId, pairs, effect };
  const decided = (decision: Decision): DeterministicResult => ({ kind: "decided", decision });

  const gate = failedGate(input.oracles ?? [], input.guardrails ?? []);
  if (gate !== undefined) {
    return decided(buildDecision(measured, "drop", gate.reason, gate.detail));
  }
  const arms: Arm[] = [];
  if (a !== aRepeat) arms.push("a");
  if (b !== bRepeat) arms.push("b");
  if (arms.length > 0) return { kind: "reclassify_stochastic", arms };

  if (effect >= input.minEffect) return decided(buildDecision(measured, "keep"));
  return decided(buildDecision(measured, "drop", effect < 0 ? "regressed" : "no_effect"));
}
