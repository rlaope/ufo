import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BUNDLE_FILE,
  MANIFEST_FILE,
  verifyBundle,
  writeBundle,
} from "../../../src/core/evidence/index.js";
import type { Decision, EvidenceBundle, EvidenceBundleSchema } from "../../../src/domain/index.js";
import { CHANGE_ID, evidenceBundle } from "../domain/fixtures.js";

// Assembled at runtime so no secret-shaped literal sits in the repository.
const API_KEY = `sk-ant-${"FAKE".repeat(8)}`;
const DB_PASSWORD = `planted-${"pw".repeat(6)}`;
const BASIC_CREDENTIALS = Buffer.from(`ufo:${"basic".repeat(3)}`).toString("base64");
const HOME = os.homedir();
const USERNAME = os.userInfo().username;

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(path.join(os.tmpdir(), "ufo-bundle-"));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function plantedBundle(): z.input<typeof EvidenceBundleSchema> {
  const bundle = evidenceBundle();
  const [change] = bundle.changes;
  const [oracle] = bundle.oracleResults;
  if (change === undefined || oracle === undefined) throw new Error("fixture changed");
  return {
    ...bundle,
    commands: [
      `cd ${HOME}/projects/app && OPENAI_API_KEY=${API_KEY} npm run bench`,
      `psql postgres://bench:${DB_PASSWORD}@127.0.0.1:5432/app -c 'select 1'`,
      `curl -fsS -H "Authorization: Basic ${BASIC_CREDENTIALS}" http://127.0.0.1:8080/health`,
    ],
    changes: [
      {
        ...change,
        hypothesis: `Profile at ${HOME}/.cache/flame.html shows the sleep. Key ${API_KEY}.`,
        diff: change.diff.replace("respond();", `respond(); // ${HOME}/notes`),
      },
    ],
    oracleResults: [{ ...oracle, summary: `412 of 412 pass, measured by ${USERNAME} on AC` }],
    limitations: [`workspace ${HOME}/projects/app`],
  };
}

async function exportedFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files.set(path.relative(dir, file), await readFile(file, "utf8"));
    }
  }
  return files;
}

