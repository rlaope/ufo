import path from "node:path";
import { z } from "zod";
import { isErrno, OPEN_READ_APPEND, openNoFollow, readTextNoFollow } from "./atomic-file.js";
import { LEDGER_FILE } from "./paths.js";
import { withRunLock } from "./run-record.js";

/** The event the worker appends after it committed a kept change on the run branch. */
export const COMMITTED_EVENT = "change_committed";

export const LedgerEventSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  /** snake_case event name, e.g. `change_submitted`, `observation`, `change_committed`. */
  type: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "must be a snake_case event name"),
  /** The `Ufo-Change-Id` the event is about. */
  changeId: z.uuid().optional(),
  data: z.json().optional(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export type LedgerEventInput = Omit<z.input<typeof LedgerEventSchema>, "at"> & { at?: string };

/**
 * Appends one event to `ledger.jsonl` under the run lock and fsyncs before returning, so an
 * acknowledged event survives a crash. A partial last line left by a crash mid-append was never
 * acknowledged; it is dropped before the new line is written so it cannot merge into it.
 * Must not be called while holding the run lock.
 */
export async function appendLedger(runDir: string, input: LedgerEventInput): Promise<LedgerEvent> {
  const event = LedgerEventSchema.parse({ at: new Date().toISOString(), ...input });
  const file = path.join(runDir, LEDGER_FILE);
  await withRunLock(runDir, async () => {
    const handle = await openNoFollow(file, OPEN_READ_APPEND);
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) {
          const content = Buffer.alloc(size);
          await handle.read(content, 0, size, 0);
          await handle.truncate(content.lastIndexOf(0x0a) + 1);
        }
      }
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  return event;
}

/** Every complete event in append order. A partial last line (crash mid-append) is ignored. */
export async function readLedger(runDir: string): Promise<LedgerEvent[]> {
  let text: string;
  try {
    text = await readTextNoFollow(path.join(runDir, LEDGER_FILE));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const lines = text.split("\n");
  // The element after the last newline is empty, or the unacknowledged partial line.
  lines.pop();
  return lines.map((line, index) => {
    try {
      return LedgerEventSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`${LEDGER_FILE} line ${index + 1} is corrupt`, { cause: error });
    }
  });
}

/** The most recent event about `changeId`, or `undefined`. */
export function findLastChangeEvent(
  events: readonly LedgerEvent[],
  changeId: string,
): LedgerEvent | undefined {
  return events.findLast((event) => event.changeId === changeId);
}

export interface LedgerReconciliation {
  /** On the run branch without a `change_committed` event: the crash case, recoverable. */
  committedUnrecorded: string[];
  /** A `change_committed` event without a commit: the run branch changed outside UFO. */
  recordedUncommitted: string[];
  /** Change ids that appear on more than one commit of the run branch. */
  duplicateCommits: string[];
}

/**
 * Compares the ledger with the `Ufo-Change-Id`s on the run branch, in branch order.
 *
 * Recovery rule. The worker commits a kept change first and appends `change_committed` second.
 * A crash between the two leaves a commit without its event, so on resume:
 * - `committedUnrecorded`: the commit is the source of truth. Append the missing event; never
 *   re-apply or re-measure the change, which would duplicate its `Ufo-Change-Id`.
 * - `recordedUncommitted`: cannot be produced by a crash under this order. Stop and report it
 *   instead of committing again.
 * - `duplicateCommits`: same; the branch already violates the one-commit-per-change invariant.
 */
export function reconcileLedger(
  events: readonly LedgerEvent[],
  committedChangeIds: readonly string[],
): LedgerReconciliation {
  const recorded = new Set<string>();
  for (const event of events) {
    if (event.type === COMMITTED_EVENT && event.changeId !== undefined) {
      recorded.add(event.changeId);
    }
  }
  const committed = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of committedChangeIds) {
    if (committed.has(id)) duplicates.add(id);
    committed.add(id);
  }
  return {
    committedUnrecorded: [...committed].filter((id) => !recorded.has(id)),
    recordedUncommitted: [...recorded].filter((id) => !committed.has(id)),
    duplicateCommits: [...duplicates],
  };
}
