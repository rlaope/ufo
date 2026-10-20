import { SetupError } from "./errors.js";
import { eolOf, type SpanEdit, splice } from "./span.js";

// Span edits of one table in a TOML file (Codex's `[mcp_servers.ufo]` in ~/.codex/config.toml).
// The scanner checks the file's syntax (TOML 1.0, plus the 1.1 relaxations Codex's parser accepts:
// newlines and a trailing comma in inline tables, `\e` and `\xHH` escapes, optional seconds) and
// records where each table header and key/value line is. Values are read only as far as setup
// compares them: strings, decimal integers, booleans, arrays, inline tables. Floats and dates
// are checked and kept opaque.

/** A value setup does not read (float, date, non-decimal integer). */
export class TomlOpaque {
  constructor(readonly raw: string) {}
}

export type TomlValue = string | number | boolean | TomlOpaque | TomlValue[] | TomlTableValue;
export interface TomlTableValue {
  [key: string]: TomlValue;
}

interface KeyLine {
  /** The key's dotted path, relative to its table. */
  readonly path: readonly string[];
  readonly value: TomlValue;
}

export interface TomlTable {
  /** `[]` for the root table. */
  readonly path: readonly string[];
  /** `[[...]]`, an array-of-tables element. */
  readonly array: boolean;
  /** Offset of the header line (0 for the root table). */
  readonly start: number;
  /** End of the table's last key/value line (after its line ending), or of its header line. */
  readonly end: number;
  readonly keys: readonly KeyLine[];
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const SCALAR_CHAR = /[0-9A-Za-z_:.+-]/;
const DECIMAL = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const OTHER_SCALARS = [
  /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/,
  /^0o[0-7](?:_?[0-7])*$/,
  /^0b[01](?:_?[01])*$/,
  /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/,
  /^[+-]?(?:inf|nan)$/,
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/,
  /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/,
];
const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\x1b",
  '"': '"',
  "\\": "\\",
};

