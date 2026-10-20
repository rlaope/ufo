import path from "node:path";
import { z } from "zod";
import { REPO_ID_PATTERN, type Run, runLayout } from "../core/git/index.js";
import { RunIdSchema, readJsonIfExists, writeJsonAtomic } from "../core/jobs/index.js";
import { assertTrustedDir, parseRunDir, TrustError } from "../core/paths.js";
import {
  ApprovedCardSchema,
  checkApproval,
  hashConfig,
  type PolicyViolation,
  personMustRun,
  readApproval,
  violation,
} from "../core/policy/index.js";
import {
  BundleIdSchema,
  GitShaSchema,
  IdSchema,
  labelSchema,
  type OptIn,
  Sha256HexSchema,
  TechniqueCardSchema,
  type UfoConfig,
} from "../domain/index.js";
import type { TechniqueCatalog } from "../techniques/index.js";
import { approvalSubject, type CardSet } from "./cards.js";
import { parseConfigText } from "./config.js";
import { resolveRepo } from "./context.js";
import { AppError } from "./errors.js";

/**
 * App-level state of one run, next to `run.json`; written by `startRun`, and again by
 * `finishRun` only to add the self-reported model id.
 */
export const APP_STATE_FILE = "app.json";
/** The finished run's report: headline, final check, bundle location. */
export const REPORT_FILE = "report.json";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), "must be an absolute path");

const OneLineSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\p{Cc}]*$/u, "must be one line");

/** Captured environment: names to values, bounded. */
const EnvValuesSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(128),
    z.string().max(64 * 1024),
  )
  .refine((env) => Object.keys(env).length <= 256, "too many variables");

/**
 * Written once by `startRun`. It holds what the run captured, never where UFO's trusted files
 * are: the approval location is the reading process's own `UFO_HOME`, and the arms and branch
 * are derived from the run id (`runLayout`).
 */
export const AppStateSchema = z.strictObject({
  version: z.literal(2),
  /** `measure` runs stop after the baseline and leave no branch behind. */
  purpose: z.enum(["run", "measure"]),
  runId: RunIdSchema,
  repoId: z.string().regex(REPO_ID_PATTERN),
  /** The user's working tree; re-resolved and checked against `repoId` whenever it is used. */
  repoRoot: AbsolutePathSchema,
  /** The user's HEAD when the run started. */
  baseSha: GitShaSchema,
  /** Author and committer of kept changes, from the user's git config at start. */
  identity: z.strictObject({ name: OneLineSchema, email: OneLineSchema }).optional(),
  /** The approved `ufo.yaml`, byte for byte; the worker never re-reads the user's file. */
  configText: z.string().max(256 * 1024),
  configHash: Sha256HexSchema,
  /** The card catalog as loaded at start; jobs use these cards, never the card files. */
  cards: z
    .array(z.strictObject({ source: ApprovedCardSchema.shape.source, card: TechniqueCardSchema }))
    .max(1024),
  /** Every command's environment besides `UFO_*`, captured at start (allowlist, plan §2.3). */
  env: EnvValuesSchema,
  /** The launcher's git configuration variables, for the worker's own git calls only. */
  gitEnv: EnvValuesSchema,
  /**
   * `targets:` entries as resolved and checked at start, `host=address`; passed to every command
   * as `UFO_TARGET_ADDR`. UFO does not control where the workload connects.
   */
  targetAddrs: z.array(z.string().max(300)).max(64).default([]),
  /** `none` for a recipe-only `ufo run`. */
  hostAgent: IdSchema,
  /** Self-reported by the agent; UFO cannot verify it. */
  modelId: labelSchema().optional(),
  bundleId: BundleIdSchema,
});
export type AppState = z.infer<typeof AppStateSchema>;

export async function writeAppState(runDir: string, state: AppState): Promise<void> {
  await writeJsonAtomic(path.join(runDir, APP_STATE_FILE), AppStateSchema.parse(state));
}

