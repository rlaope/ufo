import { describe, expect, it } from "vitest";
import { checkTestSet } from "../../../src/core/policy/index.js";

const BASELINE = { passed: ["api.get", "api.post", "db.read"], executed: 4 };

describe("checkTestSet (AC 4)", () => {
  it("accepts the same or a larger pass set with at least as many tests run", () => {
    expect(checkTestSet(BASELINE, BASELINE)).toBeUndefined();
    expect(
      checkTestSet(BASELINE, { passed: [...BASELINE.passed, "api.put"], executed: 5 }),
    ).toBeUndefined();
  });

  it("rejects a missing test", () => {
    const violation = checkTestSet(BASELINE, { passed: ["api.get", "api.post"], executed: 4 });
    expect(violation).toMatchObject({ rule: "test_set_shrunk", subjects: ["db.read"] });
  });

  it("rejects a newly failing test even when as many tests ran", () => {
    const violation = checkTestSet(BASELINE, { passed: ["api.get", "db.read"], executed: 4 });
    expect(violation?.subjects).toEqual(["api.post"]);
  });

  it("rejects fewer executed tests even when every baseline pass still passes", () => {
    const violation = checkTestSet(BASELINE, { passed: BASELINE.passed, executed: 3 });
    expect(violation).toMatchObject({ rule: "test_set_shrunk", subjects: [] });
    expect(violation?.detail).toContain("3 tests ran, 4 at baseline");
  });

  it("does not hold known-flaky tests against the candidate", () => {
    expect(
      checkTestSet(BASELINE, { passed: ["api.get", "api.post"], executed: 4 }, ["db.read"]),
    ).toBeUndefined();
  });

  it("refuses counts that are not non-negative integers", () => {
    expect(() => checkTestSet(BASELINE, { passed: BASELINE.passed, executed: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => checkTestSet({ passed: [], executed: -1 }, BASELINE)).toThrow(RangeError);
  });
});
