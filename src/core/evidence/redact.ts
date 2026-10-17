import os from "node:os";
import path from "node:path";

export interface RedactOptions {
  /** Replaced with `~`. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Defaults to `os.userInfo().username`. */
  username?: string;
  /** Machine names often contain the owner's name. Defaults to `os.hostname()`. */
  hostname?: string;
  /** Values of sensitive-named variables are redacted wherever they appear. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export type RedactionKind =
  | "username"
  | "hostname"
  | "credentials"
  | "authorization"
  | "token"
  | "api_key"
  | "private_key"
  | "secret";

export function placeholder(kind: RedactionKind): string {
  return `<redacted:${kind}>`;
}

const PLACEHOLDER_PREFIX = "<redacted:";
/** Names and env values shorter than this are too likely to be ordinary words to replace. */
const MIN_NAME_LENGTH = 3;
const MIN_ENV_SECRET_LENGTH = 8;

/** Name characters: a match must not continue into a longer name (`/Users/bo` in `/Users/bob`). */
const NAME_AFTER = String.raw`(?![\w@+-]|\.\w)`;
const NAME_BEFORE = String.raw`(?<![\w.@+-])`;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** `scheme://user:password@` and `scheme://:password@` (redis), any scheme. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#]*@/gi;
/** The header name, its separator (with an optional opening quote), then the value. */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?!\s*<redacted:)[^\r\n"']+/gi;
const BEARER = /\b(bearer\s+)(?!<redacted:)[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY = new RegExp(
  `(?<![A-Za-z0-9])(?:${[
    "sk-[A-Za-z0-9_-]{16,}", // OpenAI, Anthropic (sk-ant-...), and similar
    "gh[pousr]_[A-Za-z0-9]{20,}", // GitHub tokens
    "github_pat_[A-Za-z0-9_]{20,}",
    "xox[abposr]-[A-Za-z0-9-]{10,}", // Slack
    "(?:AKIA|ASIA)[0-9A-Z]{16}", // AWS access key ids
    "AIza[0-9A-Za-z_-]{35}", // Google API keys
    String.raw`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, // JWTs
  ].join("|")})`,
  "g",
);
/**
 * `KEY=value`, `--key=value`, `key: value`, and `"key": "value"`. The replacement callback
 * decides whether the key is sensitive.
 */
const ASSIGNMENT =
  /(?<!\w)(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;&}\]]+)/g;

/** Substrings that make a key sensitive anywhere in it, e.g. `PGPASSWORD`, `CLIENT_SECRET`. */
const SENSITIVE_PARTS = [
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "SECRET",
  "APIKEY",
  "API_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "CREDENTIAL",
  "AUTHORIZATION",
];
/** Whole `_`-separated segments, so `max_tokens` stays while `GITHUB_TOKEN` goes. */
const SENSITIVE_SEGMENTS = new Set(["TOKEN", "PASS", "PWD", "AUTH", "COOKIE", "SESSION"]);
/** The working directory, not a password. */
const NOT_SENSITIVE = new Set(["PWD", "OLDPWD"]);

/** Whether an env-style key names a secret. Accepts `snake_case`, `kebab-case`, and `camelCase`. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  if (NOT_SENSITIVE.has(normalized)) return false;
  if (SENSITIVE_PARTS.some((part) => normalized.includes(part))) return true;
  return normalized.split("_").some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/**
 * Returns `value` with secrets and personal identifiers replaced by fixed placeholders: values of
 * sensitive environment variables, private keys, URL credentials, `Authorization` headers, bearer
 * tokens, common API-key formats, sensitive `KEY=value` assignments, the home directory (`~`),
 * the username, and the hostname. Strings are redacted; arrays and plain objects are copied with
 * every key and string leaf redacted, and string values under a sensitive key replaced whole.
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const text = createTextRedactor(options);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return text(node);
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [
          text(key),
          typeof child === "string" && isSensitiveKey(key) && child !== ""
            ? placeholder("secret")
            : walk(child),
        ]),
      );
    }
    return node;
  };
  return walk(value) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function createTextRedactor(options: RedactOptions): (text: string) => string {
  const env = options.env ?? process.env;
  const envSecrets = Object.entries(env)
    .filter(
      ([key, v]) => v !== undefined && v.length >= MIN_ENV_SECRET_LENGTH && isSensitiveKey(key),
    )
    .map(([, v]) => v as string)
    .sort((x, y) => y.length - x.length);
  const homeDir = options.homeDir ?? os.homedir();
  const home =
    homeDir !== "" && homeDir !== path.parse(homeDir).root
      ? new RegExp(escapeRegExp(homeDir) + NAME_AFTER, "g")
      : undefined;
  const hostname = options.hostname ?? os.hostname();
  const names = [
    { name: options.username ?? currentUsername(), kind: "username" as const },
    { name: hostname, kind: "hostname" as const },
    // The short form of `name.local` and similar.
    { name: hostname.split(".")[0], kind: "hostname" as const },
  ].flatMap(({ name, kind }) =>
    name === undefined || name.length < MIN_NAME_LENGTH || name === "localhost"
      ? []
      : [
          {
            pattern: new RegExp(NAME_BEFORE + escapeRegExp(name) + NAME_AFTER, "gi"),
            replacement: placeholder(kind),
          },
        ],
  );

  return (input) => {
    let text = input;
    for (const secret of envSecrets) text = text.split(secret).join(placeholder("secret"));
    if (home) text = text.replace(home, "~");
    text = text
      .replace(PRIVATE_KEY_BLOCK, placeholder("private_key"))
      .replace(URL_CREDENTIALS, `$1${placeholder("credentials")}@`)
      .replace(AUTH_HEADER, `$1$2${placeholder("authorization")}`)
      .replace(BEARER, `$1${placeholder("token")}`)
      .replace(API_KEY, placeholder("api_key"));
    text = redactAssignments(text);
    for (const { pattern, replacement } of names) text = text.replace(pattern, replacement);
    return text;
  };
}

/**
 * Replaces the value of each sensitive assignment. After a non-sensitive key the scan resumes at
 * its value, so `env: DB_PASSWORD=x` still finds `DB_PASSWORD`.
 */
function redactAssignments(text: string): string {
  const pattern = new RegExp(ASSIGNMENT.source, "g");
  let out = "";
  let copied = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [whole, quote = "", key = "", separator = "", value = ""] = match;
    const head = `${quote}${key}${quote}${separator}`;
    const bare = value.replace(/^["']|["']$/g, "");
    if (!isSensitiveKey(key) || bare.startsWith(PLACEHOLDER_PREFIX)) {
      pattern.lastIndex = match.index + head.length;
      continue;
    }
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") ? value[0] : "";
    out += text.slice(copied, match.index) + head + quoted + placeholder("secret") + quoted;
    copied = match.index + whole.length;
  }
  return out + text.slice(copied);
}

function currentUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    // No passwd entry for the current uid (some containers).
    return undefined;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
