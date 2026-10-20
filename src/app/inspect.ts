// What an agent reads before a run: the target repository and its ufo.yaml, the programs its
// approved commands start, and the technique cards. Nothing here runs a repository command.

import { execFile } from "node:child_process";
import { access, constants, lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { redact } from "../core/evidence/index.js";
import { runGit } from "../core/git/index.js";
import { checkApproval } from "../core/policy/index.js";
import type { Bottleneck, Objective, StackId, TechniqueCard, UfoConfig } from "../domain/index.js";
import type { Exec } from "../worker/index.js";
import { approvalSubject, type CardSet, loadCards } from "./cards.js";
import { draftConfigFor, type LoadedConfig, loadConfig } from "./config.js";
import { type AppContext, homeFor, type Repo, repoOf } from "./context.js";
import { type DetectedStack, detectStacks } from "./detect.js";
import { captureEnv } from "./env.js";
import { AppError, describeFailure } from "./errors.js";
import { type ApprovedCommand, approvedCommands } from "./review.js";

const execFileAsync = promisify(execFile);

/** Files at the repository root that name its stack. */
export const STACK_MARKERS: readonly string[] = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
  "Makefile",
  "Dockerfile",
];

interface ReadConfig {
  readonly loaded: LoadedConfig;
  readonly cards: CardSet;
}

/** ufo.yaml and the cards it enables, or why they cannot be read. */
async function readConfig(
  repo: Repo,
  context: AppContext,
): Promise<ReadConfig | { readonly error: string; readonly present: boolean }> {
  try {
    const loaded = await loadConfig(repo.root);
    return { loaded, cards: await loadCards(repo.root, context, loaded.config) };
  } catch (error) {
    const failure = describeFailure(error);
    if (failure.code === "internal") throw error;
    return {
      error: `${failure.code}: ${failure.message}`,
      present: failure.code !== "config_missing",
    };
  }
}

function enabledCards(config: UfoConfig, cards: CardSet): TechniqueCard[] {
  return config.cards.flatMap((id) => {
    const entry = cards.get(id);
    return entry === undefined ? [] : [entry.card];
  });
}

export interface TargetInspection {
  repoRoot: string;
  /** Files at the repository root that name its stack (`STACK_MARKERS`). */
  stack: string[];
  /** The stacks read from the repository's files, with the evidence for each. */
  stacks: DetectedStack[];
  config: { present: boolean; valid: boolean; error?: string | undefined };
  /**
   * While there is no ufo.yaml: the draft `ufo init` writes, built from `stacks`, to fill in and
   * save as ufo.yaml at the repository root. UFO's own text, so it is not redacted.
   */
  draftConfig?: string;
  /** Whether ufo.yaml, its enabled cards, opt-ins, and `env:` names are what was approved. */
  approval?: { approved: boolean; reason?: string | undefined; detail?: string | undefined };
  objective?: Objective | undefined;
  /** The cards ufo.yaml enables; `known: false` for an id no card directory has. */
  cards?: { id: string; known: boolean }[];
  optIns?: string[];
  /** Every command the approval covers, in the order UFO runs them. */
  commands?: ApprovedCommand[];
}

/** `inspect_target`: the repository, its ufo.yaml, and whether this ufo.yaml is approved. */
export async function inspectTarget(context: AppContext): Promise<TargetInspection> {
  const repo = await repoOf(context);
  const home = await homeFor(context, repo);
  const stack: string[] = [];
  for (const marker of STACK_MARKERS) {
    if (await lstat(path.join(repo.root, marker)).catch(() => undefined)) stack.push(marker);
  }
  const stacks = await detectStacks(repo.root);
  const read = await readConfig(repo, context);
  if ("error" in read) {
    return {
      ...redact({
        repoRoot: repo.root,
        stack,
        stacks,
        config: { present: read.present, valid: false, error: read.error },
      }),
      ...(read.present ? {} : { draftConfig: draftConfigFor(stacks) }),
    };
  }
  const { loaded, cards } = read;
  const subject = approvalSubject(loaded.hash, loaded.config, cards);
  const refused = await checkApproval(repo.repoId, subject, { home });
  return redact({
    repoRoot: repo.root,
    stack,
    stacks,
    config: { present: true, valid: true },
    approval:
      refused === undefined
        ? { approved: true }
        : { approved: false, reason: `policy:${refused.rule}`, detail: refused.detail },
    objective: loaded.config.objective,
    cards: loaded.config.cards.map((id) => ({ id, known: cards.has(id) })),
    optIns: [...loaded.config.optIns],
    commands: approvedCommands(loaded.config, enabledCards(loaded.config, cards)),
  });
}

