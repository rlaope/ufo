import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../../../src/app/api.js";
import * as apiCli from "../../../src/app/api-cli.js";

// M2 A6, B3a: the CLI and the MCP server reach the rest of src only through src/app/api.ts,
// which exports the workflows, the failure mapping, and the result types, and none of the
// internals an adapter could use to act on run state around the workflows. The human-only steps
// and the worker entry are in src/app/api-cli.ts, which only the CLI imports.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const API = "src/app/api.ts";
const API_CLI = "src/app/api-cli.ts";

/**
 * What each adapter may import besides Node built-ins and packages. The CLI starts the MCP
 * server (`ufo mcp`), and `ufo setup`, `uninstall`, and `update` write host config files and run
 * no app workflow. The MCP server imports neither, nor anything human-only.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "src/cli": [API, API_CLI, "src/cli/", "src/mcp/", "src/setup/"],
  "src/mcp": [API, "src/mcp/"],
};

function sourcesUnder(dir: string): string[] {
  if (!existsSync(path.join(ROOT, dir))) return [];
  return readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

/** Module specifiers `text` imports or re-exports, static or dynamic, in any quotes. */
function specifiersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])((?:(?!\1).)+)\1/g,
  )) {
    found.push(match[2] ?? "");
  }
  return found;
}

function specifiers(file: string): string[] {
  return specifiersIn(readFileSync(path.join(ROOT, file), "utf8"));
}

/** The repository-relative source file a relative specifier of `file` names. */
function target(file: string, specifier: string): string {
  const resolved = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), specifier));
  return resolved.split(path.sep).join("/").replace(/\.js$/, ".ts");
}

/** Imports of `file` outside `allowed`; a computed specifier (`${...}`) is never allowed. */
function outside(file: string, allowed: readonly string[]): string[] {
  return specifiers(file)
    .filter((specifier) => specifier.startsWith(".") || specifier.includes("${"))
    .filter((specifier) => {
      if (specifier.includes("${")) return true;
      const to = target(file, specifier);
      return !allowed.some((entry) => (entry.endsWith("/") ? to.startsWith(entry) : to === entry));
    })
    .map((specifier) => `${file} -> ${specifier}`);
}

describe("the adapter modules", () => {
  it("are the only way from the CLI and the MCP server into the rest of src", () => {
    const found = Object.entries(ALLOWED).flatMap(([adapter, allowed]) =>
      sourcesUnder(adapter).flatMap((file) => outside(file, allowed)),
    );
    expect(found).toEqual([]);
    const cli = sourcesUnder("src/cli");
    expect(cli.some((file) => specifiers(file).some((s) => target(file, s) === API))).toBe(true);
    expect(sourcesUnder("src/mcp").length).toBeGreaterThan(0);
  });

  it("let only the CLI import the human-only steps and the worker entry", () => {
    const importers = sourcesUnder("src").filter((file) =>
      specifiers(file).some((s) => s.startsWith(".") && target(file, s) === API_CLI),
    );
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !file.startsWith("src/cli/"))).toEqual([]);
  });

  // Code review (step A) #9: a template-literal import is found, an interpolated one refused.
  it("find template-literal and computed specifiers too", () => {
    const sample = [
      'import { a } from "./a.js";',
      "export * from './b.js';",
      "const c = await import(`../app/run.js`);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of an interpolated import
      "const d = await import(`../app/${name}.js`);",
    ].join("\n");
    expect(specifiersIn(sample)).toEqual([
      "./a.js",
      "./b.js",
      "../app/run.js",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the specifier as written
      "../app/${name}.js",
    ]);
  });

  it("export exactly the workflows, failure mapping, and constants adapters use", () => {
    expect(Object.keys(api).sort()).toEqual([
      "CONTROL_LOCK_WAIT_MS",
      "EXIT_INTERNAL",
      "EXIT_OK",
      "EXIT_REFUSED",
      "EXIT_USAGE",
      "MAX_WAIT_S",
      "cancelRun",
      "checkCapabilities",
      "describeFailure",
      "finishRun",
      "getJob",
      "getRun",
      "hintFor",
      "inspectTarget",
      "listTechniques",
      "measure",
      "packageVersion",
      "profileTarget",
      "redact",
      "report",
      "resumeRun",
      "runToEnd",
      "startRun",
      "status",
      "submitChange",
      "trustProcessPath",
    ]);
    expect(Object.keys(apiCli).sort()).toEqual([
      "WORKER_COMMAND",
      "approve",
      "extendBudget",
      "init",
      "runAppWorker",
    ]);
  });
});
