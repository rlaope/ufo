import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveWithGate } from "../../src/app/human-gate.js";
import {
  type AppContext,
  listRunIds,
  measure,
  report,
  resolveRepo,
  runToEnd,
} from "../../src/app/index.js";
import { formatReport } from "../../src/cli/format.js";
import { readRun } from "../../src/core/jobs/index.js";
import { FIXTURE_CARDS, lightWorkload, makeToy, TIMEOUT_MS, type Toy } from "./helpers.js";

// Code review #8: `ufo run` lives in the app layer and never leaves a run `running`: a failed
// job cancels the run, and a baseline refused for noise finishes it at once with a report.
// Verifier V3: a measure whose baseline failed is a failed run, and the report says so.

let toy: Toy | undefined;

afterEach(async () => {
  await toy?.cleanup();
  toy = undefined;
});

async function approveIn(context: AppContext) {
  await approveWithGate(context, {
    stdin: { isTTY: true },
    print: () => undefined,
    confirm: async () => "approve",
  });
}

async function onlyRun(current: Toy) {
  const ids = await listRunIds(current.home, await resolveRepo(current.repo));
  expect(ids).toHaveLength(1);
  const runId = ids[0] as string;
  return { runId, record: await readRun(current.runDir(runId)) };
}

describe("ufo run to the end", { timeout: TIMEOUT_MS }, () => {
  it("finishes at once with a report when the baseline is refused for noise", async () => {
    toy = makeToy({
      env: { TOY_NOISE: "0.4" },
      config: (yaml) => `${yaml}env:\n  - TOY_NOISE\n`,
    });
    await approveIn(toy.context);
    await expect(runToEnd(toy.context)).rejects.toMatchObject({
      code: "measurement_failed",
      message: expect.stringContaining("the baseline was refused (policy:noise_floor"),
    });
    const { runId, record } = await onlyRun(toy);
    expect(record.status).toBe("finished");
    const kept = await report(toy.context, { runId });
    expect("noHeadline" in kept && kept.decisions).toEqual([]);
  });

  it("cancels the run when a recipe job fails", async () => {
    toy = makeToy({
      config: (yaml) =>
        lightWorkload()(yaml).replace(/^cards:\n(?: {2}- .+\n)+/m, "cards:\n  - toy.bad-reset\n"),
    });
    const extra = path.join(toy.root, "extra-cards", "toy");
    mkdirSync(extra, { recursive: true });
    writeFileSync(
      path.join(extra, "bad-reset.yaml"),
      [
        "id: toy.bad-reset",
        "domain: toy",
        "title: A recipe whose reset hook fails",
        "kind: recipe",
        "riskClass: lossless",
        "edits:",
        "  - op: set_property",
        "    file: toy.properties",
        "    key: items.extra_delay_ms",
        `    value: "11"`,
        "commandTemplates:",
        "  - id: reset",
        `    run: node -e "process.exit(3)"`,
        "signals:",
        "  - Used by the integration tests",
        "verifiedIn: unverified",
        "",
      ].join("\n"),
    );
    const context = { ...toy.context, cardDirs: [FIXTURE_CARDS, path.dirname(extra)] };
    await approveIn(context);
    await expect(runToEnd(context)).rejects.toMatchObject({
      code: "measurement_failed",
      message: expect.stringMatching(/^toy\.bad-reset failed: .*reset hook.* was cancelled$/),
    });
    expect((await onlyRun(toy)).record.status).toBe("cancelled");
  });

  it("records a measure whose baseline failed as a failed run", async () => {
    toy = makeToy({ config: lightWorkload(`node -e "process.exit(1)"`) });
    await approveIn(toy.context);
    await expect(measure(toy.context)).rejects.toMatchObject({ code: "measurement_failed" });
    const { runId, record } = await onlyRun(toy);
    expect(record.status).toBe("failed");
    const text = formatReport(await report(toy.context, { runId }));
    expect(text.split("\n")[0]).toBe(`Run ${runId} is failed; it has no report.`);
  });
});
