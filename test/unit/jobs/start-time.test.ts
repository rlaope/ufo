import { describe, expect, it } from "vitest";
import {
  abandonedStart,
  procStatStartTime,
  type RunRecord,
  readProcessStartTime,
  sameStartTime,
} from "../../../src/core/jobs/index.js";

// M5 V4 review: a process's start time names it across a clock step. On Linux it is read in
// ticks since boot from /proc, which no clock step moves; `ps`'s times are compared with a small
// tolerance.

/** A /proc/<pid>/stat line whose name holds spaces and parentheses, started at `ticks`. */
function stat(ticks: number): string {
  const after = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), String(ticks)];
  return `4242 (a) b (c)) ${after.join(" ")} 900 1000 18446744073709551615\n`;
}

describe("a process's start time", () => {
  it("is field 22 of /proc/<pid>/stat on Linux, read after the name", async () => {
    expect(procStatStartTime(stat(987654))).toBe("ticks:987654");
    expect(await readProcessStartTime(4242, "linux", async () => stat(987654))).toBe(
      "ticks:987654",
    );
    // A process that is gone, and a line that is not a stat line.
    const gone = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(await readProcessStartTime(4242, "linux", gone)).toBeUndefined();
    expect(procStatStartTime("4242 no name here")).toBeUndefined();
    expect(procStatStartTime("4242 (short) S 1 2")).toBeUndefined();
  });

  it("is read from /proc, not ps, on Linux, so a clock step leaves a live process's the same", async () => {
    let reads = 0;
    // The kernel's boot time moved between the two reads; the tick count did not.
    const reader = async () => {
      reads++;
      return stat(555);
    };
    const before = await readProcessStartTime(4242, "linux", reader);
    const after = await readProcessStartTime(4242, "linux", reader);
    expect(reads).toBe(2);
    expect(before).toBeDefined();
    expect(sameStartTime(before ?? "", after ?? "")).toBe(true);
  });

  it("names the same process within the tolerance, and another one beyond it", () => {
    expect(sameStartTime("ticks:555", "ticks:555")).toBe(true);
    expect(sameStartTime("ticks:555", "ticks:556")).toBe(false);
    expect(sameStartTime("Wed Oct 22 00:21:24 2026", "Wed Oct 22 00:21:24 2026")).toBe(true);
    expect(sameStartTime("Wed Oct 22 00:21:24 2026", "Wed Oct 22 00:21:26 2026")).toBe(true);
    expect(sameStartTime("Wed Oct 22 00:21:24 2026", "Wed Oct 22 00:21:27 2026")).toBe(false);
    expect(sameStartTime("Wed Oct 22 23:59:59 2026", "Thu Oct 23 00:00:01 2026")).toBe(true);
    expect(sameStartTime("Thu Jan  1 00:00:00 1970", "Thu Jan 1 00:00:00 1970")).toBe(true);
    expect(sameStartTime("Wed Oct 22 00:21:24 2026", "Wed Nov 22 00:21:24 2026")).toBe(false);
    expect(sameStartTime("ticks:555", "Wed Oct 22 00:21:24 2026")).toBe(false);
  });

  it("reads this process's own the same way twice", async () => {
    const first = await readProcessStartTime(process.pid);
    const second = await readProcessStartTime(process.pid);
    expect(first).toBeDefined();
    expect(sameStartTime(first ?? "", second ?? "")).toBe(true);
  });
});

describe("a start cut short", () => {
  const run = (startTime: string): RunRecord =>
    ({
      status: "running",
      started: false,
      starter: { pid: process.pid, startTime },
    }) as unknown as RunRecord;

  it("is not one whose live starter's start time moved with the clock", async () => {
    const moved = async () => "Wed Oct 22 00:21:25 2026";
    expect(await abandonedStart(run("Wed Oct 22 00:21:24 2026"), moved)).toBe(false);
    expect(await abandonedStart(run("ticks:555"), async () => "ticks:555")).toBe(false);
  });

  it("is one whose starter's PID another process reused", async () => {
    expect(
      await abandonedStart(run("Wed Oct 22 00:21:24 2026"), async () => "Wed Oct 22 01:21:24 2026"),
    ).toBe(true);
    expect(await abandonedStart(run("ticks:555"), async () => "ticks:9000")).toBe(true);
    // Unknown (it just exited, or the read failed): not judged.
    expect(await abandonedStart(run("ticks:555"), async () => undefined)).toBe(false);
  });
});
