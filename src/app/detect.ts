// Which stacks a repository uses, read from its files alone. Nothing here runs a command, follows
// a symbolic link, or reads outside the repository root; every read is capped.

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readTextNoFollow } from "../core/jobs/index.js";
import { type StackId, StackIdSchema } from "../domain/index.js";

/** A manifest is a few kilobytes; a larger file is skipped, not read in part. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 16;
const MAX_EVIDENCE = 8;

/** What UFO can suggest for a detected stack. Fixed text, never copied from the repository. */
export interface StackSuggestions {
  /** The command that runs the stack's tests; the basis of a `test_pass_set` oracle. */
  testCommand?: string;
  /** One line on what to measure for this stack. */
  workloadHint?: string;
}

export interface DetectedStack {
  id: StackId;
  /** The files and names that matched, e.g. `package.json: dependency next`. */
  evidence: string[];
  suggestions: StackSuggestions;
}

const LOCKFILES = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" } as const;

const WORKLOAD_HINTS: Partial<Record<StackId, string>> = {
  "spring-boot": "startup: process start until the first 200 on a health endpoint",
  gradle: "build: wall time of a clean build, e.g. `./gradlew clean assemble`",
  maven: "build: wall time of a clean package, e.g. `mvn -q clean package -DskipTests`",
  nextjs: "bundle: initial JavaScript bytes of a production build, or the build's wall time",
  vite: "bundle: initial JavaScript bytes of a production build, or the build's wall time",
  webpack: "bundle: initial JavaScript bytes of a production build, or the build's wall time",
  node: "latency: p95 of one request path against the started server, or the start-to-ready time",
  django: "latency: p95 of one request path against the started server",
  fastapi: "latency: p95 of one request path against the started server",
  flask: "latency: p95 of one request path against the started server",
  go: "latency or throughput: one benchmark (go test -bench) or one request path",
  rust: "cpu: one benchmark or one representative command, built with --release",
  docker: "build: wall time of the image build, or container start until ready",
  "llama-cpp": "inference: tokens per second of one fixed prompt against llama-server",
  vllm: "inference: tokens per second of one fixed prompt set against the server",
  pytorch: "cpu or inference: seconds for a fixed number of training or inference steps",
  "openai-client": "latency or cost: one fixed request set, with the token counts it sends",
};

class Findings {
  readonly found = new Map<StackId, DetectedStack>();

  add(id: StackId, evidence: string, suggestions: StackSuggestions = {}): void {
    const entry = this.found.get(id) ?? { id, evidence: [], suggestions: {} };
    if (entry.evidence.length < MAX_EVIDENCE && !entry.evidence.includes(evidence)) {
      entry.evidence.push(evidence);
    }
    Object.assign(entry.suggestions, suggestions);
    this.found.set(id, entry);
  }
}

async function readText(root: string, relative: string): Promise<string | undefined> {
  const file = path.join(root, relative);
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  return readTextNoFollow(file).catch(() => undefined);
}

async function isFile(root: string, relative: string): Promise<boolean> {
  return (await lstat(path.join(root, relative)).catch(() => undefined))?.isFile() ?? false;
}

async function listFiles(dir: string, accept: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && accept.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_LISTED_FILES);
}

/** Whether `name` appears in `text` as a whole dependency name (`torch`, not `torchvision`). */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "i").test(text);
}

function detectNode(found: Findings, manifest: unknown, lockfiles: readonly string[]): void {
  const pkg = (typeof manifest === "object" && manifest !== null ? manifest : {}) as Record<
    string,
    unknown
  >;
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (typeof deps === "object" && deps !== null)
      for (const name of Object.keys(deps)) names.add(name);
  }
  const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const manager = (["pnpm", "yarn", "npm"] as const).find((name) => {
    return packageManager.startsWith(`${name}@`) || lockfiles.includes(LOCKFILES[name]);
  });
  const scripts = (
    typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {}
  ) as Record<string, unknown>;
  const test = scripts.test;
  // `npm init` writes a test script that only fails.
  const hasTest = typeof test === "string" && !/no test specified/.test(test);
  found.add("node", "package.json", hasTest ? { testCommand: `${manager ?? "npm"} test` } : {});
  if (manager !== undefined) {
    found.add(
      manager,
      packageManager.startsWith(`${manager}@`)
        ? "package.json: packageManager"
        : `${LOCKFILES[manager]}`,
    );
  }
  const byDependency: [string, StackId][] = [
    ["typescript", "typescript"],
    ["next", "nextjs"],
    ["vite", "vite"],
    ["webpack", "webpack"],
    ["openai", "openai-client"],
    ["pg", "postgres"],
    ["postgres", "postgres"],
    ["pg-promise", "postgres"],
    ["mysql", "mysql"],
    ["mysql2", "mysql"],
  ];
  for (const [name, id] of byDependency) {
    if (names.has(name)) found.add(id, `package.json: dependency ${name}`);
  }
}

