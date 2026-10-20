import { describe, expect, it } from "vitest";
import { describeFailure, EXIT_REFUSED } from "../../../src/app/index.js";
import { LockTimeoutError } from "../../../src/core/jobs/index.js";

// M2 A1: how adapters report failures. A lock another call held past the wait is `busy`.

describe("describeFailure", () => {
  it("reports a lock timeout as busy (exit 1)", () => {
    expect(describeFailure(new LockTimeoutError("/state/run-1/control.lock"))).toMatchObject({
      exitCode: EXIT_REFUSED,
      code: "busy",
      message: "timed out waiting for /state/run-1/control.lock",
    });
  });
});
