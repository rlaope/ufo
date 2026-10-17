import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BundleIdSchema,
  type Decision,
  type EvidenceBundle,
  EvidenceBundleSchema,
  RepoPathSchema,
  SCHEMA_VERSION,
  Sha256HexSchema,
} from "../../domain/index.js";
import { BUNDLES_DIR } from "../jobs/paths.js";
import { type RedactOptions, redact } from "./redact.js";

export const BUNDLE_FILE = "bundle.json";
export const MANIFEST_FILE = "manifest.json";
export const DIFFS_DIR = "diffs";

export const BundleManifestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  bundleId: BundleIdSchema,
  /** Every file of the bundle except the manifest itself. */
  files: z
    .array(
      z.strictObject({
        path: RepoPathSchema,
        sha256: Sha256HexSchema,
        bytes: z.number().int().min(0),
      }),
    )
    .max(10_000),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

function diffPath(changeId: string): string {
  return `${DIFFS_DIR}/${changeId}.diff`;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Exports a bundle to `<runDir>/bundles/<bundleId>/`: `bundle.json`, one `diffs/<changeId>.diff`
 * per change, and `manifest.json` with the sha256 of each. Every string is redacted first; a
 * bundle that redaction made invalid is refused rather than exported unredacted. An existing
 * export of the same bundle id is replaced.
 */
export async function writeBundle(
  runDir: string,
  bundle: z.input<typeof EvidenceBundleSchema>,
  options: RedactOptions = {},
): Promise<{ dir: string; manifest: BundleManifest }> {
  const redactedResult = EvidenceBundleSchema.safeParse(
    redact(EvidenceBundleSchema.parse(bundle), options),
  );
  if (!redactedResult.success) {
    const fields = redactedResult.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`redaction left the bundle invalid (${fields}); refusing to export it`);
  }
  const redacted = redactedResult.data;
  const files = new Map<string, string>([[BUNDLE_FILE, `${JSON.stringify(redacted, null, 2)}\n`]]);
  for (const change of redacted.changes) files.set(diffPath(change.changeId), change.diff);

  const dir = path.join(runDir, BUNDLES_DIR, redacted.bundleId);
  const temp = `${dir}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(path.join(temp, DIFFS_DIR), { recursive: true });
  try {
    const entries: BundleManifest["files"] = [];
    for (const [relative, text] of [...files].sort(([x], [y]) => x.localeCompare(y))) {
      await writeFile(path.join(temp, relative), text);
      entries.push({ path: relative, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    }
    const manifest = BundleManifestSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      bundleId: redacted.bundleId,
      files: entries,
    });
    await writeFile(path.join(temp, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(dir, { recursive: true, force: true });
    await rename(temp, dir);
    return { dir, manifest };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

/** The decision fields `verifyBundle` compares. `detail` is prose and is not compared. */
export type DecisionSummary = Pick<Decision, "outcome" | "reason" | "effect" | "pairs">;

export type FileCheck = { path: string; status: "ok" | "missing" | "hash_mismatch" };
export type DecisionCheck = {
  changeId: string;
  status: "match" | "mismatch" | "not_recorded" | "not_recomputed";
  recorded?: DecisionSummary;
  recomputed?: DecisionSummary;
};

export interface BundleVerification {
  ok: boolean;
  /** Set when `manifest.json` is missing or invalid; nothing else is checked then. */
  manifestError?: string;
  files: FileCheck[];
  /** Files in the bundle directory that the manifest does not list. */
  unlistedFiles: string[];
  /** `bundle.json` failed its schema, or a diff file disagrees with it. */
  bundleErrors: string[];
  decisions: DecisionCheck[];
  /** Set when the injected `recompute` threw. */
  recomputeError?: string;
}

/**
 * Checks an exported bundle: every manifest hash, no unlisted files, `bundle.json` against the
 * schema, each diff file against its change, and the recorded decisions against `recompute`,
 * which re-runs the decision function on the bundle's samples.
 */
export async function verifyBundle(
  dir: string,
  recompute: (bundle: EvidenceBundle) => readonly Decision[],
): Promise<BundleVerification> {
  const report: BundleVerification = {
    ok: false,
    files: [],
    unlistedFiles: [],
    bundleErrors: [],
    decisions: [],
  };
  let manifest: BundleManifest;
  try {
    manifest = BundleManifestSchema.parse(
      JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8")),
    );
  } catch (error) {
    report.manifestError = describe(error);
    return report;
  }

  const verified = new Map<string, string>();
  for (const entry of manifest.files) {
    let data: Buffer;
    try {
      data = await readFile(path.join(dir, entry.path));
    } catch {
      report.files.push({ path: entry.path, status: "missing" });
      continue;
    }
    const ok = sha256(data) === entry.sha256;
    report.files.push({ path: entry.path, status: ok ? "ok" : "hash_mismatch" });
    if (ok) verified.set(entry.path, data.toString("utf8"));
  }
  const listed = new Set([MANIFEST_FILE, ...manifest.files.map((entry) => entry.path)]);
  report.unlistedFiles = (await listFiles(dir)).filter((file) => !listed.has(file));

  const bundle = parseBundle(verified.get(BUNDLE_FILE), manifest, report.bundleErrors);
  if (bundle !== undefined) {
    for (const change of bundle.changes) {
      if (verified.get(diffPath(change.changeId)) !== change.diff) {
        report.bundleErrors.push(`${diffPath(change.changeId)} does not match bundle.json`);
      }
    }
    try {
      report.decisions = compareDecisions(bundle.decisions, recompute(bundle));
    } catch (error) {
      report.recomputeError = describe(error);
    }
  }

  report.ok =
    report.files.every((file) => file.status === "ok") &&
    report.unlistedFiles.length === 0 &&
    report.bundleErrors.length === 0 &&
    report.recomputeError === undefined &&
    report.decisions.every((decision) => decision.status === "match");
  return report;
}

function parseBundle(
  text: string | undefined,
  manifest: BundleManifest,
  errors: string[],
): EvidenceBundle | undefined {
  if (text === undefined) {
    errors.push(`${BUNDLE_FILE} is missing from the manifest or failed its hash check`);
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    errors.push(`${BUNDLE_FILE} is not JSON: ${describe(error)}`);
    return undefined;
  }
  const result = EvidenceBundleSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${BUNDLE_FILE} ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return undefined;
  }
  if (result.data.bundleId !== manifest.bundleId) {
    errors.push(`${BUNDLE_FILE} bundle id differs from the manifest`);
  }
  return result.data;
}

function compareDecisions(
  recorded: readonly Decision[],
  recomputed: readonly Decision[],
): DecisionCheck[] {
  const byId = new Map(recomputed.map((decision) => [decision.changeId, decision]));
  const checks: DecisionCheck[] = recorded.map((decision) => {
    const again = byId.get(decision.changeId);
    byId.delete(decision.changeId);
    if (again === undefined) {
      return { changeId: decision.changeId, status: "not_recomputed", recorded: summary(decision) };
    }
    const [a, b] = [summary(decision), summary(again)];
    return {
      changeId: decision.changeId,
      status: JSON.stringify(a) === JSON.stringify(b) ? "match" : "mismatch",
      recorded: a,
      recomputed: b,
    };
  });
  for (const extra of byId.values()) {
    checks.push({ changeId: extra.changeId, status: "not_recorded", recomputed: summary(extra) });
  }
  return checks;
}

/** Fixed key order, so summaries compare by their JSON text. */
function summary(decision: Decision): DecisionSummary {
  return {
    outcome: decision.outcome,
    reason: decision.reason,
    effect: decision.effect,
    pairs: decision.pairs.map(({ a, b }) => ({ a, b })),
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
