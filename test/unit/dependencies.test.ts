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
