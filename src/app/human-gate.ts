// The human-only gates (plan §2.3 step 2, security F16): `ufo approve` and `ufo extend-budget`
// with the terminal they ask on passed in. Production code reaches them only through
// `approve()` and `extendBudget()` in approve.ts, which pass `terminalGate()`. This module is
// not exported from the package entry, and only approve.ts may import it
// (test/unit/app/human-gate.test.ts checks both); tests import it directly to answer for the
// human.

import { appendLedger, readLedger, readRun } from "../core/jobs/index.js";
import {
  type ApprovedCard,
  PolicyError,
  recordApproval,
  requireTty,
  violation,
} from "../core/policy/index.js";
import { MAX_TECHNIQUES, MAX_WALL_CLOCK_MINUTES, type OptIn } from "../domain/index.js";
import { approvalSubject, loadCards } from "./cards.js";
import { loadConfig } from "./config.js";
import { type AppContext, homeFor, resolveRepo } from "./context.js";
import { AppError } from "./errors.js";
import { budgetStatus, EVENTS } from "./events.js";
import { approvalReview, approvedCommands } from "./review.js";
import { activeRun } from "./run.js";
import { npmScriptBodies, scriptTablesFor } from "./script-tables.js";

/** Asks the human one question and returns the line they typed. */
export type Confirm = (prompt: string) => Promise<string>;

export interface HumanGate {
  /** Must be an interactive terminal; nothing is printed, asked, or recorded otherwise. */
  readonly stdin: { readonly isTTY?: boolean | undefined };
  /** Reads the human's answer. Production: `askTerminal`, on `/dev/tty`. */
  readonly confirm: Confirm;
}

export interface ApproveOptions {
  /** Where the review is printed. */
  readonly print: (text: string) => void;
  readonly allowLossy?: boolean;
  readonly allowUpgrade?: boolean;
}

export interface ApproveResult {
  repoId: string;
  configHash: string;
  /** The enabled cards as approved: id, source, content hash. */
  cards: ApprovedCard[];
  /** sha256 over `ufo.yaml`, the enabled cards, the opt-ins, and `env:`: what runs check. */
  digest: string;
  optIns: OptIn[];
  /** `env:` names passed to commands besides the defaults. */
  env: string[];
  approvedAt: string;
  /** Every command line the approval covers. */
  commands: string[];
}

/**
 * `ufo approve` with its gate: requires a TTY on stdin before anything else, prints every
 * command UFO will run, the environment names, the targets, and the opt-ins, checks that each
 * opt-in `ufo.yaml` requests is confirmed by its flag (and no flag widens beyond it), then asks
 * the human to type `approve` and records the approval in this process's own `UFO_HOME`.
 */
export async function approveWithGate(
  context: AppContext,
  options: ApproveOptions & HumanGate,
): Promise<ApproveResult> {
  requireTty(options.stdin);
  const repo = await resolveRepo(context.cwd);
  const home = await homeFor(context, repo);
  const loaded = await loadConfig(repo.root);
  const catalog = await loadCards(repo.root, context, loaded.config);
  const cards = loaded.config.cards.map((id) => {
    const entry = catalog.get(id);
    if (entry === undefined) {
      throw new PolicyError(violation("unknown_card", `ufo.yaml enables unknown card ${id}`, [id]));
    }
    return entry.card;
  });
  const requested = loaded.config.optIns;
  const flags: OptIn[] = [
    ...(options.allowLossy ? (["lossy"] as const) : []),
    ...(options.allowUpgrade ? (["upgrade"] as const) : []),
  ];
  for (const optIn of requested) {
    if (!flags.includes(optIn)) {
      throw new AppError(
        "opt_in_mismatch",
        `ufo.yaml requests the ${optIn} opt-in; confirm it with --allow-${optIn}`,
      );
    }
  }
  for (const flag of flags) {
    if (!requested.includes(flag)) {
      throw new AppError(
        "opt_in_mismatch",
        `--allow-${flag} was given, but ufo.yaml does not request the ${flag} opt-in`,
      );
    }
  }
  const commands = approvedCommands(loaded.config, cards).map((c) => c.command);
  const scripts = {
    files: scriptTablesFor(commands),
    npmScripts: await npmScriptBodies(repo.root, commands),
  };
  options.print(
    approvalReview(repo.root, loaded.hash, loaded.config, cards, catalog, requested, scripts),
  );
  const answer = await options.confirm('Type "approve" to approve: ');
  if (answer.trim() !== "approve") {
    throw new AppError("approval_declined", "not approved; nothing was recorded");
  }
  const subject = approvalSubject(loaded.hash, loaded.config, catalog);
  const approval = await recordApproval(repo.repoId, subject, { home });
  return {
    repoId: repo.repoId,
    configHash: approval.configHash,
    cards: approval.cards,
    digest: approval.digest,
    optIns: approval.optIns,
    env: approval.env,
    approvedAt: approval.approvedAt,
    commands: approvedCommands(loaded.config, cards).map((c) => c.command),
  };
}

export interface ExtendBudgetOptions {
  readonly runId?: string;
  /** Where the budget summary is printed. */
  readonly print: (text: string) => void;
  /** Techniques to add; defaults to the configured cap. */
  readonly techniques?: number;
  /** Minutes to add; defaults to none. */
  readonly minutes?: number;
}

/**
 * `ufo extend-budget` with its gate: human-only like `approve`. Shows what was used, asks the
 * human to type `extend`, and records the raised limits in the ledger.
 */
export async function extendBudgetWithGate(
  context: AppContext,
  options: ExtendBudgetOptions & HumanGate,
): Promise<{ runId: string; maxTechniques: number; wallClockMinutes: number }> {
  if (options.stdin.isTTY !== true) {
    throw new PolicyError(
      violation("non_tty_approval", "ufo extend-budget needs an interactive terminal on stdin"),
    );
  }
  const active = await activeRun(context, options.runId);
  const { open } = active;
  const run = await readRun(active.runDir);
  const status = budgetStatus(
    await readLedger(active.runDir),
    open.config.objective.budget,
    run.createdAt,
  );
  const addTechniques = options.techniques ?? open.config.objective.budget.maxTechniques;
  const addMinutes = options.minutes ?? 0;
  for (const [name, value] of [
    ["techniques", addTechniques],
    ["minutes", addMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AppError("usage", `--${name} must be a non-negative integer`);
    }
  }
  const maxTechniques = Math.min(MAX_TECHNIQUES, status.limits.maxTechniques + addTechniques);
  const wallClockMinutes = Math.min(
    MAX_WALL_CLOCK_MINUTES,
    status.limits.wallClockMinutes + addMinutes,
  );
  options.print(
    [
      `Run ${active.runId} budget:`,
      `  techniques: ${status.counter.techniques} tried of ${status.limits.maxTechniques} -> new cap ${maxTechniques}`,
      `  wall clock: ${Math.floor(status.counter.wallClockMs / 60_000)} min used of ${status.limits.wallClockMinutes} -> new cap ${wallClockMinutes}`,
      "",
    ].join("\n"),
  );
  const answer = await options.confirm('Type "extend" to raise the budget: ');
  if (answer.trim() !== "extend") {
    throw new AppError("approval_declined", "the budget was not changed");
  }
  await appendLedger(active.runDir, {
    type: EVENTS.budgetExtended,
    data: { maxTechniques, wallClockMinutes },
  });
  return { runId: active.runId, maxTechniques, wallClockMinutes };
}
