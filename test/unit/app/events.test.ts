import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  budgetStatus,
  EVENTS,
  jsonData,
  unmeasured,
  wallClockViolation,
} from "../../../src/app/index.js";
import type { LedgerEvent } from "../../../src/core/jobs/index.js";

// Security N2: a profile is no technique, but it runs only within the run's wall-clock budget.

const BUDGET = { wallClockMinutes: 30, maxTechniques: 1 };
const startedAt = "2026-10-20T00:00:00.000Z";

/** A decision that counts as one technique tried. */
function tried(): LedgerEvent {
  const changeId = randomUUID();
  return {
    at: startedAt,
    type: EVENTS.decision,
    changeId,
    data: jsonData({
      decision: unmeasured(changeId, "drop", "patch_failed"),
      cardId: "toy.fast-path",
      attempted: true,
      cleanupDue: false,
      samples: [],
      oracleResults: [],
      commands: [],
    }),
  };
}

describe("wallClockViolation", () => {
  it("ignores the technique count", () => {
    const status = budgetStatus([tried()], BUDGET, startedAt, {
      now: new Date("2026-10-20T00:10:00.000Z"),
    });
    expect(status.violation?.rule).toBe("budget_exceeded");
    expect(wallClockViolation(status)).toBeUndefined();
  });

  it("is budget_exceeded once the wall clock is spent", () => {
    const status = budgetStatus([], BUDGET, startedAt, {
      now: new Date("2026-10-20T00:31:00.000Z"),
    });
    expect(wallClockViolation(status)).toMatchObject({
      rule: "budget_exceeded",
      detail: "31 of 30 minutes used",
    });
  });
});
