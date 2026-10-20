import { describe, expect, it } from "vitest";
import {
  AppError,
  describeFailure,
  EXIT_REFUSED,
  EXIT_USAGE,
  hintFor,
} from "../../../src/app/index.js";
import { LockTimeoutError } from "../../../src/core/jobs/index.js";
import { PolicyError, violation } from "../../../src/core/policy/index.js";

// M2 A1, A4: how adapters report failures. A lock another call held past the wait is `busy`;
// every failure says whether trying again later can succeed, and what to do next when its
// message does not.

describe("describeFailure", () => {
  it("reports a lock timeout as busy (exit 1), to try again", () => {
    expect(describeFailure(new LockTimeoutError("/state/run-1/control.lock"))).toEqual({
      exitCode: EXIT_REFUSED,
      code: "busy",
      message: "timed out waiting for /state/run-1/control.lock",
      retryable: true,
      hint: "another UFO call is working on this run; try again in a few seconds",
    });
  });

  it("marks a run still starting retryable and a finishing one not", () => {
    expect(describeFailure(new AppError("run_starting", "run r is still starting"))).toEqual({
      exitCode: EXIT_REFUSED,
      code: "run_starting",
      message: "run r is still starting",
      retryable: true,
      hint: "try again in a few seconds, once the start has finished",
    });
    expect(describeFailure(new AppError("run_finishing", "run r is finishing"))).toMatchObject({
      code: "run_finishing",
      retryable: false,
      hint: "wait for the finish job, then read the run's report",
    });
  });

  it("gives the budget refusal its hint, kept out of the recorded detail", () => {
    const refused = new PolicyError(violation("budget_exceeded", "10 of 10 techniques tried"));
    expect(describeFailure(refused)).toEqual({
      exitCode: EXIT_REFUSED,
      code: "policy:budget_exceeded",
      message: "10 of 10 techniques tried",
      retryable: false,
      hint: "run ufo extend-budget in a terminal to continue",
    });
  });

  it("adds no hint where the message says what to do", () => {
    expect(describeFailure(new AppError("no_run", "no run r in this repository"))).toEqual({
      exitCode: EXIT_USAGE,
      code: "no_run",
      message: "no run r in this repository",
      retryable: false,
    });
    expect(describeFailure(new Error("disk full"))).toMatchObject({
      code: "internal",
      retryable: false,
    });
    expect(hintFor("toString")).toBeUndefined();
  });
});
