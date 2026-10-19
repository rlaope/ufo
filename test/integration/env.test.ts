import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRun, readAppState, startRun } from "../../src/app/index.js";
import { approveToy, lightWorkload, makeToy, TIMEOUT_MS, type Toy, waitDone } from "./helpers.js";

// Security F9 / code review #9: every workload, oracle, and hook command runs with the
// environment allowlist captured at start (defaults plus ufo.yaml's `env:`), never with the
// launcher's whole environment.

const SENTINEL = "UFO_TEST_SENTINEL_VALUE_7f3a";

let toy: Toy;
let dump: string;

beforeAll(() => {
  toy = makeToy({
    env: { LAUNCHER_SECRET_TOKEN: SENTINEL, LISTED_SETTING: "visible-value" },
    config: (yaml) =>
      `${lightWorkload(`env > "${path.join("..", "..", "..", "..", "env-$UFO_ARM.txt")}"`)(yaml)}env:\n  - LISTED_SETTING\n`,
  });
  dump = path.join(toy.home, "env-a.txt");
});

afterAll(async () => {
  await toy.cleanup();
});

function variables(text: string): Map<string, string> {
  return new Map(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

describe("command environment", { timeout: TIMEOUT_MS }, () => {
  it("passes only the allowlist and listed names to commands, and shows the names at approval", async () => {
    const printed: string[] = [];
    await approveToy(toy, { print: (text) => printed.push(text) });
    expect(printed.join("")).toContain(
      "Environment of every command: PATH, HOME, LANG, TMPDIR, USER, SHELL, TERM, LC_*, plus LISTED_SETTING from ufo.yaml",
    );

    const run = await startRun(toy.context);
    expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
    const seen = variables(readFileSync(dump, "utf8"));
    expect(seen.get("LISTED_SETTING")).toBe("visible-value");
    expect(seen.get("PATH")).toBe(process.env.PATH);
    expect(seen.get("UFO_ARM")).toBe("a");
    expect(seen.get("UFO_RUN_ID")).toBe(run.runId);
    // The launcher's other variables stay out: secrets, UFO's home, the git config location.
    expect(readFileSync(dump, "utf8")).not.toContain(SENTINEL);
    for (const name of ["LAUNCHER_SECRET_TOKEN", "UFO_HOME", "GIT_CONFIG_GLOBAL", "VITEST"]) {
      expect(seen.has(name)).toBe(false);
    }
    // The captured values are the run's own, whichever process launches its next worker.
    const state = await readAppState(toy.runDir(run.runId));
    expect(Object.keys(state.env)).not.toContain("LAUNCHER_SECRET_TOKEN");
    expect(state.env.LISTED_SETTING).toBe("visible-value");
    await cancelRun(toy.context, { runId: run.runId });
  });
});