async function detectNodeFiles(found: Findings, root: string): Promise<string> {
  const text = await readText(root, "package.json");
  if (text === undefined) return "";
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    // A package.json that does not parse still says this is a Node project.
    manifest = {};
  }
  const lockfiles: string[] = [];
  for (const lockfile of Object.values(LOCKFILES)) {
    if (await isFile(root, lockfile)) lockfiles.push(lockfile);
  }
  detectNode(found, manifest, lockfiles);
  const scripts = (manifest as { scripts?: unknown }).scripts;
  return typeof scripts === "object" && scripts !== null ? JSON.stringify(scripts) : "";
}

async function detectJvm(found: Findings, root: string): Promise<void> {
  const pom = await readText(root, "pom.xml");
  const gradleFiles = [
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
  ];
  const gradleTexts: [string, string][] = [];
  for (const name of [...gradleFiles, "gradle/libs.versions.toml"]) {
    const text = await readText(root, name);
    if (text !== undefined) gradleTexts.push([name, text]);
  }
  const sources: [string, string][] = [];
  if (pom !== undefined) {
    const wrapper = await isFile(root, "mvnw");
    found.add("jvm", "pom.xml");
    found.add("maven", "pom.xml", { testCommand: wrapper ? "./mvnw -q test" : "mvn -q test" });
    sources.push(["pom.xml", pom]);
  }
  if (gradleTexts.some(([name]) => gradleFiles.includes(name))) {
    const wrapper = await isFile(root, "gradlew");
    const [first] = gradleTexts.filter(([name]) => gradleFiles.includes(name));
    found.add("jvm", first?.[0] ?? "build.gradle");
    found.add("gradle", first?.[0] ?? "build.gradle", {
      testCommand: wrapper ? "./gradlew test" : "gradle test",
    });
    for (const [name, text] of gradleTexts) sources.push([name, text]);
  }
  for (const [file, text] of sources) {
    if (/org\.springframework\.boot|spring-boot-starter|spring-boot-gradle-plugin/.test(text)) {
      found.add("spring-boot", `${file}: spring-boot plugin or starter`);
    }
    if (/hibernate|spring-boot-starter-data-jpa/.test(text)) {
      found.add("hibernate", `${file}: hibernate or JPA starter`);
    }
    if (/postgresql/.test(text)) found.add("postgres", `${file}: postgresql driver`);
    if (/mysql-connector|com\.mysql|mariadb-java-client/.test(text)) {
      found.add("mysql", `${file}: mysql driver`);
    }
  }
}

