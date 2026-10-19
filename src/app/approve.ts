import type { AppContext } from "./context.js";
import {
  type ApproveOptions,
  type ApproveResult,
  approveWithGate,
  type ExtendBudgetOptions,
  extendBudgetWithGate,
} from "./human-gate.js";
import { terminalGate } from "./terminal.js";

export type { ApproveOptions, ApproveResult, ExtendBudgetOptions } from "./human-gate.js";

/**
 * `ufo approve` (plan §2.3 step 2): human-only. Requires a TTY on stdin, prints the review, and
 * reads the typed `approve` from the controlling terminal (`/dev/tty`) itself; nothing a caller
 * passes can answer for the human. Records `sha256(ufo.yaml)`, each enabled card's source and
 * content hash, the opt-ins, the `env:` names, and the digest over all of them.
 */
export function approve(context: AppContext, options: ApproveOptions): Promise<ApproveResult> {
  return approveWithGate(context, { ...options, ...terminalGate() });
}

/**
 * `ufo extend-budget`: human-only like `approve`, with the answer read from `/dev/tty`. Shows
 * what was used, asks the human to type `extend`, and records the raised limits in the ledger.
 */
export function extendBudget(
  context: AppContext,
  options: ExtendBudgetOptions,
): Promise<{ runId: string; maxTechniques: number; wallClockMinutes: number }> {
  return extendBudgetWithGate(context, { ...options, ...terminalGate() });
}
