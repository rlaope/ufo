// `ufo doctor`: whether this machine has what the repository's runs need, and how to get each
// thing it lacks. Programs are looked up on the PATH the approved commands get, without running
// them; only git and a few programs found there (java, python, py-spy) are asked their version,
// each bounded by a timeout, in an empty directory of its own with only PATH, HOME, and LANG, so
// neither the repository's files (a version manager's .python-version, .tool-versions) nor the
// launcher's JAVA_TOOL_OPTIONS or PYTHON* settings reach them. No repository command and no
// shell line of ufo.yaml runs.

import { readFileSync } from "node:fs";
import { access, constants, lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redact } from "../core/evidence/index.js";
import { execBounded, readTextNoFollow } from "../core/jobs/index.js";
import { trustedHome, ufoHome } from "../core/paths.js";
import type { StackId, TechniqueCard, UfoConfig } from "../domain/index.js";
import { loadCards } from "./cards.js";
import { draftConfigFor, loadConfig, parseConfigText } from "./config.js";
import { type AppContext, type Repo, repoOf } from "./context.js";
import { type DetectedStack, detectStacks } from "./detect.js";
import { captureEnv } from "./env.js";
import { describeFailure } from "./errors.js";
import { checkProgram, INSTALL_HINTS, programOf } from "./inspect.js";
import { findJfr, NO_JFR } from "./profiler.js";
import { type ApprovedCommand, approvedCommands } from "./review.js";

/** `ufo doctor`'s exit code when it found a gap (docs/cli.md). */
export const EXIT_GAPS = 4;
/** A manifest is a few kilobytes; a larger package.json is not read. */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** How long a version probe runs before its process group is killed. */
export const DOCTOR_PROBE_TIMEOUT_MS = 5000;

export interface DoctorFound {
  /** A program, or `UFO_HOME`. */
  tool: string;
  /** Why it is needed: UFO itself, a detected stack, a ufo.yaml step, or `workload.profile`. */
  neededBy: string[];
  path?: string | undefined;
  version?: string | undefined;
}

export interface DoctorGap {
  /** A program, or what else is wrong: the repository, `UFO_HOME`, `ufo.yaml`, the cards. */
  tool: string;
  neededBy: string[];
  /** What is missing or wrong. */
  problem: string;
  /** How to get it, from the tool's own documentation. */
  hint: string;
}

export interface DoctorReport {
  /** The repository checked; absent when there is none. */
  repoRoot?: string | undefined;
  stacks: StackId[];
  /**
   * What the tools needed were read from: `ufo.yaml`, or the draft `ufo init` writes for
   * `stacks` while ufo.yaml is missing or invalid; `none` outside a repository.
   */
  source: "ufo.yaml" | "draft" | "none";
  found: DoctorFound[];
  gaps: DoctorGap[];
}

/** How to get what doctor checks besides the programs approved commands start. */
const HINTS: Readonly<Record<string, string>> = {
  git: "install git (https://git-scm.com/downloads); on macOS, xcode-select --install ships it",
  java: "install a JDK 11 or later, such as Eclipse Temurin (https://adoptium.net/installation/), and put its bin directory on PATH",
  jfr: "the jfr tool ships in a JDK's bin directory, not in a JRE (https://docs.oracle.com/en/java/javase/21/docs/specs/man/jfr.html): install a JDK and put its bin on PATH, or set JAVA_HOME to it and list JAVA_HOME in ufo.yaml env:",
  go: "install Go (https://go.dev/doc/install)",
  "py-spy":
    "install py-spy with pip install py-spy (https://github.com/benfred/py-spy#installation); on macOS it needs root",
  "async-profiler":
    "download async-profiler (https://github.com/async-profiler/async-profiler#download) and point -agentpath at its lib/libasyncProfiler.dylib (macOS) or .so (Linux)",
  "source-map-explorer":
    "add it as a devDependency: npm install --save-dev source-map-explorer (https://github.com/danvk/source-map-explorer#installation), and install dependencies in the workload's setup",
  "webpack-cli":
    "add it as a devDependency: npm install --save-dev webpack-cli (https://webpack.js.org/api/cli/), and install dependencies in the workload's setup",
  // Never an install suggestion: UFO does not set Docker up.
  docker: "a ufo.yaml command starts docker: put the docker CLI on PATH, or change the command",
};

