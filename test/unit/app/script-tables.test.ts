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
  it("protects the tables and runner configs the commands dispatch through, at any depth", () => {
    expect(scriptTablesFor(["node bench.mjs", "echo cmake"])).toEqual([]);
    expect(scriptTablesFor(["npm run bench"])).toEqual([
      "**/package.json",
      "**/.yarnrc.yml",
      "**/.yarnrc",
      "**/bunfig.toml",
      "**/.pnpmfile.cjs",
      "**/pnpm-workspace.yaml",
    ]);
    expect(scriptTablesFor(["cd app && /usr/bin/make test"])).toContain("**/Makefile");
    expect(scriptTablesFor(["./gradlew test"])).toContain("**/gradle/wrapper");
    expect(scriptTablesFor(["./mvnw -q verify"])).toContain("**/pom.xml");
    expect(scriptTablesFor(["node --run bench"])).toContain("**/package.json");
    expect(scriptTablesFor(["uv run pytest"])).toEqual(["**/pyproject.toml"]);
    // `task` matches too: protecting a Taskfile that does not exist costs nothing (fail closed).
    expect(scriptTablesFor(["deno task bench"])).toEqual([
      "**/Taskfile.yml",
      "**/Taskfile.yaml",
      "**/deno.json",
      "**/deno.jsonc",
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