export async function readAppState(runDir: string): Promise<AppState> {
  const value = await readJsonIfExists(path.join(runDir, APP_STATE_FILE));
  // Written once the start got that far: a run without it never finished starting.
  if (value === undefined) {
    throw new AppError(
      "run_not_active",
      `run ${path.basename(runDir)} never finished starting (it has no ${APP_STATE_FILE})`,
    );
  }
  const parsed = AppStateSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TrustError(
      "unsafe_state",
      `${APP_STATE_FILE} in ${runDir} is not valid run state (${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"})`,
    );
  }
  return parsed.data;
}

/** Everything a job needs about its run, re-validated from disk and from trusted inputs. */
export interface OpenRun {
  readonly runDir: string;
  /** The opening process's own trusted home. */
  readonly home: string;
  readonly state: AppState;
  readonly config: UfoConfig;
  /** The cards captured at start, with their sources. */
  readonly cards: CardSet;
  readonly catalog: Pick<TechniqueCatalog, "cards">;
  readonly git: Run;
  /**
   * Opt-ins in force: those of the run's hash-checked `ufo.yaml` that the current approval
   * record also grants. Never read from run state.
   */
  readonly optIns: readonly OptIn[];
}

/**
 * Opens the run at `runDir`, which must be `runDirFor(home, repoId, runId)` under the trusted
 * `home` (the caller's own). The repository id and run id come from that path; `app.json` must
 * agree with them, its `ufo.yaml` must match its hash, and its repository must still have that
 * id. Arm paths and the branch are derived, never read.
 */
export async function openRun(home: string, runDir: string): Promise<OpenRun> {
  const ids = parseRunDir(home, runDir);
  if (ids === undefined) {
    throw new TrustError("unsafe_state", `${runDir} is not a run directory under ${home}`);
  }
  await assertTrustedDir(home, runDir);
  const state = await readAppState(runDir);
  if (state.runId !== ids.runId || state.repoId !== ids.repoId) {
    throw new TrustError("unsafe_state", `${APP_STATE_FILE} in ${runDir} names another run`);
  }
  if (hashConfig(state.configText) !== state.configHash) {
    throw new TrustError(
      "unsafe_state",
      `${APP_STATE_FILE} in ${runDir}: the stored ufo.yaml does not match its approved hash`,
    );
  }
  const repo = await resolveRepo(state.repoRoot);
  if (repo.repoId !== ids.repoId) {
    throw new TrustError(
      "unsafe_state",
      `the repository at ${state.repoRoot} is not the one run ${ids.runId} belongs to`,
    );
  }
  const config = parseConfigText(state.configText);
  const cards = new Map(state.cards.map((entry) => [entry.card.id, entry]));
  const approved = (await readApproval(ids.repoId, { home }))?.optIns ?? [];
  return {
    runDir,
    home,
    state,
    config,
    cards,
    catalog: { cards: new Map([...cards].map(([id, entry]) => [id, entry.card])) },
    git: {
      runId: ids.runId,
      repoId: ids.repoId,
      repoRoot: repo.root,
      baseSha: state.baseSha,
      ...runLayout(home, ids.repoId, ids.runId),
      ...(state.identity === undefined ? {} : { identity: state.identity }),
    },
    optIns: config.optIns.filter((optIn) => approved.includes(optIn)),
  };
}

/**
 * Why a job may not run what its run captured: the `ufo.yaml` bytes, enabled cards, opt-ins, or
 * environment names stored at start no longer match the approval in the opening process's own
 * home (edited state, or a newer approval).
 */
export async function approvalViolation(open: OpenRun): Promise<PolicyViolation | undefined> {
  const subject = approvalSubject(open.state.configHash, open.config, open.cards);
  const refused = await checkApproval(open.git.repoId, subject, { home: open.home });
  if (refused === undefined) return undefined;
  const what =
    refused.subjects.length > 0 ? `technique card ${refused.subjects.join(", ")}` : "ufo.yaml";
  return violation(
    "config_changed",
    `this run's ${what} is no longer what is approved; ${personMustRun("ufo approve")}, then start a new run`,
    refused.subjects,
  );
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Drops `undefined` fields, which JSON (job results, ledger data) cannot hold. */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `value` as ledger event data. */
export function jsonData(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
