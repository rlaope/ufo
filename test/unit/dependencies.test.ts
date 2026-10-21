import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The tests build the package with the repository's node_modules, devDependencies included, so a
// runtime import of a devDependency would pass every test and fail once installed with
// --omit=dev. Every package src/ imports at runtime is a declared dependency.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = path.join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/** The packages a source file imports at runtime: `import type` is erased, so it is left out. */
function runtimeImports(text: string): string[] {
  const specifiers = [
    ...text.matchAll(/^\s*import\s+(?!type\s)(?:[\w$*{},\s]*?\sfrom\s+)?["']([^"']+)["']/gm),
    ...text.matchAll(/^\s*export\s+(?!type\s)[\w$*{},\s]*?\sfrom\s+["']([^"']+)["']/gm),
    ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1] ?? "");
  return specifiers
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
    .map((specifier) => {
      const parts = specifier.split("/");
      return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
    });
}

// M5 V4 (security-m2a L6): the MCP SDK's server bundles ajv and fast-uri inside its own files,
// where neither `npm ls` nor `npm audit` sees them; the release audit finds them in its source maps.
describe("the release audit of bundled copies", () => {
  it("finds the copies the MCP server bundles, which npm ls does not list", () => {
    const run = (file: string, args: string[]) =>
      execFileSync(file, args, { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    const tree = run("npm", ["ls", "--omit=dev", "--all", "--parseable"]);
    expect(tree).not.toMatch(/node_modules\/(?:fast-uri|ajv)$/m);
    const listed = run(process.execPath, [
      path.join(ROOT, "scripts", "audit-bundled.mjs"),
      "--list",
    ]);
    expect(listed).toMatch(
      /^bundled: fast-uri@\d+\.\d+\.\d+ \(in @modelcontextprotocol\/server\)$/m,
    );
    expect(listed).toMatch(/^bundled: ajv@\d+\.\d+\.\d+ \(in @modelcontextprotocol\/server\)$/m);
  });
});

describe("the packages src/ imports at runtime", () => {
  it("are all declared in package.json dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const undeclared = sources(SRC).flatMap((file) =>
      runtimeImports(readFileSync(file, "utf8"))
        .filter((name) => !declared.has(name))
        .map((name) => `${path.relative(ROOT, file)}: ${name}`),
    );
    expect(undeclared).toEqual([]);
  });

  it("are found by the check, multi-line imports and re-exports included", () => {
    const text = [
      'import { a } from "zod";',
      "import {",
      "  b,",
      '} from "@modelcontextprotocol/client/stdio";',
      'import type { C } from "vitest";',
      'export { d } from "yaml";',
      'const e = await import("picomatch");',
      'import "node:fs";',
      'import f from "./local.js";',
    ].join("\n");
    expect(runtimeImports(text)).toEqual([
      "zod",
      "@modelcontextprotocol/client",
      "yaml",
      "picomatch",
    ]);
    // A string in code that is no import is no import.
    expect(runtimeImports("export function f() {\n  return /from '(x)'/;\n}\n")).toEqual([]);
  });
});