async function detectPython(found: Findings, root: string): Promise<string> {
  const requirements = await listFiles(root, /^requirements[\w.-]*\.txt$/);
  const files = ["pyproject.toml", ...requirements, "setup.cfg", "setup.py"];
  let all = "";
  let present = false;
  let pytest = false;
  for (const name of files) {
    const text = await readText(root, name);
    if (text === undefined) continue;
    present = true;
    all += `\n${text}`;
    found.add("python", name);
    const dependencies: [string, StackId][] = [
      ["django", "django"],
      ["fastapi", "fastapi"],
      ["flask", "flask"],
      ["sqlalchemy", "sqlalchemy"],
      ["torch", "pytorch"],
      ["openai", "openai-client"],
      ["vllm", "vllm"],
      ["llama-cpp-python", "llama-cpp"],
      ["psycopg", "postgres"],
      ["psycopg2", "postgres"],
      ["psycopg2-binary", "postgres"],
      ["asyncpg", "postgres"],
      ["mysqlclient", "mysql"],
      ["pymysql", "mysql"],
    ];
    for (const [dependency, id] of dependencies) {
      if (mentions(text, dependency)) found.add(id, `${name}: ${dependency}`);
    }
    if (name === "pyproject.toml" && /\[tool\.pytest/.test(text)) pytest = true;
    if (name === "setup.cfg" && /\[tool:pytest\]/.test(text)) pytest = true;
    if (name.startsWith("requirements") && mentions(text, "pytest")) pytest = true;
  }
  if (!present) return "";
  if (!pytest) pytest = await isFile(root, "pytest.ini");
  if (pytest) found.add("python", "pytest configured", { testCommand: "pytest" });
  return all;
}

async function detectOthers(found: Findings, root: string, scripts: string): Promise<void> {
  if (await isFile(root, "go.mod")) {
    found.add("go", "go.mod", { testCommand: "go test ./..." });
    const text = (await readText(root, "go.mod")) ?? "";
    if (/github\.com\/(?:lib\/pq|jackc\/pgx)/.test(text))
      found.add("postgres", "go.mod: pq or pgx");
    if (/github\.com\/go-sql-driver\/mysql/.test(text)) found.add("mysql", "go.mod: mysql driver");
  }
  if (await isFile(root, "Cargo.toml")) {
    found.add("rust", "Cargo.toml");
    found.add("cargo", "Cargo.toml", { testCommand: "cargo test" });
  }
  const dockerfile = await readText(root, "Dockerfile");
  if (dockerfile !== undefined || (await isFile(root, "Dockerfile")))
    found.add("docker", "Dockerfile");
  let composeText = "";
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await readText(root, name);
    if (text === undefined) continue;
    composeText += `\n${text}`;
    found.add("docker", name);
    if (/^\s*image:\s*["']?(?:[\w./-]*\/)?postgres(?::|\s|["']|$)/m.test(text)) {
      found.add("postgres", `${name}: postgres image`);
    }
    if (/^\s*image:\s*["']?(?:[\w./-]*\/)?(?:mysql|mariadb)(?::|\s|["']|$)/m.test(text)) {
      found.add("mysql", `${name}: mysql image`);
    }
  }
  // llama.cpp and vLLM are started from scripts and images, not imported.
  const places: [string, string][] = [["package.json scripts", scripts]];
  for (const [name, text] of [
    ["Dockerfile", dockerfile ?? ""],
    ["compose file", composeText],
  ] as const) {
    places.push([name, text]);
  }
  places.push(["Makefile", (await readText(root, "Makefile")) ?? ""]);
  for (const name of await listFiles(path.join(root, "scripts"), /\.(?:sh|bash)$/)) {
    places.push([`scripts/${name}`, (await readText(root, `scripts/${name}`)) ?? ""]);
  }
  for (const [place, text] of places) {
    if (
      /\bllama-(?:server|cli)\b|ggml-org\/llama\.cpp|ghcr\.io\/ggerganov\/llama\.cpp/.test(text)
    ) {
      found.add("llama-cpp", `${place}: llama.cpp server or image`);
    }
    if (/\bvllm\s+serve\b|vllm\.entrypoints|vllm\/vllm-openai/.test(text)) {
      found.add("vllm", `${place}: vllm server`);
    }
  }
}

/**
 * The stacks the repository at `repoRoot` uses, with the evidence and UFO's suggestions for each,
 * in `StackIdSchema` order. Reads root manifests only; runs nothing.
 */
export async function detectStacks(repoRoot: string): Promise<DetectedStack[]> {
  const found = new Findings();
  const scripts = await detectNodeFiles(found, repoRoot);
  await detectJvm(found, repoRoot);
  await detectPython(found, repoRoot);
  await detectOthers(found, repoRoot, scripts);
  return StackIdSchema.options.flatMap((id) => {
    const entry = found.found.get(id);
    if (entry === undefined) return [];
    const hint = WORKLOAD_HINTS[id];
    if (hint !== undefined) entry.suggestions.workloadHint = hint;
    return [entry];
  });
}
