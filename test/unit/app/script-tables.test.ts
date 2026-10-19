import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { npmScriptBodies, scriptTablesFor } from "../../../src/app/script-tables.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("scriptTablesFor", () => {
  it("names the tables the commands dispatch through", () => {
    expect(scriptTablesFor(["node bench.mjs", "echo cmake"])).toEqual([]);
    expect(scriptTablesFor(["npm run bench"])).toEqual(["package.json"]);
    expect(scriptTablesFor(["cd app && make test"])).toEqual([
      "Makefile",
      "makefile",
      "GNUmakefile",
    ]);
    expect(scriptTablesFor(["just bench", "pdm run test"])).toEqual([
      "justfile",
      "Justfile",
      ".justfile",
      "pyproject.toml",
    ]);
  });
});

describe("npmScriptBodies", () => {
  it("shows each script the commands run, skipping flags and install commands", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ufo-scripts-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { bench: "node bench.mjs", test: "node --test" } }),
    );
    expect(
      await npmScriptBodies(dir, ["npm run --silent bench", "pnpm test", "npm ci", "npm run gone"]),
    ).toEqual(['bench: "node bench.mjs"', 'test: "node --test"', "gone: (not defined)"]);
  });
});