/** Sets `path` in an inline table; a key defined twice is a syntax error. */
function assign(table: TomlTableValue, path: readonly string[], value: TomlValue): boolean {
  let current = table;
  for (const [index, part] of path.entries()) {
    if (index === path.length - 1) {
      if (Object.hasOwn(current, part)) return false;
      current[part] = value;
      return true;
    }
    const next = current[part];
    if (next === undefined) {
      const created: TomlTableValue = {};
      current[part] = created;
      current = created;
    } else if (typeof next === "object" && !Array.isArray(next) && !(next instanceof TomlOpaque)) {
      current = next;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Every table of `text` in file order, the root table first. Throws `host_config_invalid` naming
 * the line of the first syntax error. `label` names the file in messages.
 */
export function scanToml(text: string, label: string): TomlTable[] {
  let i = text.startsWith("﻿") ? 1 : 0;
  const peek = (ahead = 0) => text.charAt(i + ahead);
  const fail = (what: string): never => {
    const line = text.slice(0, i).split("\n").length;
    throw new SetupError(
      "host_config_invalid",
      `${label} is not valid TOML (${what} on line ${line}); fix it, or add the ufo server by hand`,
    );
  };
  const newlineAt = () => (peek() === "\n" ? 1 : peek() === "\r" && peek(1) === "\n" ? 2 : 0);
  const skipSpaces = () => {
    while (peek() === " " || peek() === "\t") i++;
  };
  const skipComment = () => {
    if (peek() !== "#") return;
    while (i < text.length && newlineAt() === 0) i++;
  };
  /** Spaces, comments, and line endings, as allowed inside arrays and inline tables. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      const n = newlineAt();
      if (n === 0) return;
      i += n;
    }
  };
  /** The rest of a line: spaces, a comment, then a line ending or the end of the file. */
  const endLine = () => {
    skipSpaces();
    skipComment();
    if (i >= text.length) return;
    const n = newlineAt();
    if (n === 0) fail("unexpected text after a value");
    i += n;
  };
  const hex = (digits: number): string => {
    const code = text.slice(i, i + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(code)) fail("an invalid escape");
    i += digits;
    const point = Number.parseInt(code, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail("an invalid escape");
    return String.fromCodePoint(point);
  };
  const readEscape = (): string => {
    const c = peek();
    i++;
    if (c === "x") return hex(2);
    if (c === "u") return hex(4);
    if (c === "U") return hex(8);
    return ESCAPES[c] ?? fail("an invalid escape");
  };
  const basicString = (): string => {
    i++;
    let out = "";
    for (;;) {
      const c = peek();
      if (c === "" || c === "\n" || c === "\r") fail("an unterminated string");
      i++;
      if (c === '"') return out;
      out += c === "\\" ? readEscape() : c;
    }
  };
  const literalString = (): string => {
    i++;
    const start = i;
    while (peek() !== "'") {
      if (peek() === "" || peek() === "\n" || peek() === "\r") fail("an unterminated string");
      i++;
    }
    i++;
    return text.slice(start, i - 1);
  };
  /** `"""` or `'''`: up to two quotes right before the closing three belong to the string. */
  const multiline = (quote: string): string => {
    i += 3;
    i += newlineAt();
    let out = "";
    for (;;) {
      if (text.startsWith(quote.repeat(3), i)) {
        let run = 3;
        while (run < 5 && peek(run) === quote) run++;
        i += run;
        return out + quote.repeat(run - 3);
      }
      const c = peek();
      if (c === "") fail("an unterminated multi-line string");
      i++;
      if (c !== "\\" || quote === "'") {
        out += c;
        continue;
      }
      // A backslash that ends a line trims the line ending and the whitespace after it.
      let j = i;
      while (text.charAt(j) === " " || text.charAt(j) === "\t") j++;
      if (text.charAt(j) === "\n" || text.startsWith("\r\n", j)) {
        i = j;
        while (peek() === " " || peek() === "\t" || newlineAt() > 0) i += newlineAt() || 1;
        continue;
      }
      out += readEscape();
    }
  };
  const simpleKey = (): string => {
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    const start = i;
    while (BARE_KEY.test(peek())) i++;
    if (i === start) fail("a missing key");
    return text.slice(start, i);
  };
  const key = (): string[] => {
    const parts = [simpleKey()];
    for (;;) {
      skipSpaces();
      if (peek() !== ".") return parts;
      i++;
      skipSpaces();
      parts.push(simpleKey());
    }
  };
  const expect = (token: string) => {
    if (!text.startsWith(token, i)) fail(`a missing ${token}`);
    i += token.length;
  };
  const value = (): TomlValue => {
    const c = peek();
    if (text.startsWith('"""', i)) return multiline('"');
    if (text.startsWith("'''", i)) return multiline("'");
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i++;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (peek() === "]") break;
        items.push(value());
        skipBlank();
        if (peek() !== ",") break;
        i++;
      }
      expect("]");
      return items;
    }
    if (c === "{") {
      i++;
      const table: TomlTableValue = {};
      for (;;) {
        skipBlank();
        if (peek() === "}") break;
        const path = key();
        skipSpaces();
        expect("=");
        skipSpaces();
        if (!assign(table, path, value())) fail("a key defined twice");
        skipBlank();
        if (peek() !== ",") break;
        i++;
      }
      expect("}");
      return table;
    }
    const start = i;
    while (
      SCALAR_CHAR.test(peek()) ||
      // A date and a time may be separated by one space.
      (peek() === " " && /^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, i)) && /\d/.test(peek(1)))
    ) {
      i++;
    }
    const raw = text.slice(start, i);
    if (raw === "true" || raw === "false") return raw === "true";
    if (DECIMAL.test(raw)) return Number(raw.replaceAll("_", ""));
    if (OTHER_SCALARS.some((pattern) => pattern.test(raw))) return new TomlOpaque(raw);
    return fail(raw === "" ? "a missing value" : "an invalid value");
  };

  const root = { path: [] as string[], array: false, start: 0, end: 0, keys: [] as KeyLine[] };
  const tables = [root];
  let current = root;
  while (i < text.length) {
    skipSpaces();
    if (peek() === "#" || newlineAt() > 0) {
      endLine();
      continue;
    }
    if (i >= text.length) break;
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    if (peek() === "[") {
      const array = peek(1) === "[";
      i += array ? 2 : 1;
      skipSpaces();
      const path = key();
      skipSpaces();
      expect(array ? "]]" : "]");
      endLine();
      current = { path, array, start: lineStart, end: i, keys: [] };
      tables.push(current);
      continue;
    }
    const path = key();
    skipSpaces();
    expect("=");
    skipSpaces();
    const parsed = value();
    endLine();
    current.keys.push({ path, value: parsed });
    current.end = i;
  }
  return tables;
}

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => path[index] === part);

/** Where `[<parent>.<name>]` is, or why setup cannot tell or edit it. */
export type TomlEntry =
  | { readonly found: false }
  | {
      readonly found: true;
      /** The table, when the entry is exactly one `[parent.name]` table and nothing else. */
      readonly table: TomlTable | undefined;
      /** The table's keys as one value (`undefined` when `table` is). */
      readonly value: TomlTableValue | undefined;
    };

