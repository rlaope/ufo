import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TechniqueCard, UfoConfig } from "../domain/index.js";
import { approvedCommands } from "./review.js";

// An approved command that runs `npm run bench` or `make test` executes whatever the script
// table says, and a patch could rewrite that table. The tables the approved commands dispatch
// through are protected like the benchmarks themselves (security F17).

interface Runner {
  readonly pattern: RegExp;
  readonly files: readonly string[];
}

const START = String.raw`(?:^|[\s;&|(])`;

const RUNNERS: readonly Runner[] = [
  { pattern: new RegExp(`${START}(?:npm|pnpm|yarn|bun)\\s+\\S`), files: ["package.json"] },
  {
    pattern: new RegExp(`${START}g?make(?:\\s|$)`),
    files: ["Makefile", "makefile", "GNUmakefile"],
  },
  { pattern: new RegExp(`${START}just(?:\\s|$)`), files: ["justfile", "Justfile", ".justfile"] },
  { pattern: new RegExp(`${START}task(?:\\s|$)`), files: ["Taskfile.yml", "Taskfile.yaml"] },
  {
    pattern: new RegExp(`${START}(?:poe|pdm\\s+run|hatch\\s+run)(?:\\s|$)`),
    files: ["pyproject.toml"],
  },
];

/** Repository files whose scripts the given command lines run. */
export function scriptTablesFor(commands: readonly string[]): string[] {
  const files = new Set<string>();
  for (const runner of RUNNERS) {
    if (commands.some((command) => runner.pattern.test(command))) {
      for (const file of runner.files) files.add(file);
    }
  }
  return [...files];
}

/**
 * Paths no change may edit for this config, on top of the defaults: the declared card
 * directories and the script tables the approved commands dispatch through.
 */
export function configProtectedPaths(config: UfoConfig, cards: readonly TechniqueCard[]): string[] {
  const commands = approvedCommands(config, cards).map((c) => c.command);
  return [...config.cardDirs, ...scriptTablesFor(commands)];
}

const NPM_SCRIPT =
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:--?[\w-]+\s+)*([\w:.][\w:.-]*)/g;
const NOT_SCRIPTS = new Set(["install", "ci", "add", "exec", "x", "dlx", "i", "remove", "update"]);

/** `name: body` of every package.json script the commands run, for the approval review. */
export async function npmScriptBodies(
  repoRoot: string,
  commands: readonly string[],
): Promise<string[]> {
  const names = new Set<string>();
  for (const command of commands) {
    for (const match of command.matchAll(NPM_SCRIPT)) {
      const name = match[1];
      if (name !== undefined && !NOT_SCRIPTS.has(name)) names.add(name);
    }
  }
  if (names.size === 0) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const pkg: unknown = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    if (typeof pkg === "object" && pkg !== null && "scripts" in pkg) {
      const value = (pkg as { scripts: unknown }).scripts;
      if (typeof value === "object" && value !== null) scripts = value as Record<string, unknown>;
    }
  } catch {
    return [...names].map((name) => `${name}: (no readable package.json)`);
  }
  return [...names].map((name) => {
    const body = scripts[name];
    return `${name}: ${typeof body === "string" ? JSON.stringify(body) : "(not defined)"}`;
  });
}
