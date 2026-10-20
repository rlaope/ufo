import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { integrityOf } from "../../../src/setup/files.js";
import type {
  CommandResult,
  CommandRunner,
  Fetcher,
  SetupEnvironment,
} from "../../../src/setup/index.js";
import { readTarball } from "../../../src/setup/package.js";

// A home directory, UFO home, PATH, and application folder under one temp directory, with fake
// `claude` and `npm` programs on that PATH (the runner below answers for them), and a fake npm
// registry. Nothing touches the real home or runs a real host.

export const NODE = "/usr/local/bin/node";
export const VERSION = "1.2.3";
export const SKILL_TEXT = "---\nname: ufo-optimize\ndescription: test skill\n---\n\nBody.\n";

export interface Call {
  /** The absolute path setup ran. */
  readonly file: string;
  readonly program: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A package the fake registry and npm know: its version, tarball bytes, and skill files. */
export interface FakePackage {
  readonly version: string;
  readonly tarball: Buffer;
  readonly integrity: string;
}

/** A gzipped ustar archive of `files` under `package/`, as `npm pack` writes one. */
export function tarball(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function fakePackage(
  version: string,
  skill = SKILL_TEXT,
  cli = "// the CLI\n",
): FakePackage {
  const bytes = tarball({
    "package.json": JSON.stringify({ name: "ufo-agents", version }),
    "dist/cli/index.js": cli,
    "skills/ufo-optimize/SKILL.md": skill,
  });
  return { version, tarball: bytes, integrity: integrityOf(bytes) };
}

export interface Fakes {
  /** Every call of a program, by its base name. */
  readonly calls: Call[];
  /** Versions the registry has. */
  readonly registry: Map<string, FakePackage>;
  /** When it returns a result, `claude` answers with that instead of doing the call. */
  claudeFail?: (args: readonly string[]) => CommandResult | undefined;
  /** npm installs this package whatever it is asked for (a tampered registry). */
  npmServes?: FakePackage;
  /** Fields `claude mcp add` stores besides the ones it was given. */
  claudeAdds?: Record<string, unknown>;
}

const ok = (stdout = "ok\n"): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

async function fakeClaude(configFile: string, fakes: Fakes, args: string[]) {
  if (args[0] === "--version") return ok("2.1.304 (Claude Code)\n");
  const failure = fakes.claudeFail?.(args);
  if (failure !== undefined) return failure;
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configFile, "utf8"));
  } catch {
    // No config yet.
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const [mcp, action] = args;
  if (mcp !== "mcp") return fail("unknown command");
  if (action === "add") {
    const dash = args.indexOf("--");
    const name = args[dash - 1] ?? "";
    const [command, ...rest] = args.slice(dash + 1);
    if (args[2] !== "--scope" || args[3] !== "user") return fail("expected --scope user");
    if (Object.hasOwn(servers, name)) return fail(`MCP server ${name} already exists`);
    servers[name] = { type: "stdio", command, args: rest, env: {}, ...fakes.claudeAdds };
  } else if (action === "remove") {
    const name = args[2] ?? "";
    if (args[3] !== "--scope" || args[4] !== "user") return fail("expected --scope user");
    if (!Object.hasOwn(servers, name)) return fail(`No user-scoped MCP server named ${name}`);
    delete servers[name];
  } else {
    return fail(`unknown action ${action}`);
  }
  config.mcpServers = servers;
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return ok();
}

const NPM_FLAGS = [
  "--ignore-scripts",
  "--omit=dev",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org/",
];

/** Unpacks the package into `<prefix>/node_modules/ufo-agents` and writes a lockfile. */
async function fakeNpm(fakes: Fakes, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const [install, flag, prefix, ...rest] = args;
  if (install !== "install" || flag !== "--prefix" || prefix !== cwd) return fail("bad call");
  if (!NPM_FLAGS.every((f) => rest.includes(f))) return fail("missing a flag");
  if (Object.keys(env).some((name) => /^npm_config_/i.test(name))) return fail("npm_config_ set");
  const spec = rest.at(-1) ?? "";
  let pkg: FakePackage | undefined;
  if (spec.startsWith("ufo-agents@")) {
    pkg = fakes.registry.get(spec.slice("ufo-agents@".length));
  } else if (path.isAbsolute(spec)) {
    const bytes = await readFile(spec);
    pkg = { version: "", tarball: bytes, integrity: integrityOf(bytes) };
  }
  pkg = fakes.npmServes ?? pkg;
  if (pkg === undefined) return fail(`404 ${spec}`);
  for (const [name, content] of readTarball(pkg.tarball)) {
    const file = path.join(prefix, "node_modules", "ufo-agents", name.replace(/^package\//, ""));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const lock = { packages: { "node_modules/ufo-agents": { integrity: pkg.integrity } } };
  await writeFile(path.join(prefix, "package-lock.json"), JSON.stringify(lock));
  return ok();
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly ufoHome: string;
  readonly fakes: Fakes;
  readonly environment: SetupEnvironment;
  /** The installed CLI `version`'s entries start. */
  script(version?: string): string;
  /** `claude mcp ...` calls, as their arguments. */
  claudeCalls(): string[][];
  cleanup(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ufo-setup-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const work = path.join(root, "work");
  const applications = path.join(root, "Applications");
  const skillSource = path.join(root, "skill-source");
  for (const dir of [home, bin, work, applications, skillSource]) {
    await mkdir(dir, { mode: 0o700 });
  }
  await writeFile(path.join(skillSource, "SKILL.md"), SKILL_TEXT);
  for (const name of ["claude", "npm"]) await onPathIn(bin, name);
  const ufoHome = path.join(root, "ufo-home");
  const fakes: Fakes = {
    calls: [],
    registry: new Map([[VERSION, fakePackage(VERSION)]]),
  };
  const claudeJson = path.join(home, ".claude.json");
  const run: CommandRunner = async (file, args, options) => {
    fakes.calls.push({ file, program: path.basename(file), args: [...args], ...options });
    if (path.basename(file) === "claude") return fakeClaude(claudeJson, fakes, [...args]);
    if (path.basename(file) === "npm") return fakeNpm(fakes, [...args], options.cwd, options.env);
    return { code: 127, stdout: "", stderr: `${file}: not found` };
  };
  const fetcher: Fetcher = async (url) => {
    const version = url.slice("https://registry.npmjs.org/ufo-agents/".length);
    const pkg = fakes.registry.get(version);
    return {
      status: pkg === undefined ? 404 : 200,
      json: async () => ({ name: "ufo-agents", version, dist: { integrity: pkg?.integrity } }),
    };
  };
  return {
    root,
    home,
    bin,
    ufoHome,
    fakes,
    environment: {
      home,
      ufoHome,
      cwd: work,
      env: { PATH: bin, npm_config_registry: "https://evil.example/" },
      run,
      fetch: fetcher,
      applications,
      version: VERSION,
      skillSource,
      execPath: NODE,
    },
    script: (version = VERSION) =>
      path.join(ufoHome, "pkg", version, "node_modules", "ufo-agents", "dist", "cli", "index.js"),
    claudeCalls: () =>
      fakes.calls.filter((c) => c.program === "claude" && c.args[0] === "mcp").map((c) => c.args),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function onPathIn(bin: string, name: string): Promise<void> {
  const file = path.join(bin, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}

/** Puts an executable `name` on the sandbox PATH. */
export async function onPath(box: Sandbox, name: string): Promise<void> {
  await onPathIn(box.bin, name);
}

/** Writes `text` to `file` under the sandbox, creating its directory. */
export async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