/** The programs a detected stack's workload runs on; the first found of a list serves. */
const STACK_PROGRAMS: Partial<Record<StackId, readonly string[]>> = {
  node: ["node"],
  npm: ["npm"],
  pnpm: ["pnpm"],
  yarn: ["yarn"],
  jvm: ["java"],
  maven: ["mvn"],
  gradle: ["gradle"],
  go: ["go"],
  python: ["python3", "python"],
  cargo: ["cargo"],
};

/** The version argument of the programs doctor asks; the others are only looked up. */
const PROBES: Readonly<Record<string, readonly string[]>> = {
  git: ["--version"],
  java: ["-version"],
  python3: ["--version"],
  python: ["--version"],
  "py-spy": ["--version"],
};

interface Need {
  /** The program, or alternatives in order. */
  readonly programs: readonly string[];
  readonly neededBy: string;
}

function stackNeeds(stacks: readonly DetectedStack[]): Need[] {
  return stacks.flatMap((stack) => {
    const programs = STACK_PROGRAMS[stack.id];
    if (programs === undefined) return [];
    // `./mvnw` and `./gradlew` fetch the build tool themselves; they need only java.
    const wrapper = programOf(stack.suggestions.testCommand ?? "")?.startsWith("./") === true;
    if (wrapper && (stack.id === "maven" || stack.id === "gradle")) return [];
    return [{ programs, neededBy: `stack ${stack.id} (${stack.evidence[0] ?? "detected"})` }];
  });
}

/** The workload's own lines, which name a profiler a command starts itself. */
function workloadLines(config: UfoConfig): string {
  const { workload } = config;
  return [workload.setup, workload.start, workload.warmup, workload.command, workload.teardown]
    .filter((line) => line !== undefined)
    .join("\n");
}

function profileNeeds(config: UfoConfig): Need[] {
  const profile = config.workload.profile;
  const needs: Need[] = [];
  if (profile?.preset === "node-cpu") {
    needs.push({ programs: ["node"], neededBy: "workload.profile preset node-cpu" });
  }
  if (profile?.preset === "jvm-jfr") {
    needs.push({ programs: ["java"], neededBy: "workload.profile preset jvm-jfr" });
  }
  if (profile?.format === "pprof") {
    needs.push({ programs: ["go"], neededBy: "workload.profile format pprof" });
  }
  if (/(?<![\w-])py-spy(?![\w-])/.test(workloadLines(config))) {
    needs.push({ programs: ["py-spy"], neededBy: "a workload step starts py-spy" });
  }
  return needs;
}

/** The first line `text` holds, trimmed and cut to a readable length. */
function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.trim() !== "");
  return line?.trim().slice(0, 200);
}

function describe(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error)) ?? "failed";
}

/** `>=22` and the like, as package.json's `engines.node` holds it: whether `version` meets it. */
function meets(version: string, range: string): boolean | undefined {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (match === null) return undefined;
  const want = [match[1], match[2], match[3]].map((part) => Number(part ?? 0));
  const have = version.replace(/^v/, "").split(".").map(Number);
  for (const [index, part] of want.entries()) {
    const own = have[index] ?? 0;
    if (own !== part) return own > part;
  }
  return true;
}

/** UFO's own `engines.node`. Resolves to the package root from both src/ and dist/. */
function nodeRange(): string | undefined {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const engines = (pkg as { engines?: { node?: unknown } }).engines;
  return typeof engines?.node === "string" ? engines.node : undefined;
}

async function isFile(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => undefined))?.isFile() ?? false;
}

class Findings {
  readonly found: DoctorFound[] = [];
  readonly gaps: DoctorGap[] = [];

  ok(tool: string, neededBy: string, details: Omit<DoctorFound, "tool" | "neededBy"> = {}): void {
    this.found.push({ tool, neededBy: [neededBy], ...details });
  }

  gap(tool: string, neededBy: string | string[], problem: string, hint: string): void {
    this.gaps.push({ tool, neededBy: [neededBy].flat(), problem, hint });
  }
}

