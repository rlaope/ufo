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

/**
 * The command environment of a run, captured once at `startRun` from the launcher's
 * environment: the default names, every `LC_*`, and the names `ufo.yaml` lists in `env:`.
 */
export function captureEnv(
  source: NodeJS.ProcessEnv,
  listed: readonly string[],
): Record<string, string> {
  const names = new Set([...DEFAULT_ENV_NAMES, ...listed]);
  return pick(source, (name) => names.has(name) || name.startsWith(DEFAULT_ENV_PREFIX));
}

/** The git configuration variables of the launcher's environment, for the worker's own git. */
export function captureGitEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  return pick(source, (name) => GIT_CONFIG_ENV_NAMES.includes(name));
}
