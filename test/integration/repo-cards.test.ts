import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveWithGate } from "../../src/app/human-gate.js";
import {
  type AppContext,
  type BaselineResult,
  cancelRun,
  measure,
  runToEnd,
  startRun,
  submitChange,
} from "../../src/app/index.js";
import {
  decisionOf,
  diffOf,
  FIXTURE_CARDS,
  git,
  lightWorkload,
  makeToy,
  TIMEOUT_MS,
  type Toy,
  waitDone,
} from "./helpers.js";

// Verifier V7: cards in a repository directory that ufo.yaml declares (`cardDirs`) load from
// the CLI's own context, so `ufo run` works without a test card directory. Security F10: the
// review shows a recipe's whole replacement. F17: the card directories, git attributes, and the
// script tables the approved commands run through are protected from patches. F8: the checked
// target addresses reach the workload as UFO_TARGET_ADDR.

let toy: Toy | undefined;

afterEach(async () => {
  await toy?.cleanup();
  toy = undefined;
});

/** A toy whose cards live in its own `cards/` directory, declared in ufo.yaml. */
function toyWithRepoCards(config: (yaml: string) => string = (yaml) => yaml): {
  toy: Toy;
  context: AppContext;
} {
  const made = makeToy({ config: (yaml) => `${config(yaml)}cardDirs:\n  - cards\n` });
  cpSync(FIXTURE_CARDS, path.join(made.repo, "cards"), { recursive: true });
  git(made.repo, "add", "--all");
  git(made.repo, "commit", "--quiet", "--message", "cards");
  git(made.scratch, "pull", "--quiet");
  // The CLI's context: no card directory besides the built-in one and what ufo.yaml declares.
  return { toy: made, context: { ...made.context, cardDirs: [] } };
}

async function approveIn(context: AppContext): Promise<string> {
  const printed: string[] = [];
  await approveWithGate(context, {
    stdin: { isTTY: true },
    print: (text) => printed.push(text),
    confirm: async () => "approve",
  });
  return printed.join("");
}

describe("cards declared in ufo.yaml", { timeout: TIMEOUT_MS }, () => {
  it("runs a repository recipe card from the CLI's context and keeps it", async () => {
    const made = toyWithRepoCards();
    toy = made.toy;
    const review = await approveIn(made.context);
    expect(review).toContain("Card directories (protected from patches): cards");
    expect(review).toContain(
      "toy.no-delay: set items.extra_delay_ms={{delay_ms}} in toy.properties",
    );
    const result = await runToEnd(made.context);
    expect(result.decisions).toEqual([{ cardId: "toy.no-delay", outcome: "keep" }]);
  });

  it("shows a recipe's whole replacement in the review", async () => {
    const made = toyWithRepoCards((yaml) =>
      yaml.replace("  - toy.no-delay\n", "  - toy.fewer-requests\n"),
    );
    toy = made.toy;
    const review = await approveIn(made.context);
    expect(review).toContain(`    ${JSON.stringify("const REQUESTS = 15;")}`);
    expect(review).toContain(`    ${JSON.stringify("const REQUESTS = {{requests}};")}`);
  });

  it("refuses a card directory reached through a symbolic link", async () => {
    toy = makeToy({ config: (yaml) => `${yaml}cardDirs:\n  - linked\n` });
    mkdirSync(path.join(toy.root, "outside"));
    symlinkSync(path.join(toy.root, "outside"), path.join(toy.repo, "linked"));
    await expect(approveIn({ ...toy.context, cardDirs: [] })).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("without a symbolic link"),
    });
  });
});

describe("paths protected by the config", { timeout: TIMEOUT_MS }, () => {
  it("refuses patches to the card directory, git attributes, and the npm script table", async () => {
    const made = toyWithRepoCards((yaml) =>
      lightWorkload()(yaml).replace(/^ {2}command: .*$/m, `  command: npm run --silent bench`),
    );
    toy = made.toy;
    writeFileSync(
      path.join(toy.repo, "package.json"),
      `${JSON.stringify({ name: "toy-http", private: true, type: "module", scripts: { bench: `node -e "console.log(JSON.stringify({ latency_ms: 1, error_rate: 0 }))"` } }, null, 2)}\n`,
    );
    git(toy.repo, "commit", "--quiet", "--all", "--message", "bench script");
    git(toy.scratch, "pull", "--quiet");
    const review = await approveIn(made.context);
    expect(review).toContain(
      "Script tables these commands run through (protected from patches): package.json",
    );
    expect(review).toContain('package.json script bench: "node -e');
    const run = await startRun(made.context);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    const current = toy;
    const refused = async (file: string, edit: (s: string) => string) => {
      const queued = await submitChange(made.context, {
        runId: run.runId,
        cardId: "generic.code-change",
        diff: diffOf(current, file, edit),
        hypothesis: `Edits ${file}.`,
      });
      return decisionOf(await waitDone(current, run.runId, queued.jobId));
    };
    for (const [file, edit] of [
      ["cards/toy/fast-path.yaml", (s: string) => s.replace("lossless", "lossy")],
      ["package.json", (s: string) => s.replace("latency_ms: 1", "latency_ms: 0")],
    ] as const) {
      expect(await refused(file, edit)).toMatchObject({
        outcome: "drop",
        reason: "policy:protected_path",
      });
    }
    // A new file: its diff is made with an intent-to-add entry, then the scratch clone is reset.
    writeFileSync(path.join(current.scratch, ".gitattributes"), "* filter=quiet\n");
    git(current.scratch, "add", "--intent-to-add", ".gitattributes");
    const attributes = git(current.scratch, "diff", "--no-color", "--", ".gitattributes");
    git(current.scratch, "rm", "--cached", "--quiet", ".gitattributes");
    const queued = await submitChange(made.context, {
      runId: run.runId,
      cardId: "generic.code-change",
      diff: attributes,
      hypothesis: "Adds git attributes.",
    });
    expect(decisionOf(await waitDone(current, run.runId, queued.jobId))).toMatchObject({
      outcome: "drop",
      reason: "policy:protected_path",
    });
    await cancelRun(made.context, { runId: run.runId });
  });
});

describe("checked targets", { timeout: TIMEOUT_MS }, () => {
  it("reach the workload as UFO_TARGET_ADDR", async () => {
    toy = makeToy({
      config: (yaml) =>
        `${lightWorkload()(yaml).replace(
          /^ {2}command: .*$/m,
          `  command: 'node -e "console.log(JSON.stringify({ latency_ms: process.env.UFO_TARGET_ADDR === \\"127.0.0.1=127.0.0.1\\" ? 1 : 2, error_rate: 0 }))"'`,
        )}targets:\n  - 127.0.0.1\n`,
    });
    await approveIn(toy.context);
    const { baseline } = (await measure(toy.context)) as { baseline: BaselineResult };
    expect(baseline.values).toEqual([1, 1, 1, 1, 1]);
  });
});
