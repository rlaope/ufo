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

// A runner word at the start of a command or after `;`, `&&`, `|`, `(`, optionally with a path
// in front of it (`/usr/bin/make`, `./gradlew`, `node_modules/.bin/vitest` is not a runner).
const START = String.raw`(?:^|[\s;&|(])(?:\S*/)?`;
const END = String.raw`(?:\s|$)`;

const runner = (words: string, files: readonly string[]): Runner => ({
  pattern: new RegExp(`${START}(?:${words})${END}`),
  files,
});

/**
 * Each runner with the files that decide what it runs: the script table and the runner's own
 * config. Protected at any depth (a `**` glob in front), so a table in a subdirectory (`npm --prefix`, `make -C`,
 * `cd sub && ...`, workspaces) is covered too.
 */
const RUNNERS: readonly Runner[] = [
  runner(String.raw`npm|pnpm|yarn|bun|npx|node\s+--run`, [
    "package.json",
    ".yarnrc.yml",
    ".yarnrc",
    "bunfig.toml",
    ".pnpmfile.cjs",
    "pnpm-workspace.yaml",
  ]),
  runner("g?make", ["Makefile", "makefile", "GNUmakefile", "*.mk"]),
  runner("just", ["justfile", "Justfile", ".justfile"]),
  runner("task", ["Taskfile.yml", "Taskfile.yaml"]),
  runner(String.raw`deno\s+task`, ["deno.json", "deno.jsonc"]),
  runner("cargo", ["Cargo.toml", ".cargo/config", ".cargo/config.toml"]),
  runner("gradle|gradlew", [
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle/wrapper",
    "buildSrc",
  ]),
  runner("mvn|mvnw", ["pom.xml", ".mvn"]),
  runner(String.raw`poe|pdm\s+run|hatch\s+run|uv\s+run|poetry\s+run|rye\s+run`, ["pyproject.toml"]),
  runner("nox", ["noxfile.py"]),
  runner("rake", ["Rakefile"]),
  runner(String.raw`composer\s+run`, ["composer.json"]),
  runner("go", ["go.mod", "go.work"]),
];

/** Repository files whose scripts the given command lines run. */
export function scriptTablesFor(commands: readonly string[]): string[] {
  const files = new Set<string>();
  for (const { pattern, files: tables } of RUNNERS) {
    if (commands.some((command) => pattern.test(command))) {
      for (const file of tables) files.add(`**/${file}`);
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
