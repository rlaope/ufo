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

// Code review W1: the pin of a repository names its common directory by device and inode, with the
// birth time only where the file system keeps one; Node reports the change time there instead,
// which any write to .git moves, or 0.
describe("the identity of a common directory", () => {
  const ids = { dev: 1, ino: 2 };
  it("has the birth time where it is real", () => {
    expect(commonDirIdOf({ ...ids, birthtimeMs: 100, ctimeMs: 250 }, "linux")).toBe("1:2:100");
    // macOS keeps a birth time even when nothing changed the directory since.
    expect(commonDirIdOf({ ...ids, birthtimeMs: 100, ctimeMs: 100 }, "darwin")).toBe("1:2:100");
  });

  it("is device and inode alone where it is the change time or 0", () => {
    expect(commonDirIdOf({ ...ids, birthtimeMs: 250, ctimeMs: 250 }, "linux")).toBe("1:2");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 0, ctimeMs: 250 }, "linux")).toBe("1:2");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 0, ctimeMs: 250 }, "darwin")).toBe("1:2");
    // So a write to .git, which moves the change time, does not change it.
    expect(commonDirIdOf({ ...ids, birthtimeMs: 300, ctimeMs: 300 }, "linux")).toBe(
      commonDirIdOf({ ...ids, birthtimeMs: 250, ctimeMs: 250 }, "linux"),
    );
  });
});