describe("writeBundle", () => {
  it("writes 0600 files and refuses a planted bundles symlink instead of following it (F7)", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    expect((await stat(path.join(dir, BUNDLE_FILE))).mode & 0o777).toBe(0o600);
    await rm(path.join(runDir, "bundles"), { recursive: true });
    const outside = await mkdtemp(path.join(os.tmpdir(), "ufo-bundle-outside-"));
    try {
      await mkdir(path.join(outside, "kept"));
      await symlink(outside, path.join(runDir, "bundles"));
      await expect(writeBundle(runDir, plantedBundle())).rejects.toMatchObject({
        code: "unsafe_state",
      });
      expect(await readdir(outside)).toEqual(["kept"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("exports no planted secret, auth header, connection password, or home path (AC 10)", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    const files = await exportedFiles(dir);
    expect([...files.keys()].sort()).toEqual(
      [BUNDLE_FILE, MANIFEST_FILE, path.join("diffs", `${CHANGE_ID}.diff`)].sort(),
    );
    const forbidden = [API_KEY, DB_PASSWORD, BASIC_CREDENTIALS, HOME, `measured by ${USERNAME}`];
    for (const [name, text] of files) {
      for (const secret of forbidden) {
        expect(text.includes(secret), `${name} contains a planted value`).toBe(false);
        expect(text.includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
      }
    }
    const bundle = JSON.parse(files.get(BUNDLE_FILE) ?? "") as EvidenceBundle;
    expect(bundle.commands).toEqual([
      "cd ~/projects/app && OPENAI_API_KEY=<redacted:api_key> npm run bench",
      "psql postgres://<redacted:credentials>@127.0.0.1:5432/app -c 'select 1'",
      'curl -fsS -H "Authorization: <redacted:authorization>" http://127.0.0.1:8080/health',
    ]);
    expect(bundle.changes[0]?.hypothesis).toContain("~/.cache/flame.html");
    expect(bundle.changes[0]?.hypothesis).toContain("<redacted:api_key>");
  });

  it("writes a manifest with the sha256 of every file", async () => {
    const { dir, manifest } = await writeBundle(runDir, plantedBundle());
    expect(manifest.bundleId).toBe("server-jvm-2026-10-17.1");
    expect(manifest.files.map((f) => f.path)).toEqual([BUNDLE_FILE, `diffs/${CHANGE_ID}.diff`]);
    const onDisk = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
    expect(onDisk).toEqual(manifest);
  });

  it("rejects an invalid bundle", async () => {
    await expect(
      writeBundle(runDir, { ...plantedBundle(), samples: "none" } as never),
    ).rejects.toThrow();
  });

  it("refuses to export when redaction would break a field", async () => {
    await expect(writeBundle(runDir, plantedBundle(), { username: "claude-code" })).rejects.toThrow(
      /refusing to export/,
    );
  });

  it("replaces an earlier export of the same bundle", async () => {
    await writeBundle(runDir, plantedBundle());
    const { dir } = await writeBundle(runDir, { ...plantedBundle(), limitations: [] });
    const bundle = JSON.parse(await readFile(path.join(dir, BUNDLE_FILE), "utf8"));
    expect(bundle.limitations).toEqual([]);
    expect((await verifyBundle(dir, (b) => b.decisions)).ok).toBe(true);
  });
});

describe("verifyBundle", () => {
  const recorded = (bundle: EvidenceBundle): Decision[] => bundle.decisions;

  it("accepts an untouched bundle whose decisions recompute identically", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    const report = await verifyBundle(dir, recorded);
    expect(report).toMatchObject({ ok: true, unlistedFiles: [], bundleErrors: [] });
    expect(report.files.every((f) => f.status === "ok")).toBe(true);
    expect(report.decisions).toEqual([
      expect.objectContaining({ changeId: CHANGE_ID, status: "match" }),
    ]);
  });

  it("detects an edited file", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    const file = path.join(dir, BUNDLE_FILE);
    await writeFile(file, (await readFile(file, "utf8")).replace('"value": 1620', '"value": 1500'));
    const report = await verifyBundle(dir, recorded);
    expect(report.ok).toBe(false);
    expect(report.files).toContainEqual({ path: BUNDLE_FILE, status: "hash_mismatch" });
  });

  it("detects a decision the samples do not support, even with rehashed files", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    const report = await verifyBundle(dir, (bundle) =>
      bundle.decisions.map((d) => ({ ...d, outcome: "drop", reason: "no_effect" })),
    );
    expect(report.ok).toBe(false);
    expect(report.decisions[0]).toMatchObject({
      status: "mismatch",
      recorded: { outcome: "keep" },
      recomputed: { outcome: "drop", reason: "no_effect" },
    });
  });

  it("reports decisions missing on either side and a throwing recompute", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    expect((await verifyBundle(dir, () => [])).decisions).toEqual([
      expect.objectContaining({ changeId: CHANGE_ID, status: "not_recomputed" }),
    ]);
    const report = await verifyBundle(dir, () => {
      throw new Error("decide failed");
    });
    expect(report).toMatchObject({ ok: false, recomputeError: "decide failed" });
  });

  it("detects missing and unlisted files", async () => {
    const { dir } = await writeBundle(runDir, plantedBundle());
    await rm(path.join(dir, "diffs", `${CHANGE_ID}.diff`));
    await writeFile(path.join(dir, "extra.txt"), "added later");
    const report = await verifyBundle(dir, recorded);
    expect(report.ok).toBe(false);
    expect(report.files).toContainEqual({ path: `diffs/${CHANGE_ID}.diff`, status: "missing" });
    expect(report.unlistedFiles).toEqual(["extra.txt"]);
    expect(report.bundleErrors).toEqual([`diffs/${CHANGE_ID}.diff does not match bundle.json`]);
  });

  it("refuses a manifest that points outside the bundle", async () => {
    const { dir, manifest } = await writeBundle(runDir, plantedBundle());
    const hostile = {
      ...manifest,
      files: [{ path: "../outside", sha256: "0".repeat(64), bytes: 1 }],
    };
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(hostile));
    const report = await verifyBundle(dir, recorded);
    expect(report.ok).toBe(false);
    expect(report.manifestError).toBeDefined();
    expect(report.files).toEqual([]);
  });
});
