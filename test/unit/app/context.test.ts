import { describe, expect, it } from "vitest";
import { CONTROL_LOCK_WAIT_MS, controlLockWaitMs } from "../../../src/app/index.js";

// Code review (step A) #7: a wait that is not a finite number ≥ 0 would make a control call wait
// forever for a held lock (NaN, Infinity) or fail at once (a negative wait).
describe("the control-lock wait of an app call", () => {
  it("is the context's when it is a finite number of milliseconds ≥ 0, else the CLI's", () => {
    expect(controlLockWaitMs({ cwd: "/" })).toBe(CONTROL_LOCK_WAIT_MS);
    expect(controlLockWaitMs({ cwd: "/", controlLockWaitMs: 20_000 })).toBe(20_000);
    expect(controlLockWaitMs({ cwd: "/", controlLockWaitMs: 0 })).toBe(0);
    for (const wait of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(controlLockWaitMs({ cwd: "/", controlLockWaitMs: wait })).toBe(CONTROL_LOCK_WAIT_MS);
    }
  });
});