/** Shell words that are not programs on PATH. */
const SHELL_WORDS = new Set([
  ".",
  ":",
  "[",
  "cd",
  "command",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "printf",
  "read",
  "set",
  "shift",
  "source",
  "test",
  "trap",
  "true",
  "false",
  "unset",
  "wait",
]);

/** How to get a missing program, for the ones approved commands often start. */
const INSTALL_HINTS: Readonly<Record<string, string>> = {
  node: "install Node.js (https://nodejs.org)",
  npm: "install Node.js (https://nodejs.org), which ships npm",
  npx: "install Node.js (https://nodejs.org), which ships npx",
  pnpm: "install pnpm (https://pnpm.io/installation)",
  yarn: "install Yarn (https://yarnpkg.com/getting-started/install)",
  python: "install Python 3 (https://www.python.org/downloads/)",
  python3: "install Python 3 (https://www.python.org/downloads/)",
  pip: "install Python 3, which ships pip",
  pip3: "install Python 3, which ships pip",
  uv: "install uv (https://docs.astral.sh/uv/)",
  pytest: "install pytest into the Python environment the commands use",
  go: "install Go (https://go.dev/dl/)",
  cargo: "install Rust with rustup (https://rustup.rs)",
  rustc: "install Rust with rustup (https://rustup.rs)",
  java: "install a JDK (https://adoptium.net)",
  mvn: "install Maven (https://maven.apache.org/install.html)",
  gradle: "install Gradle (https://gradle.org/install/)",
  make: "install the Xcode command line tools: xcode-select --install",
  docker: "install Docker Desktop (https://docs.docker.com/desktop/)",
  k6: "install k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/)",
  wrk: "install wrk (brew install wrk)",
  hey: "install hey (brew install hey)",
  hyperfine: "install hyperfine (brew install hyperfine)",
};

