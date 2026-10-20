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
// and inode, with the birth time where it looks real; once pinned, the directory is named in the
// pin's form, so a write to .git (which moves the change time) never changes its id.
describe("the identity of a common directory", () => {
  const ids = { dev: 1, ino: 2 };
  it("has the birth time where it looks real", () => {
    expect(commonDirIdOf({ ...ids, birthtimeMs: 100, ctimeMs: 100 }, "darwin")).toBe("1:2:100");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 100, ctimeMs: 250 }, "linux")).toBe("1:2:100");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 250, ctimeMs: 250 }, "linux")).toBe("1:2");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 0, ctimeMs: 250 }, "linux")).toBe("1:2");
  });

  it("keeps the pin's form after a write to .git, and tells a directory made again apart", () => {
    // Pinned while the reported birth time equalled the change time; a write then moves both.
    expect(commonDirIdOf({ ...ids, birthtimeMs: 300, ctimeMs: 300 }, "linux", "1:2")).toBe("1:2");
    expect(commonDirIdOf({ ...ids, birthtimeMs: 300, ctimeMs: 400 }, "linux", "1:2")).toBe("1:2");
    // Pinned with a real birth time: a write moves only the change time.
    expect(commonDirIdOf({ ...ids, birthtimeMs: 100, ctimeMs: 400 }, "linux", "1:2:100")).toBe(
      "1:2:100",
    );
    // Made again with the same inode: a new birth time.
    expect(commonDirIdOf({ ...ids, birthtimeMs: 500, ctimeMs: 600 }, "linux", "1:2:100")).toBe(
      "1:2:500",
    );
  });
});
