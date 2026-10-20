import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { SetupError } from "./errors.js";
import { exists, integrityOf, isErrno } from "./files.js";
import {
  type CommandRunner,
  findExecutable,
  howItEnded,
  type Launch,
  SKILL_NAME,
} from "./hosts.js";
import { hashFiles, readSkillSource, sameFiles } from "./skills.js";

// The package a host starts (security H1): never `npx`, which resolves a name at every start.
// Setup installs one exact version into `$UFO_HOME/pkg/<version>` with npm (no install scripts,
// the public registry, no npm_config_* from the environment), checks the installed version and
// the lockfile's integrity against the registry's, and points each host at that copy's CLI with
// an absolute node. `--package <file.tgz>` installs a local tarball instead. Dependencies are
// checked only for where they came from (every `resolved` URL on the public registry); their
// integrity is npm's own check against the registry, until the package ships an
// npm-shrinkwrap.json (plan M6).

export const PACKAGE_NAME = "ufo-agents";
export const REGISTRY = "https://registry.npmjs.org/";
const SKILL_PREFIX = `skills/${SKILL_NAME}/`;
/** Far above the package's size; a larger file is not the package. */
const MAX_TARBALL_BYTES = 64 << 20;
const MAX_UNPACKED_BYTES = 256 << 20;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_VERSION = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${IDENTIFIER}(?:\.${IDENTIFIER})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

export function isExactVersion(version: string): boolean {
  return EXACT_VERSION.test(version);
}

/** Semver precedence of two exact versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const match = EXACT_VERSION.exec(version);
    if (match === null) throw new Error(`not an exact version: ${version}`);
    return { core: [match[1], match[2], match[3]].map(Number), pre: match[4]?.split(".") ?? [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/;
    if (numeric.test(p) && numeric.test(q)) return Number(p) - Number(q);
    if (numeric.test(p) !== numeric.test(q)) return numeric.test(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** What setup installs. */
export interface PackageSource {
  readonly kind: "registry" | "tarball";
  readonly version: string;
  /** sha512 in npm's form: the registry's `dist.integrity`, or the tarball's own digest. */
  readonly integrity: string;
  /** `--package`: the tarball's absolute path. */
  readonly tarball?: string;
  /** The skill's files as this version ships them, by relative POSIX path. */
  readonly skill: ReadonlyMap<string, Buffer>;
}

/** Fetches registry metadata; the global `fetch` in production. */
export type Fetcher = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export const httpFetcher: Fetcher = (url) =>
  fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });

const PUBLISH_HINT = "install from a tarball with --package <file.tgz>";

/**
 * The registry's `ufo-agents@<version>`, the version this UFO is (security H2): refused for
 * `0.0.0` (an unreleased checkout), a version that is not exact, and one the registry does not
 * have. `skillDir` is this UFO's own skill, the same files as that version's. `installed` is the
 * integrity a copy already installed from the registry holds, as the record and its lockfile
 * agree: then the registry is not asked again, so a second setup works offline.
 */
export async function registrySource(
  version: string,
  fetcher: Fetcher,
  skillDir: string,
  installed?: string,
): Promise<PackageSource> {
  if (!isExactVersion(version) || version === "0.0.0") {
    throw new SetupError(
      "package_unavailable",
      `${PACKAGE_NAME}@${version} is not a released version; ${PUBLISH_HINT}`,
    );
  }
  const skill = await readSkillSource(skillDir);
  if (installed !== undefined) return { kind: "registry", version, integrity: installed, skill };
  const url = `${REGISTRY}${PACKAGE_NAME}/${version}`;
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new SetupError(
      "install_failed",
      `could not reach ${REGISTRY}: ${(error as Error).message}`,
    );
  }
  if (response.status === 404) {
    throw new SetupError(
      "package_unavailable",
      `the npm registry has no ${PACKAGE_NAME}@${version} (the name is not published yet); ${PUBLISH_HINT}`,
    );
  }
  if (response.status !== 200) {
    throw new SetupError("install_failed", `${url} answered HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    name?: unknown;
    version?: unknown;
    dist?: { integrity?: unknown };
  };
  const integrity = body.dist?.integrity;
  if (
    body.name !== PACKAGE_NAME ||
    body.version !== version ||
    typeof integrity !== "string" ||
    !integrity.startsWith("sha512-")
  ) {
    throw new SetupError(
      "integrity_mismatch",
      `${url} does not describe ${PACKAGE_NAME}@${version} with a sha512 integrity`,
    );
  }
  return { kind: "registry", version, integrity, skill };
}

/** The regular files of a gzipped tar archive, by name (ustar, pax, and GNU long names). */
export function readTarball(bytes: Uint8Array): Map<string, Buffer> {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files = new Map<string, Buffer>();
  let next: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("bad tar header");
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = next ?? (prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`);
    offset += 512;
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    next = undefined;
    if (type === "L") {
      next = body.toString("utf8").replace(/\0[\s\S]*$/, "");
    } else if (type === "x") {
      next = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
    } else if (type === "0" || type === "") {
      files.set(name, Buffer.from(body));
    }
  }
  return files;
}