/** The program a command line starts: its first word after `NAME=value` assignments. */
export function programOf(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  const first = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const program = first?.replace(/^[({]+/, "").replace(/^["']|["']$/g, "");
  return program === undefined || program === "" ? undefined : program;
}

async function executable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** The first executable `program` on `searchPath`, as commands would find it. */
async function onPath(program: string, searchPath: string): Promise<string | undefined> {
  for (const dir of searchPath.split(path.delimiter).filter((entry) => entry !== "")) {
    const candidate = path.join(dir, program);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export interface ProgramCheck {
  program: string;
  found: boolean;
  /**
   * `path`: on the PATH commands get; `repository`: a path inside the repository;
   * `outside_repository`: a relative path that leaves it, never looked up; `shell`.
   */
  where?: "path" | "repository" | "outside_repository" | "shell" | undefined;
  path?: string | undefined;
  hint?: string | undefined;
  /** The approved commands that start it (`ufo approve` names them the same way). */
  usedBy: string[];
}

export interface CapabilityReport {
  git: { found: boolean; version?: string | undefined; error?: string | undefined };
  /** The Node.js that runs UFO and its worker. */
  node: { version: string };
  /**
   * `found` false when Docker is not installed; `reachable` false when it is but `docker version`
   * fails (its daemon stopped), with the first line it printed on stderr.
   */
  docker: {
    found: boolean;
    reachable?: boolean | undefined;
    version?: string | undefined;
    error?: string | undefined;
  };
  /** Each program the approved commands start, looked up without running it. */
  programs: ProgramCheck[];
  /** Why there are no programs to check: ufo.yaml or its cards cannot be read. */
  configError?: string | undefined;
}

async function checkProgram(
  program: string,
  repo: Repo,
  searchPath: string,
): Promise<Omit<ProgramCheck, "usedBy">> {
  if (SHELL_WORDS.has(program)) return { program, found: true, where: "shell" };
  if (path.isAbsolute(program)) return { program, found: await executable(program), where: "path" };
  if (program.includes("/")) {
    const file = path.resolve(repo.root, program);
    // Not looked up: nothing outside the repository says what a command run in its arm finds.
    if (file !== repo.root && !file.startsWith(`${repo.root}${path.sep}`)) {
      return {
        program,
        found: false,
        where: "outside_repository",
        hint: "this path leaves the repository; a command runs in UFO's clone of it, so name a program on PATH or a file inside the repository",
      };
    }
    return {
      program,
      found: (await lstat(file).catch(() => undefined)) !== undefined,
      where: "repository",
    };
  }
  const found = await onPath(program, searchPath);
  if (found !== undefined) return { program, found: true, where: "path", path: found };
  return {
    program,
    found: false,
    hint:
      INSTALL_HINTS[program] ??
      `install ${program}, or put it on PATH outside the repository and UFO's home`,
  };
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/**
 * `check_capabilities`: git, Node.js, and Docker, and whether each program the approved commands
 * start is on the PATH those commands get. It runs `git --version` and `docker version`, never a
 * repository command.
 */
export async function checkCapabilities(context: AppContext): Promise<CapabilityReport> {
  const repo = await repoOf(context);
  const home = await homeFor(context, repo);
  const gitVersion = await runGit(["--version"], repo.root).then(
    (result) =>
      result.code === 0
        ? { found: true, version: result.stdout.trim().replace(/^git version /, "") }
        : { found: false, error: result.stderr.trim() },
    (error: unknown) => ({ found: false, error: describe(error) }),
  );
  const exec: Exec =
    context.exec ?? ((file, args) => execFileAsync(file, [...args], { timeout: 10_000 }));
  const docker = await exec("docker", ["version", "--format", "{{.Server.Version}}"]).then(
    ({ stdout }): CapabilityReport["docker"] => ({
      found: true,
      reachable: true,
      version: stdout.trim(),
    }),
    (error: unknown): CapabilityReport["docker"] => {
      const failed = error as { code?: unknown; stderr?: unknown };
      if (failed.code === "ENOENT") return { found: false, error: "not installed (not on PATH)" };
      const stderr = typeof failed.stderr === "string" ? failed.stderr : "";
      const line = stderr.split("\n").find((text) => text.trim() !== "");
      return { found: true, reachable: false, error: line?.trim() ?? describe(error) };
    },
  );
  const report: CapabilityReport = {
    git: gitVersion,
    node: { version: process.version },
    docker,
    programs: [],
  };
  const read = await readConfig(repo, context);
  if ("error" in read) return redact({ ...report, configError: read.error });
  const { loaded, cards } = read;
  const env = captureEnv(context.workerEnv ?? process.env, loaded.config.env, [
    repo.root,
    repo.gitDir,
    repo.commonDir,
    home,
  ]);
  const usedBy = new Map<string, string[]>();
  for (const { what, command } of approvedCommands(
    loaded.config,
    enabledCards(loaded.config, cards),
  )) {
    const program = programOf(command);
    if (program === undefined) continue;
    usedBy.set(program, [...(usedBy.get(program) ?? []), what]);
  }
  for (const [program, whats] of usedBy) {
    report.programs.push({
      ...(await checkProgram(program, repo, env.PATH ?? "")),
      usedBy: whats,
    });
  }
  return redact(report);
}

export interface TechniqueListing {
  /** One compact entry per card; `getTechnique` opens the full card. */
  cards: {
    id: string;
    domain: string;
    title: string;
    kind: string;
    riskClass: string;
    /** Stacks the card applies to; empty means any. */
    stacks: StackId[];
    bottlenecks: Bottleneck[];
    expectedEffect?: string | undefined;
    /** ufo.yaml enables it; only enabled cards can be submitted. */
    enabled: boolean;
  }[];
  /** Why only the built-in cards are listed: ufo.yaml or its card directories cannot be read. */
  configError?: string | undefined;
}

/** How early a card is listed: for the stacks asked for or detected, for any stack, for others. */
function rank(card: TechniqueCard, wanted: ReadonlySet<StackId>): number {
  if (card.stacks.some((id) => wanted.has(id))) return 0;
  return card.stacks.length === 0 ? 1 : 2;
}

/**
 * `list_techniques`: an index of the cards UFO knows for this repository, optionally of one domain, one
 * stack (cards for that stack and cards for any stack), or one bottleneck. Without a stack
 * filter the cards for the repository's detected stacks come first, then the stack-independent
 * ones.
 */
export async function listTechniques(
  context: AppContext,
  options: {
    readonly domain?: string;
    readonly stack?: StackId;
    readonly bottleneck?: Bottleneck;
  } = {},
): Promise<TechniqueListing> {
  const repo = await repoOf(context);
  const read = await readConfig(repo, context);
  const cards = "error" in read ? await loadCards(repo.root, context) : read.cards;
  const enabled = new Set("error" in read ? [] : read.loaded.config.cards);
  const wanted = new Set<StackId>(
    options.stack === undefined
      ? (await detectStacks(repo.root)).map((stack) => stack.id)
      : [options.stack],
  );
  const listed = [...cards.values()]
    .map(({ card }) => card)
    .filter((card) => options.domain === undefined || card.domain === options.domain)
    .filter(
      (card) =>
        options.stack === undefined ||
        card.stacks.length === 0 ||
        card.stacks.includes(options.stack),
    )
    .filter(
      (card) => options.bottleneck === undefined || card.bottlenecks.includes(options.bottleneck),
    )
    .sort((a, b) => rank(a, wanted) - rank(b, wanted) || a.id.localeCompare(b.id))
    .map((card) => ({
      id: card.id,
      domain: card.domain,
      title: card.title,
      kind: card.kind,
      riskClass: card.riskClass,
      stacks: [...card.stacks],
      bottlenecks: [...card.bottlenecks],
      expectedEffect: card.expectedEffect,
      enabled: enabled.has(card.id),
    }));
  return redact({
    cards: listed,
    ...("error" in read ? { configError: read.error } : {}),
  });
}

export interface TechniqueDetail {
  card: {
    id: string;
    domain: string;
    title: string;
    kind: string;
    riskClass: string;
    stacks: StackId[];
    bottlenecks: Bottleneck[];
    signals: string[];
    preconditions: string[];
    steps: string[];
    verification: string[];
    traps: string[];
    expectedEffect?: string | undefined;
    sources: string[];
    /** Ids of the card's command templates; the commands are shown at approval. */
    commandTemplates: string[];
    pinnedToolVersions: Record<string, string>;
    verifiedIn: string | string[];
  };
  /** ufo.yaml enables it; only enabled cards can be submitted. */
  enabled: boolean;
}

/** `get_technique`: one card in full. `usage` for an id no card has. */
export async function getTechnique(
  context: AppContext,
  options: { readonly cardId: string },
): Promise<TechniqueDetail> {
  const repo = await repoOf(context);
  const read = await readConfig(repo, context);
  const cards = "error" in read ? await loadCards(repo.root, context) : read.cards;
  const found = cards.get(options.cardId);
  if (found === undefined) {
    throw new AppError(
      "usage",
      `no technique card has id ${options.cardId}; list_techniques lists them`,
    );
  }
  const { card } = found;
  return redact({
    card: {
      id: card.id,
      domain: card.domain,
      title: card.title,
      kind: card.kind,
      riskClass: card.riskClass,
      stacks: [...card.stacks],
      bottlenecks: [...card.bottlenecks],
      signals: [...card.signals],
      preconditions: [...card.preconditions],
      steps: [...card.steps],
      verification: [...card.verification],
      traps: [...card.traps],
      expectedEffect: card.expectedEffect,
      sources: [...card.sources],
      commandTemplates: card.commandTemplates.map((template) => template.id),
      pinnedToolVersions: { ...card.pinnedToolVersions },
      verifiedIn: Array.isArray(card.verifiedIn) ? [...card.verifiedIn] : card.verifiedIn,
    },
    enabled: !("error" in read) && read.loaded.config.cards.includes(card.id),
  });
}
