import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finishRun,
  getJob,
  getRun,
  REPORT_FILE,
  type RunReport,
  report,
  startRun,
  status,
  submitChange,
} from "../../src/app/index.js";
import { LEDGER_FILE, listJobs } from "../../src/core/jobs/index.js";
import {
  approveToy,
  decisionOf,
  diffOf,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// AC 10 through finish_run: a fake API key and the real home path reach UFO in oracle and
// workload output (printed by patched code whose diffs carry the key as well). The raw run state
// keeps them; no file of the exported bundle does.

const FAKE_KEY = `sk-proj-${"Z9y8X7w6".repeat(6)}`;
const IMPORTS = 'import { readFileSync } from "node:fs";\n';
const WITH_LEAK =
  'import { readFileSync, writeSync } from "node:fs";\nimport { homedir } from "node:os";\n';

/** A server.mjs line that writes the key and the home directory to stderr, synchronously. */
const leak = (who: string) =>
  `writeSync(2, \`${who} sees ${FAKE_KEY} under \${homedir()}/.ssh/id_ed25519\\n\`);`;

let toy: Toy;

beforeAll(() => {
  toy = makeToy();
});

afterAll(async () => {
  await toy.cleanup();
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("redaction of command output", { timeout: TIMEOUT_MS }, () => {
  it("keeps the key and the home path out of every exported bundle file", async () => {
    await approveToy(toy);
    const run = await startRun(toy.context);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    const decide = async (diff: string) => {
      const queued = await submitChange(toy.context, {
        runId: run.runId,
        cardId: "generic.code-change",
        diff,
        hypothesis: "Answers faster.",
      });
      return decisionOf(await waitDone(toy, run.runId, queued.jobId));
    };

    // The health route prints the secrets and fails, so the smoke oracle fails with them.
    const oracle = await decide(
      diffOf(toy, "server.mjs", (s) =>
        s
          .replace(IMPORTS, WITH_LEAK)
          .replace(
            '      res.writeHead(200, { "content-type": "text/plain" });',
            `      ${leak("health")}\n      res.writeHead(500, { "content-type": "text/plain" });`,
          ),
      ),
    );
    expect(oracle).toMatchObject({ outcome: "drop", reason: "oracle:smoke" });

    // The server exits with the secrets on stderr when a sample starts it, so every B sample is
    // invalid and its reason carries the output.
    const workload = await decide(
      diffOf(toy, "server.mjs", (s) =>
        s
          .replace(IMPORTS, WITH_LEAK)
          .replace(
            "export function createApp() {\n",
            `export function createApp() {\n  if (process.env.UFO_SAMPLE_INDEX !== undefined) {\n    ${leak("sample")}\n    process.exit(1);\n  }\n`,
          ),
      ),
    );
    expect(workload).toMatchObject({ outcome: "inconclusive", reason: "inconclusive" });

    const finish = await finishRun(toy.context, { runId: run.runId });
    expect((await waitDone(toy, run.runId, finish.jobId)).status).toBe("succeeded");
    const result = (await report(toy.context, { runId: run.runId })) as RunReport;
    expect(result.noHeadline).toBe("no change was kept, so there is nothing to compare");

    // The planted values did reach UFO: the local run state has them verbatim.
    const home = os.homedir();
    const ledger = readFileSync(path.join(toy.runDir(run.runId), LEDGER_FILE), "utf8");
    expect(ledger).toContain(`health sees ${FAKE_KEY} under ${home}/.ssh`);
    expect(ledger).toContain(`sample sees ${FAKE_KEY} under ${home}/.ssh`);

    const files = filesUnder(result.bundleDir);
    expect(files.filter((file) => file.endsWith(".diff"))).toHaveLength(2);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain(FAKE_KEY);
      expect(text, file).not.toContain(home);
    }
    const bundle = JSON.parse(readFileSync(path.join(result.bundleDir, "bundle.json"), "utf8"));
    const redacted = "sees <redacted:api_key> under ~/.ssh/id_ed25519";
    const smoke = bundle.oracleResults.find((r: { passed: boolean }) => !r.passed);
    expect(smoke).toMatchObject({ oracle: "smoke", summary: expect.stringContaining(redacted) });
    const invalid = bundle.samples.filter((s: { valid: boolean }) => !s.valid);
    expect(invalid.length).toBeGreaterThan(0);
    for (const sample of invalid) expect(sample.invalidReason).toContain(redacted);
    expect(bundle.decisions.map((d: { detail?: string }) => d.detail)).toEqual([
      expect.stringContaining(redacted),
      expect.stringContaining(redacted),
    ]);

    // Security F13: every view and report.json are redacted too; only the ledger keeps them.
    const runDir = toy.runDir(run.runId);
    const jobs = await Promise.all(
      (await listJobs(runDir)).map((job) =>
        getJob(toy.context, { runId: run.runId, jobId: job.jobId }),
      ),
    );
    const views: [string, string][] = [
      ["getRun", JSON.stringify(await getRun(toy.context, { runId: run.runId }))],
      ["status", JSON.stringify(await status(toy.context, { runId: run.runId }))],
      ["report", JSON.stringify(result)],
      ["report.json", readFileSync(path.join(runDir, REPORT_FILE), "utf8")],
      ...jobs.map((job): [string, string] => [`getJob ${job.jobId}`, JSON.stringify(job)]),
    ];
    expect(views.some(([, text]) => text.includes("<redacted:api_key>"))).toBe(true);
    for (const [name, text] of views) {
      expect(text, name).not.toContain(FAKE_KEY);
      expect(text, name).not.toContain(home);
    }
  });
});
