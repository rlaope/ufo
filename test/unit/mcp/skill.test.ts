import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { registerTools, type ToolDeps } from "../../../src/mcp/tools.js";

// M2 C1: the skill setup installs in every host reads as a valid skill there (Codex and Cursor
// require `name` and `description`; Cursor's `name` matches the folder), and names only tools
// the server serves.

const SKILL_DIR = fileURLToPath(new URL("../../../skills/ufo-optimize/", import.meta.url));
const text = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");

function frontmatter(): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new Error("SKILL.md has no frontmatter");
  return parse(match[1] ?? "") as Record<string, unknown>;
}

function servedTools(): string[] {
  const names: string[] = [];
  const server = { registerTool: (name: string) => names.push(name) };
  registerTools(server as never, {} as ToolDeps);
  return names;
}

describe("the ufo-optimize skill", () => {
  it("has the name of its folder and a description", () => {
    const { name, description } = frontmatter();
    expect(name).toBe(path.basename(SKILL_DIR));
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(typeof description).toBe("string");
    expect((description as string).length).toBeGreaterThan(0);
    expect((description as string).length).toBeLessThanOrEqual(1024);
  });

  it("names every tool the server serves, and no other", () => {
    const tools = servedTools();
    const named = new Set(
      [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)]
        .map((match) => match[1] ?? "")
        .filter((name) => /_(?:target|capabilities|techniques|run|change|job)$/.test(name)),
    );
    expect([...named].sort()).toEqual([...tools].sort());
  });
});
