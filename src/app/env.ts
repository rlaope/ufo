import path from "node:path";

/**
 * Environment variables every workload, oracle, and hook command sees, besides `ufo.yaml`'s
 * `env:` list and UFO's own `UFO_*` variables. Everything else in the launcher's environment
 * (API keys, cloud credentials, agent sockets) stays out of the run.
 */
export const DEFAULT_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "USER",
  "SHELL",
  "TERM",
];
/** Every `LC_*` locale variable is passed too. */
export const DEFAULT_ENV_PREFIX = "LC_";

/**
 * Variables that tell git which configuration the user trusts. The worker's own git calls read
 * them, so its git behaves like the launcher's; commands never see them unless listed in `env:`.
 */
export const GIT_CONFIG_ENV_NAMES: readonly string[] = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "XDG_CONFIG_HOME",
];

/** How the approval review and docs name the default allowlist. */
export function describeDefaultEnv(): string {
  return [...DEFAULT_ENV_NAMES, `${DEFAULT_ENV_PREFIX}*`].join(", ");
}

function pick(source: NodeJS.ProcessEnv, keep: (name: string) => boolean): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && keep(name)) picked[name] = value;
  }
  return picked;
}

function inside(dir: string, roots: readonly string[]): boolean {
  return roots.some((root) => dir === root || dir.startsWith(`${root}${path.sep}`));
}

/**
 * `PATH` without the entries a patch or a file edit could plant a program in, ahead of the real
 * one an approved command names (security N4): relative entries, and entries inside the
 * repository, its git directory, or UFO's home. Exported for the tests.
 */
export function safePath(value: string, untrusted: readonly string[]): string {
  const roots = untrusted.map((root) => path.resolve(root));
  return value
    .split(path.delimiter)
    .filter((entry) => entry !== "" && path.isAbsolute(entry))
    .filter((entry) => !inside(path.resolve(entry), roots))
    .join(path.delimiter);
}

/**
 * The command environment of a run, captured once at `startRun` from the launcher's
 * environment: the default names, every `LC_*`, and the names `ufo.yaml` lists in `env:`.
 * `PATH` keeps only absolute entries outside `untrusted` (the repository, its git directory,
 * and UFO's home).
 */
export function captureEnv(
  source: NodeJS.ProcessEnv,
  listed: readonly string[],
  untrusted: readonly string[] = [],
): Record<string, string> {
  const names = new Set([...DEFAULT_ENV_NAMES, ...listed]);
  const env = pick(source, (name) => names.has(name) || name.startsWith(DEFAULT_ENV_PREFIX));
  if (env.PATH !== undefined) env.PATH = safePath(env.PATH, untrusted);
  return env;
}

const SECRET_LIKE =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)|^AWS_|^SSH_AUTH_SOCK$|^GH_|^GITHUB_|^NPM_/i;

/** `env:` names that look like secrets: patched code can read every listed variable. */
export function secretLikeNames(names: readonly string[]): string[] {
  return names.filter((name) => SECRET_LIKE.test(name));
}

/** The git configuration variables of the launcher's environment, for the worker's own git. */
export function captureGitEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  return pick(source, (name) => GIT_CONFIG_ENV_NAMES.includes(name));
}
