import { describe, expect, it } from "vitest";
import { CONTROL_LOCK_WAIT_MS, commonDirIdOf, controlLockWaitMs } from "../../../src/app/index.js";

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

// Code review W1 and its last check: the pin of a repository names its common directory by device
// and inode, with the birth time only on macOS. Elsewhere Node may report the change time (which
// any write to .git moves) or 0 as the birth time, and one stat cannot tell which.
describe("the identity of a common directory", () => {
  const ids = { dev: 1, ino: 2 };
  it("has the birth time on macOS", () => {
    expect(commonDirIdOf({ ...ids, birthtimeMs: 100 }, "darwin")).toBe("1:2:100");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 0 }, "darwin")).toBe("1:2");
  });

  it("is device and inode alone elsewhere, before and after a write to .git", () => {
    // Pinned while the reported birth time still equalled the change time, then .git was written:
    // a real birth time stays, a reported change time moves; both name the directory the same way.
    expect(commonDirIdOf({ ...ids, birthtimeMs: 250 }, "linux")).toBe("1:2");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 300 }, "linux")).toBe("1:2");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 0 }, "linux")).toBe("1:2");
  });
});