async function checkGit(prober: Prober, findings: Findings): Promise<void> {
  const why = "UFO (arms, run branches, diffs)";
  const answer = await probe("git", "git", prober);
  if ("problem" in answer) findings.gap("git", why, answer.problem, HINTS.git ?? "");
  else findings.ok("git", why, { version: answer.version.replace(/^git version /, "") });
}

function checkNode(findings: Findings): void {
  const range = nodeRange();
  const why = `UFO itself and its worker${range === undefined ? "" : ` (Node.js ${range})`}`;
  if (range === undefined || meets(process.version, range) !== false) {
    findings.ok("node", why, { version: process.version, path: process.execPath });
    return;
  }
  findings.gap(
    "node",
    why,
    `Node.js ${process.version} runs UFO; UFO needs ${range}`,
    `install Node.js ${range.replace(/^>=\s*/, "")} or later (https://nodejs.org/en/download)`,
  );
}

async function checkHome(home: string, repo: Repo | undefined, findings: Findings): Promise<void> {
  const why = "UFO's approvals and run state";
  try {
    const real = await trustedHome(home, {
      outside: repo === undefined ? [] : [repo.root, repo.gitDir, repo.commonDir],
    });
    await access(real, constants.W_OK);
    findings.ok("UFO_HOME", why, { path: real });
  } catch (error) {
    findings.gap(
      "UFO_HOME",
      why,
      describe(error),
      "point UFO_HOME at a directory you own outside the repository, with mode 700 (chmod 700 <dir>), or unset it for ~/.ufo",
    );
  }
}

/** ufo.yaml and the commands its approval covers, or the draft's config when there is none. */
async function readNeeds(
  repo: Repo,
  context: AppContext,
  stacks: readonly DetectedStack[],
  findings: Findings,
): Promise<{ config: UfoConfig; commands: ApprovedCommand[]; source: "ufo.yaml" | "draft" }> {
  let config: UfoConfig;
  try {
    config = (await loadConfig(repo.root)).config;
  } catch (error) {
    const failure = describeFailure(error);
    if (failure.code !== "config_missing") {
      findings.gap(
        "ufo.yaml",
        "ufo approve and every run",
        `${failure.code}: ${failure.message}`,
        'fix it (docs/cli.md, "ufo.yaml reference") and run ufo approve again; until then the tools below are those of the draft ufo init writes',
      );
    }
    return { config: parseConfigText(draftConfigFor(stacks)), commands: [], source: "draft" };
  }
  let cards: TechniqueCard[] = [];
  try {
    const loaded = await loadCards(repo.root, context, config);
    cards = config.cards.flatMap((id) => {
      const entry = loaded.get(id);
      return entry === undefined ? [] : [entry.card];
    });
  } catch (error) {
    const failure = describeFailure(error);
    findings.gap(
      "technique cards",
      "the cards ufo.yaml enables",
      `${failure.code}: ${failure.message}`,
      'fix the card files ufo.yaml\'s cardDirs names (docs/cli.md, "Technique cards and recipe edits"); their commands are not checked until then',
    );
  }
  return { config, commands: approvedCommands(config, cards), source: "ufo.yaml" };
}

/** Where and with what a version probe runs. */
interface Prober {
  /** An empty directory of doctor's own, outside the repository. */
  readonly cwd: string;
  /** `PATH`, `HOME`, and `LANG` only. */
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

/** The environment of a probe: `PATH` as given, and `HOME` and `LANG` of `env`, nothing else. */
function probeEnv(env: NodeJS.ProcessEnv, searchPath: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ PATH: searchPath, HOME: env.HOME, LANG: env.LANG }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/** Asks a program found on PATH its version; a probe that fails or hangs is a gap. */
async function probe(
  program: string,
  file: string,
  prober: Prober,
): Promise<{ version: string } | { problem: string }> {
  const args = PROBES[program];
  if (args === undefined) return { version: "" };
  const { timeoutMs } = prober;
  try {
    const { stdout, stderr } = await execBounded(file, args, timeoutMs, {
      cwd: prober.cwd,
      env: prober.env,
    });
    return { version: firstLine(stdout) ?? firstLine(stderr) ?? "" };
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: unknown };
    const asked = `${program} ${args.join(" ")}`;
    if (failed.code === "ENOENT") return { problem: `${file} is not on PATH` };
    if (failed.code === "ETIMEDOUT") {
      return { problem: `${file} did not answer ${asked} within ${timeoutMs / 1000} s` };
    }
    const said = typeof failed.stderr === "string" ? firstLine(failed.stderr) : undefined;
    return { problem: `${file} is on PATH, but ${asked} failed: ${said ?? describe(error)}` };
  }
}