/** A local `ufo-agents` tarball (`npm pack`), read without running anything in it. */
export async function tarballSource(file: string): Promise<PackageSource> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new SetupError("usage", `--package: no file ${file}`);
    throw error;
  }
  const notPackage = (why: string) =>
    new SetupError("usage", `--package: ${file} is not a ${PACKAGE_NAME} tarball (${why})`);
  if (bytes.length > MAX_TARBALL_BYTES) throw notPackage("too large");
  let entries: Map<string, Buffer>;
  try {
    entries = readTarball(bytes);
  } catch {
    throw notPackage("not a gzipped tar archive");
  }
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(entries.get("package/package.json")?.toString("utf8") ?? "");
  } catch {
    throw notPackage("no package/package.json");
  }
  const { version } = manifest;
  if (manifest.name !== PACKAGE_NAME || typeof version !== "string" || !isExactVersion(version)) {
    throw notPackage("its package.json names another package or no exact version");
  }
  const skill = new Map<string, Buffer>();
  for (const [name, content] of entries) {
    const relative = name.startsWith(`package/${SKILL_PREFIX}`)
      ? name.slice(`package/${SKILL_PREFIX}`.length)
      : undefined;
    if (relative !== undefined && relative !== "" && !relative.split("/").includes("..")) {
      skill.set(relative, content);
    }
  }
  if (!skill.has("SKILL.md")) throw notPackage(`no ${SKILL_PREFIX}SKILL.md`);
  return { kind: "tarball", version, integrity: integrityOf(bytes), tarball: file, skill };
}

/** `$UFO_HOME/pkg/<version>`: one installed copy. */
export function prefixFor(pkgRoot: string, version: string): string {
  if (!isExactVersion(version)) throw new Error(`not an exact version: ${version}`);
  return path.join(pkgRoot, version);
}

const packageDir = (prefix: string) => path.join(prefix, "node_modules", PACKAGE_NAME);

export function launchFor(prefix: string, node: string): Launch {
  return { node, script: path.join(packageDir(prefix), "dist", "cli", "index.js") };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The integrity of the copy installed at `prefix`, as its lockfile records it, when its
 * package.json is `ufo-agents@<version>` and its CLI exists; otherwise `undefined`.
 */
export async function installedIntegrity(
  prefix: string,
  version: string,
): Promise<string | undefined> {
  const manifest = (await readJson(path.join(packageDir(prefix), "package.json"))) as
    | { name?: unknown; version?: unknown }
    | undefined;
  if (manifest?.name !== PACKAGE_NAME || manifest.version !== version) return undefined;
  if (!(await exists(path.join(packageDir(prefix), "dist", "cli", "index.js")))) return undefined;
  const lock = (await readJson(path.join(prefix, "package-lock.json"))) as
    | { packages?: Record<string, { integrity?: unknown }> }
    | undefined;
  const integrity = lock?.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity;
  return typeof integrity === "string" ? integrity : undefined;
}

/** The installed copy's skill files, which must be the ones the plan showed. */
export async function installedSkill(
  prefix: string,
  expected: ReadonlyMap<string, Buffer>,
): Promise<Map<string, Buffer>> {
  const files = await readSkillSource(path.join(packageDir(prefix), SKILL_PREFIX));
  if (!sameFiles(hashFiles(files), hashFiles(expected))) {
    throw new SetupError(
      "integrity_mismatch",
      `the ${SKILL_NAME} skill installed in ${prefix} is not the one shown in the plan`,
    );
  }
  return files;
}

/** The environment npm runs with: every `npm_config_*` variable removed. */
function npmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^npm_config_/i.test(name)));
}

export interface InstallOptions {
  readonly pkgRoot: string;
  /** `npm` as an absolute path on the filtered PATH. */
  readonly npm: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly run: CommandRunner;
}

/**
 * The `npm install` command line setup runs. Flags beat a user's `.npmrc`, so the lockfile
 * setup checks is written whatever `package-lock`, `save`, `dry-run`, or `global` says there.
 */
export function npmArgs(prefix: string, source: PackageSource): string[] {
  return [
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=true",
    "--save=true",
    "--dry-run=false",
    "--global=false",
    `--registry=${REGISTRY}`,
    source.tarball ?? `${PACKAGE_NAME}@${source.version}`,
  ];
}

/**
 * Every package in the lockfile is the registry's own tarball of its name and version (security
 * DS-N2, F1): `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`, so neither a
 * scoped registry in an `.npmrc` nor a URL to another package's tarball can swap a dependency.
 * The package itself may be the `--package` tarball.
 */
