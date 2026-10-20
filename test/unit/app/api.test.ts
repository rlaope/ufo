import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../../../src/app/api.js";

// M2 A6: the CLI and the MCP server reach the rest of src only through src/app/api.ts, which
// exports the workflows, the failure mapping, and the result types, and none of the internals an
// adapter could use to act on run state around the workflows.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const API = "src/app/api.ts";
const ADAPTERS = ["src/cli", "src/mcp"];
/**
 * What an adapter may import besides api.ts and its own directory. `ufo setup`, `uninstall`, and
 * `update` write host config files and run no app workflow; the MCP server never calls them.
 */
const ALSO_ALLOWED: Readonly<Record<string, readonly string[]>> = { "src/cli": ["src/setup/"] };

function sourcesUnder(dir: string): string[] {
  if (!existsSync(path.join(ROOT, dir))) return [];
  return readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

/** Module specifiers a source file imports or re-exports, static or dynamic. */
function specifiers(file: string): string[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g,
  )) {
    found.push(match[1] ?? "");
  }
  return found;
}

/** The repository-relative source file a relative specifier of `file` names. */
function target(file: string, specifier: string): string {
  const resolved = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), specifier));
  return resolved.split(path.sep).join("/").replace(/\.js$/, ".ts");
}

describe("the adapter module", () => {
  it("is the only way from the CLI and the MCP server into the rest of src", () => {
    const outside: string[] = [];
    for (const adapter of ADAPTERS) {
      for (const file of sourcesUnder(adapter)) {
        // Bare specifiers are Node built-ins and packages.
        for (const specifier of specifiers(file).filter((s) => s.startsWith("."))) {
          const to = target(file, specifier);
          const allowed = [`${adapter}/`, ...(ALSO_ALLOWED[adapter] ?? [])];
          if (to !== API && !allowed.some((dir) => to.startsWith(dir))) {
            outside.push(`${file} -> ${specifier}`);
          }
        }
      }
    }
    expect(outside).toEqual([]);
    const cli = sourcesUnder("src/cli");
    expect(cli.length).toBeGreaterThan(0);
    expect(cli.some((file) => specifiers(file).some((s) => target(file, s) === API))).toBe(true);
  });

  it("exports the workflows adapters call and none of the internals", () => {
    const names = Object.keys(api);
    expect(names).toEqual(
      expect.arrayContaining([
        "startRun",
        "submitChange",
        "getJob",
        "getRun",
        "finishRun",
        "resumeRun",
        "cancelRun",
        "status",
        "report",
        "describeFailure",
        "hintFor",
      ]),
    );
    for (const internal of [
      "openRun",
      "readAppState",
      "writeAppState",
      "activeRun",
      "locateRun",
      "ensureWorker",
      "ensureWorkerFor",
      "checkBudgetOpen",
      "runRecipes",
      "createJobHandlers",
      "handleBaseline",
      "handleChange",
      "handleFinish",
      "approveWithGate",
      "extendBudgetWithGate",
      "terminalGate",
    ]) {
      expect(names).not.toContain(internal);
    }
  });
});
