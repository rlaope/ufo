import { readFile } from "node:fs/promises";
import path from "node:path";
import { PolicyError, preview, violation } from "../policy/rules.js";
import { git } from "./exec.js";

/**
 * Sections of repository config UFO lets through. Anything else is refused, so a section a new
 * git release adds (as `hook.*` config-based hooks were) fails closed instead of running a
 * program the repository chose. Section names are matched in lowercase, as git stores them.
 */
const ALLOWED_SECTIONS: ReadonlySet<string> = new Set([
  "advice",
  "alias",
  "am",
  "apply",
  "author",
  "blame",
  "branch",
  "checkout",
  "clone",
  "color",
  "column",
  "commit",
  "committer",
  "core",
  "diff",
  "difftool",
  "extensions",
  "feature",
  "fetch",
  "format",
  "gc",
  "grep",
  "gui",
  "help",
  "i18n",
  "index",
  "init",
  "interactive",
  "lfs",
  "log",
  "mailmap",
  "maintenance",
  "man",
  "merge",
  "mergetool",
  "notes",
  "pack",
  "pager",
  "protocol",
  "pull",
  "push",
  "rebase",
  "remote",
  "repack",
  "rerere",
  "sendemail",
  "sequence",
  "sparse",
  "splitindex",
  "stash",
  "status",
  "submodule",
  "tag",
  "trailer",
  "transfer",
  "user",
  "versionsort",
  "web",
  "worktree",
]);

/**
 * Keys inside allowed sections that still make git run a program the repository chose, reach a
 * network endpoint, or point git at other files: diff and merge drivers, an alternate work tree,
 * SSH and proxy commands, remote helper programs, bundle URIs, submodule update commands, and
 * per-worktree config. Refused sections (`hook`, `credential`, `http`, `filter`, `url`, `gpg`,
 * `include`, `includeif`, `uploadpack`, and any unknown one) need no entry here.
 */
const UNSAFE_KEYS: readonly RegExp[] = [
  /^diff\.external$/,
  /^diff\..+\.(?:command|textconv)$/,
  /^merge\..+\.driver$/,
  /^core\.(?:worktree|sshcommand|alternaterefscommand|askpass|gitproxy)$/,
  /^extensions\.worktreeconfig$/,
  /^remote\..+\.(?:uploadpack|receivepack|vcs|proxy|proxyauthmethod)$/,
  /^(?:fetch|transfer)\.bundleuri$/,
  /^submodule\..+\.update$/,
];

function unsafeKey(key: string): boolean {
  const lower = key.toLowerCase();
  const section = lower.split(".")[0] ?? "";
  return !ALLOWED_SECTIONS.has(section) || UNSAFE_KEYS.some((pattern) => pattern.test(lower));
}

/** Attributes that select a driver by name. */
const DRIVER_ATTRIBUTES = ["filter", "diff", "merge"] as const;

function configKeys(listing: string): string[] {
  return listing
    .split("\0")
    .map((entry) => entry.split("\n")[0] ?? "")
    .filter((key) => key !== "");
}

/** `<attr>=<driver>` settings in one attributes file, e.g. `filter=lfs`. */
export function attributeDrivers(text: string): { attribute: string; driver: string }[] {
  const found: { attribute: string; driver: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    for (const token of line.split(/\s+/).slice(1)) {
      const match = /^([a-z]+)=(.+)$/.exec(token);
      if (match === null) continue;
      const [, attribute = "", driver = ""] = match;
      if ((DRIVER_ATTRIBUTES as readonly string[]).includes(attribute)) {
        found.push({ attribute, driver });
      }
    }
  }
  return found;
}

/** The `.gitattributes` files of `sha`'s tree and `info/attributes`, with their content. */
async function attributeFiles(repoRoot: string, sha: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const names = (await git(["ls-tree", "-r", "-z", "--name-only", sha], repoRoot))
    .split("\0")
    .filter((name) => name === ".gitattributes" || name.endsWith("/.gitattributes"));
  for (const name of names) {
    files.set(name, await git(["cat-file", "blob", `${sha}:${name}`], repoRoot));
  }
  const info = (await git(["rev-parse", "--git-path", "info/attributes"], repoRoot)).trim();
  try {
    files.set(".git/info/attributes", await readFile(path.resolve(repoRoot, info), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files;
}

/**
 * Refuses (`policy:unsafe_repo_config`) a repository whose local config has a key outside the
 * allowed sections, or one that would make git run a program the repository chose, or whose attributes (in `sha`'s tree and `info/attributes`,
 * when `sha` is given) name a driver the repository's config defines. Runs before UFO executes any git command in the user's repository that could invoke
 * one (status, branch, fetch), and again before each fetch into it.
 *
 * Only `.git/config` is read (`--local`, includes not followed: an include is refused itself).
 * Per-worktree config is read only with `extensions.worktreeConfig`, which is refused too.
 */
export async function checkRepoConfig(repoRoot: string, sha?: string): Promise<void> {
  const keys = configKeys(
    await git(["config", "--local", "--no-includes", "--list", "-z"], repoRoot),
  );
  const unsafe = keys.filter(unsafeKey);
  if (unsafe.length > 0) {
    throw new PolicyError(
      violation(
        "unsafe_repo_config",
        `the repository's git config sets ${preview([...new Set(unsafe)])}, which could make git run a program or reach an endpoint the repository chose, or is a setting UFO does not know; remove it from .git/config (a setting in your global config is not affected) and try again`,
        [...new Set(unsafe)],
      ),
    );
  }
  if (sha === undefined) return;
  const defined = new Set(
    keys
      .map((key) => /^(filter|diff|merge)\.(.+)\.[^.]+$/.exec(key))
      .filter((match) => match !== null)
      .map((match) => `${match[1]}=${match[2]}`),
  );
  const named: string[] = [];
  for (const [file, text] of await attributeFiles(repoRoot, sha)) {
    for (const { attribute, driver } of attributeDrivers(text)) {
      if (defined.has(`${attribute}=${driver}`)) named.push(`${file}: ${attribute}=${driver}`);
    }
  }
  if (named.length > 0) {
    throw new PolicyError(
      violation(
        "unsafe_repo_config",
        `attributes name a driver the repository's git config defines (${preview(named)}); remove the driver from .git/config and try again`,
        named,
      ),
    );
  }
}
