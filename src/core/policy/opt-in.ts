import type { OptIn, RiskClass } from "../../domain/index.js";
import { type PolicyViolation, violation } from "./rules.js";

/** `lossless` and `numeric` cards need no opt-in; `lossy` and `upgrade` need the matching one. */
export function checkOptIn(
  riskClass: RiskClass,
  approvedOptIns: readonly OptIn[],
): PolicyViolation | undefined {
  if (riskClass === "lossless" || riskClass === "numeric") return undefined;
  if (approvedOptIns.includes(riskClass)) return undefined;
  return violation(
    "opt_in_required",
    `${riskClass} cards need the ${riskClass} opt-in (ufo approve --allow-${riskClass})`,
  );
}