async function checkResolved(prefix: string, source: PackageSource): Promise<void> {
  const lock = (await readJson(path.join(prefix, "package-lock.json"))) as
    | { packages?: Record<string, { resolved?: unknown; version?: unknown; link?: unknown }> }
    | undefined;
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key === "") continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const { resolved, version } = entry;
    const expected =
      typeof version === "string"
        ? `${REGISTRY}${name}/-/${path.posix.basename(name)}-${version}.tgz`
        : undefined;
    const own = key === `node_modules/${PACKAGE_NAME}` && source.tarball !== undefined;
    const fromRegistry = expected !== undefined && resolved === expected;
    const fromTarball = own && typeof resolved === "string" && resolved.startsWith("file:");
    if (entry.link === true || !(fromRegistry || fromTarball)) {
      throw new SetupError(
        "integrity_mismatch",
        `npm resolved ${name}@${typeof version === "string" ? version : "?"} from ${typeof resolved === "string" ? resolved : "nowhere"}, not ${expected ?? `${REGISTRY}${name}`} (a registry set in an .npmrc?); nothing was set up`,
      );
    }
  }
}

/**
 * Removes what an interrupted install left in `pkgRoot`: `.install-*` and `.old-*`. Both start
 * with a dot, so no installed version's directory (an exact version starts with a digit, and may
 * itself end in `.old-...` as a prerelease) is ever swept.
 */
export async function sweepPackages(pkgRoot: string): Promise<void> {
  for (const name of await readdir(pkgRoot)) {
    if (/^\.(?:install|old)-/.test(name)) {
      await rm(path.join(pkgRoot, name), { recursive: true, force: true });
    }
  }
}

/**
 * Installs `source` into a new directory under `pkgRoot`, checks it, and renames it to
 * `pkgRoot/<version>`, replacing what was there (put back if the rename fails). Refuses
 * (`integrity_mismatch`) a copy whose version, lockfile integrity, or dependency sources are not
 * what the source says.
 */
export async function installPackage(
  options: InstallOptions,
  source: PackageSource,
): Promise<void> {
  const { npm, pkgRoot } = options;
  if (npm === undefined) {
    throw new SetupError("install_failed", "npm is not on PATH (outside the project)");
  }
  const temp = await mkdtemp(path.join(pkgRoot, ".install-"));
  try {
    const args = npmArgs(temp, source);
    const result = await options.run(npm, args, {
      cwd: temp,
      env: npmEnv(options.env),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const last = result.stderr.trim().split("\n").at(-1) ?? "";
      throw new SetupError(
        "install_failed",
        `npm install ${args.at(-1)} ${howItEnded(result)}${last === "" ? "" : `: ${last}`}`,
      );
    }
    if (!(await exists(path.join(temp, "package-lock.json")))) {
      throw new SetupError(
        "install_failed",
        "npm wrote no package-lock.json, so UFO cannot check what it installed; nothing was set up",
      );
    }
    await checkResolved(temp, source);
    const integrity = await installedIntegrity(temp, source.version);
    if (integrity !== source.integrity) {
      throw new SetupError(
        "integrity_mismatch",
        `npm installed ${PACKAGE_NAME}@${source.version} with integrity ${integrity ?? "unknown"}, not ${source.integrity}; nothing was set up`,
      );
    }
    await installedSkill(temp, source.skill);
    const prefix = prefixFor(pkgRoot, source.version);
    if (await exists(prefix)) {
      const old = path.join(pkgRoot, `.old-${source.version}-${randomBytes(4).toString("hex")}`);
      await rename(prefix, old);
      try {
        await rename(temp, prefix);
      } catch (error) {
        await rename(old, prefix);
        throw error;
      }
      await rm(old, { recursive: true, force: true });
    } else {
      await rename(temp, prefix);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function removePackage(pkgRoot: string, version: string): Promise<void> {
  await rm(prefixFor(pkgRoot, version), { recursive: true, force: true });
}

/**
 * The node a host runs: the `node` on the filtered PATH when it is this process's own binary
 * (a stable path such as a package manager's link), else the real path of this binary. Either
 * way its real directory must pass `trusted` (security DS-N1: the PATH rules, so not a project's
 * own node or one under node_modules); otherwise setup refuses.
 */
export async function nodeCommand(
  env: NodeJS.ProcessEnv,
  execPath: string,
  trusted: (dir: string) => boolean,
): Promise<string> {
  const real = await realpath(execPath).catch(() => execPath);
  if (!trusted(path.dirname(real))) {
    throw new SetupError(
      "node_untrusted",
      `${execPath} is inside the project or a node_modules directory, and hosts would start it at every launch; run ufo setup with a node outside the project`,
    );
  }
  const found = await findExecutable("node", env);
  if (found !== undefined && (await realpath(found).catch(() => "")) === real) return found;
  return real;
}