async function checkPrograms(
  needs: readonly Need[],
  repo: Repo,
  searchPath: string,
  prober: Prober,
  findings: Findings,
): Promise<void> {
  const merged = new Map<string, { programs: readonly string[]; neededBy: string[] }>();
  for (const need of needs) {
    const key = need.programs.join(" or ");
    const entry = merged.get(key) ?? { programs: need.programs, neededBy: [] };
    if (!entry.neededBy.includes(need.neededBy)) entry.neededBy.push(need.neededBy);
    merged.set(key, entry);
  }
  for (const [key, { programs, neededBy }] of merged) {
    let check = await checkProgram(programs[0] ?? key, repo, searchPath);
    for (const program of programs.slice(1)) {
      if (check.found) break;
      const other = await checkProgram(program, repo, searchPath);
      if (other.found) check = other;
    }
    const { program } = check;
    if (check.where === "shell") continue;
    if (!check.found) {
      const problem =
        check.where === "outside_repository"
          ? `${program} is a path outside the repository`
          : check.where === "repository"
            ? `${program} is not in the repository`
            : `${key} is not on the PATH UFO's commands get`;
      const hint =
        HINTS[program] ??
        check.hint ??
        INSTALL_HINTS[program] ??
        `put ${program} on PATH outside the repository`;
      findings.gap(key, neededBy, problem, hint);
      continue;
    }
    const answer =
      check.path === undefined ? { version: "" } : await probe(program, check.path, prober);
    if ("problem" in answer) {
      findings.gap(
        program,
        neededBy,
        answer.problem,
        HINTS[program] ?? INSTALL_HINTS[program] ?? "",
      );
      continue;
    }
    findings.found.push({
      tool: program,
      neededBy,
      ...(check.path === undefined ? {} : { path: check.path }),
      ...(answer.version === "" ? {} : { version: answer.version }),
    });
  }
}

/** The dependency names package.json declares, read as stack detection reads it. */
async function declaredPackages(repo: Repo): Promise<Set<string>> {
  const file = path.join(repo.root, "package.json");
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_MANIFEST_BYTES) return new Set();
  const manifest: unknown = await readTextNoFollow(file)
    .then((text) => JSON.parse(text))
    .catch(() => undefined);
  const pkg = (typeof manifest === "object" && manifest !== null ? manifest : {}) as Record<
    string,
    unknown
  >;
  return new Set(
    ["dependencies", "devDependencies"].flatMap((field) => {
      const deps = pkg[field];
      return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
    }),
  );
}

/**
 * The bundle analyzers the workload's lines name, each an npm package that package.json must
 * declare: an arm is a clone, so it has only what the workload's setup installs from there.
 */
async function checkAnalyzers(config: UfoConfig, repo: Repo, findings: Findings): Promise<void> {
  if (config.workload.profile?.format !== "bundle-stats") return;
  const lines = workloadLines(config);
  const analyzers: [string, string][] = [];
  if (/(?<![\w-])source-map-explorer(?![\w-])/.test(lines)) {
    analyzers.push(["source-map-explorer", "source-map-explorer"]);
  }
  // `--json <file>` is webpack-cli's flag.
  if (/(?<![\w-])webpack(?![\w-])[^;&|\n]*--json/.test(lines)) {
    analyzers.push(["webpack-cli", "webpack --json"]);
  }
  if (analyzers.length === 0) return;
  const declared = await declaredPackages(repo);
  for (const [name, runs] of analyzers) {
    const why = `workload.profile format bundle-stats (a workload step runs ${runs})`;
    if (declared.has(name)) findings.ok(name, why);
    else {
      findings.gap(
        name,
        why,
        `${name} is not a dependency in package.json, so an arm does not install it`,
        HINTS[name] ?? "",
      );
    }
  }
}

