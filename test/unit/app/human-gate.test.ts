import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicEntry from "../../../src/app/index.js";

// Security F16: the human gate's injectable stdin/confirm seam (src/app/human-gate.ts) is for
// tests. Production reaches it only through approve()/extendBudget() in src/app/approve.ts,
// which pass the /dev/tty gate; the public entry does not export it, and nothing else under
// src/ (the CLI today, src/mcp/** in M2) may import it.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SEAM = "human-gate";
const ALLOWED_IMPORTERS = ["src/app/approve.ts"];

function sources(): string[] {
  return readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
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

describe("the human gate seam", () => {
  it("is imported only by approve.ts", () => {
    const importers = sources().filter((file) =>
      specifiers(file).some((spec) => new RegExp(`(^|/)${SEAM}(\\.[jt]s)?$`).test(spec)),
    );
    expect(importers).toEqual(ALLOWED_IMPORTERS);
    // The rule covers the MCP server too, whenever it exists.
    expect(importers.filter((file) => file.startsWith("src/mcp/"))).toEqual([]);
  });

  it("is not part of the public app entry", () => {
    expect(specifiers("src/app/index.ts").filter((spec) => spec.includes(SEAM))).toEqual([]);
    const names = Object.keys(publicEntry);
    for (const name of ["approveWithGate", "extendBudgetWithGate", "askTerminal", "terminalGate"]) {
      expect(names).not.toContain(name);
    }
    expect(names).toEqual(expect.arrayContaining(["approve", "extendBudget"]));
  });

  it("is reached from production only with the terminal gate", () => {
    const source = readFileSync(path.join(ROOT, "src/app/approve.ts"), "utf8");
    // Each production entry passes terminalGate() last, so a caller's own stdin or confirm is
    // overwritten.
    expect(source.match(/\{ \.\.\.options, \.\.\.terminalGate\(\) \}/g)).toHaveLength(2);
    expect(source).not.toMatch(/options\.(confirm|stdin)/);
  });
});