/**
 * Finds the `[<parent>.<name>]` table. Refuses (`host_config_invalid`) a file that does not parse,
 * repeats the table, or defines `parent` in a way a new table cannot extend (an inline table,
 * another value, an array of tables). An entry spread over sub-tables, dotted keys, or an inline
 * table is found without a `table`: setup does not edit it.
 */
export function locateTomlEntry(
  text: string,
  parent: string,
  name: string,
  label: string,
): TomlEntry {
  const tables = scanToml(text, label);
  const entryPath = [parent, name];
  const exact = tables.filter(
    (t) => !t.array && t.path.length === 2 && startsWith(t.path, entryPath),
  );
  if (exact.length > 1) {
    throw new SetupError("host_config_invalid", `${label} has [${parent}.${name}] more than once`);
  }
  let elsewhere = tables.some(
    (t) => startsWith(t.path, entryPath) && (t.array || t.path.length > 2),
  );
  for (const table of tables) {
    if (table.array && table.path.length === 1 && table.path[0] === parent) {
      throw new SetupError(
        "host_config_invalid",
        `${label} defines ${parent} as an array of tables; add the ufo server by hand`,
      );
    }
    if (table.array) continue;
    for (const line of table.keys) {
      const full = [...table.path, ...line.path];
      if (full.length === 1 && full[0] === parent) {
        throw new SetupError(
          "host_config_invalid",
          `${label} sets ${parent} as one value (an inline table); add the ufo server by hand`,
        );
      }
      if (startsWith(full, entryPath) && table !== exact[0]) elsewhere = true;
    }
  }
  const [table] = exact;
  if (table === undefined && !elsewhere) return { found: false };
  if (table === undefined || elsewhere) return { found: true, table: undefined, value: undefined };
  const value: TomlTableValue = {};
  for (const line of table.keys) {
    if (!assign(value, line.path, line.value)) {
      throw new SetupError(
        "host_config_invalid",
        `${label} sets a key of [${parent}.${name}] twice`,
      );
    }
  }
  return { found: true, table, value };
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderValue).join(", ")}]`;
  throw new Error(`setup does not write ${JSON.stringify(value)} to TOML`);
}

/** `[parent.name]` and one `key = value` line per entry, each ending in `eol`. */
export function renderTomlTable(
  parent: string,
  name: string,
  value: Readonly<Record<string, unknown>>,
  eol: string,
): string {
  const lines = [`[${parent}.${name}]`];
  for (const [key, item] of Object.entries(value)) lines.push(`${key} = ${renderValue(item)}`);
  return lines.map((line) => line + eol).join("");
}

/**
 * Appends the table to `text` (`undefined`: a new file), after one blank line. The entry must be
 * absent (`locateTomlEntry`).
 */
export function insertTomlEntry(
  text: string | undefined,
  parent: string,
  name: string,
  value: Readonly<Record<string, unknown>>,
): { text: string; edit: SpanEdit } {
  const current = text ?? "";
  const eol = eolOf(current);
  const lead = current === "" ? "" : current.endsWith("\n") ? eol : eol + eol;
  const inserted = lead + renderTomlTable(parent, name, value, eol);
  return { text: current + inserted, edit: { replaced: "", inserted } };
}

/**
 * Removes the table by rule (when `undoEdit` cannot reverse setup's own edit): its header through
 * its last key/value line, and one blank line right before it. Comments and blank lines after its
 * last key belong to what follows and stay.
 */
export function removeTomlEntry(text: string, parent: string, name: string, label: string): string {
  const located = locateTomlEntry(text, parent, name, label);
  if (!located.found) return text;
  if (located.table === undefined) throw new Error(`${label} has no editable [${parent}.${name}]`);
  const { start, end } = located.table;
  let from = start;
  if (start > 0) {
    const previous = start >= 2 ? text.lastIndexOf("\n", start - 2) + 1 : 0;
    if (text.slice(previous, start).trim() === "") from = previous;
  }
  return splice(text, from, end, "");
}

/** Replaces the table (present and editable) with one holding `value`; returns both texts. */
export function replaceTomlEntry(
  text: string,
  parent: string,
  name: string,
  value: Readonly<Record<string, unknown>>,
  label: string,
): { text: string; before: string; after: string } {
  const located = locateTomlEntry(text, parent, name, label);
  if (!located.found || located.table === undefined) {
    throw new Error(`${label} has no editable [${parent}.${name}]`);
  }
  const { start, end } = located.table;
  const before = text.slice(start, end);
  const rendered = renderTomlTable(parent, name, value, eolOf(text));
  // A table at the end of a file without a final line ending stays without one.
  const after = before.endsWith("\n") ? rendered : rendered.replace(/\r?\n$/, "");
  return { text: splice(text, start, end, after), before, after };
}