/** The async-profiler libraries `-agentpath:` names in the profiled steps' environment. */
async function checkAgents(
  config: UfoConfig,
  env: Readonly<Record<string, string>>,
  findings: Findings,
): Promise<void> {
  const values = [
    ...Object.values(config.workload.profile?.env ?? {}),
    env.JAVA_TOOL_OPTIONS ?? "",
  ];
  const libraries = new Set(
    values.flatMap((value) =>
      [...value.matchAll(/-agentpath:([^=\s"']+)/g)]
        .map((match) => match[1] ?? "")
        .filter((library) => /asyncProfiler/i.test(library)),
    ),
  );
  for (const library of libraries) {
    const why = "workload.profile env (-agentpath)";
    if (path.isAbsolute(library) && (await isFile(library))) {
      findings.ok("async-profiler", why, { path: library });
    } else {
      findings.gap(
        "async-profiler",
        why,
        path.isAbsolute(library)
          ? `${library} does not exist`
          : `${library} is not an absolute path`,
        HINTS["async-profiler"] ?? "",
      );
    }
  }
}

/**
 * `ufo doctor`: git, the Node.js UFO needs, and a writable `UFO_HOME`; then, in the repository,
 * the programs its detected stacks, the commands ufo.yaml's approval covers (or, without a valid
 * ufo.yaml, the draft ufo init writes), and `workload.profile` need, looked up on the PATH those
 * commands get. Every gap names what is missing, why, and how to get it. Never throws for what
 * it finds: an unreadable ufo.yaml or a hung probe is a gap.
 */
export async function doctor(
  context: AppContext,
  options: { readonly env?: NodeJS.ProcessEnv; readonly probeTimeoutMs?: number } = {},
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const timeoutMs = options.probeTimeoutMs ?? DOCTOR_PROBE_TIMEOUT_MS;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ufo-doctor-"));
  try {
    return await diagnose(context, env, { cwd, env: probeEnv(env, env.PATH ?? ""), timeoutMs });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function diagnose(
  context: AppContext,
  env: NodeJS.ProcessEnv,
  prober: Prober,
): Promise<DoctorReport> {
  const findings = new Findings();
  await checkGit(prober, findings);
  checkNode(findings);
  const repo = await repoOf(context).catch((error: unknown) => {
    findings.gap(
      "repository",
      "every UFO command but setup",
      describeFailure(error).message,
      "run ufo doctor in the git repository to optimize, at its root or in any directory of it",
    );
    return undefined;
  });
  const home = context.home ?? ufoHome(env);
  await checkHome(home, repo, findings);
  if (repo === undefined) {
    return redact({ stacks: [], source: "none", found: findings.found, gaps: findings.gaps });
  }
  const stacks = await detectStacks(repo.root);
  const { config, commands, source } = await readNeeds(repo, context, stacks, findings);
  const captured = captureEnv(env, config.env, [repo.root, repo.gitDir, repo.commonDir, home]);
  const needs = [
    ...stackNeeds(stacks),
    ...commands.flatMap(({ what, command }) => {
      const program = programOf(command);
      return program === undefined ? [] : [{ programs: [program], neededBy: what }];
    }),
    ...profileNeeds(config),
  ];
  const searchPath = captured.PATH ?? "";
  await checkPrograms(
    needs,
    repo,
    searchPath,
    { ...prober, env: probeEnv(env, searchPath) },
    findings,
  );
  const profile = config.workload.profile;
  if (profile?.preset === "jvm-jfr" || profile?.format === "jfr") {
    const why = `workload.profile ${profile.preset === undefined ? "format jfr" : "preset jvm-jfr"} (UFO reads each recording with jfr print)`;
    const jfr = await findJfr(captured, [repo.root, repo.gitDir, repo.commonDir, home]);
    if (jfr === undefined) findings.gap("jfr", why, NO_JFR, HINTS.jfr ?? "");
    else findings.ok("jfr", why, { path: jfr });
  }
  await checkAnalyzers(config, repo, findings);
  await checkAgents(config, captured, findings);
  return redact({
    repoRoot: repo.root,
    stacks: stacks.map((stack) => stack.id),
    source,
    found: findings.found,
    gaps: findings.gaps,
  });
}
