import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLedger,
  COMMITTED_EVENT,
  createRunState,
  LEDGER_FILE,
  readLedger,
  reconcileLedger,
} from "../../../src/core/jobs/index.js";

const ID_1 = "3f2b8c1e-5d4a-4b6f-9e7d-1a2b3c4d5e6f";
const ID_2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID_3 = "9b2d1f0a-3c4e-4f5a-8b6c-7d8e9f0a1b2c";

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-ledger-"));
  ({ runDir } = await createRunState(root, { runId: "run-ledger", repoId: "repo" }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ledger", () => {
  it("reads back appended events in order", async () => {
    await appendLedger(runDir, { type: "change_submitted", changeId: ID_1 });
    await appendLedger(runDir, { type: "observation", changeId: ID_1, data: { value: 12.5 } });
    await appendLedger(runDir, { type: COMMITTED_EVENT, changeId: ID_1 });
    const events = await readLedger(runDir);
    expect(events.map((e) => e.type)).toEqual(["change_submitted", "observation", COMMITTED_EVENT]);
    expect(events[1]?.data).toEqual({ value: 12.5 });
  });

  it("returns no events before the first append", async () => {
    expect(await readLedger(runDir)).toEqual([]);
  });

  it("rejects malformed events", async () => {
    await expect(appendLedger(runDir, { type: "Not Snake" })).rejects.toThrow();
    await expect(appendLedger(runDir, { type: "ok", changeId: "not-a-uuid" })).rejects.toThrow();
  });

  it("ignores a partial last line and drops it on the next append", async () => {
    await appendLedger(runDir, { type: "change_submitted", changeId: ID_1 });
    // A crash in the middle of an append leaves an unterminated fragment.
    await appendFile(path.join(runDir, LEDGER_FILE), '{"at":"2026-10-17T10:00:00.000Z","ty');
    expect((await readLedger(runDir)).map((e) => e.type)).toEqual(["change_submitted"]);

    await appendLedger(runDir, { type: COMMITTED_EVENT, changeId: ID_1 });
    const text = await readFile(path.join(runDir, LEDGER_FILE), "utf8");
    expect(text.split("\n")).toHaveLength(3);
    expect((await readLedger(runDir)).map((e) => e.type)).toEqual([
      "change_submitted",
      COMMITTED_EVENT,
    ]);
  });

  it("refuses a corrupt complete line", async () => {
    await appendFile(path.join(runDir, LEDGER_FILE), "not json\n");
    await expect(readLedger(runDir)).rejects.toThrow(/line 1 is corrupt/);
  });
});

describe("reconcileLedger", () => {
  it("is clean when every commit has its event", async () => {
    await appendLedger(runDir, { type: COMMITTED_EVENT, changeId: ID_1 });
    await appendLedger(runDir, { type: COMMITTED_EVENT, changeId: ID_2 });
    expect(reconcileLedger(await readLedger(runDir), [ID_1, ID_2])).toEqual({
      committedUnrecorded: [],
      recordedUncommitted: [],
      duplicateCommits: [],
    });
  });

  it("reports a commit whose ledger append was lost to a crash", async () => {
    await appendLedger(runDir, { type: COMMITTED_EVENT, changeId: ID_1 });
    // The worker committed ID_2 on the run branch, then died before appending its event.
    await appendLedger(runDir, { type: "change_decided", changeId: ID_2, data: "keep" });
    const result = reconcileLedger(await readLedger(runDir), [ID_1, ID_2]);
    expect(result.committedUnrecorded).toEqual([ID_2]);
    expect(result.recordedUncommitted).toEqual([]);

    // Recovery appends the missing event instead of committing again.
    await appendLedger(runDir, { type: COMMITTED_EVENT, changeId: ID_2 });
    expect(reconcileLedger(await readLedger(runDir), [ID_1, ID_2]).committedUnrecorded).toEqual([]);
  });

  it("reports an event whose commit is not on the branch", () => {
    const events = [{ at: "2026-10-17T10:00:00Z", type: COMMITTED_EVENT, changeId: ID_3 }];
    expect(reconcileLedger(events, [ID_1])).toEqual({
      committedUnrecorded: [ID_1],
      recordedUncommitted: [ID_3],
      duplicateCommits: [],
    });
  });

  it("only counts change_committed events as recorded", () => {
    const events = [{ at: "2026-10-17T10:00:00Z", type: "change_decided", changeId: ID_1 }];
    expect(reconcileLedger(events, [ID_1]).committedUnrecorded).toEqual([ID_1]);
  });

  it("reports a change id committed twice", () => {
    const events = [{ at: "2026-10-17T10:00:00Z", type: COMMITTED_EVENT, changeId: ID_1 }];
    expect(reconcileLedger(events, [ID_1, ID_2, ID_1]).duplicateCommits).toEqual([ID_1]);
  });
});
