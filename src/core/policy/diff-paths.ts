// Reads the file names of a unified diff the way `git apply` (default options, run at the worktree
// root) does, following git's apply.c: `-p1` unless a traditional patch with a slash-free name
// switches the rest of the input to `-p0`, `diff --git` names only when `---`/`+++`/rename lines
// do not give them, timestamps stripped from traditional headers, C-style quoted names, and hunk
// bodies skipped by their line counts. A protected-path check is only as good as this agreement,
// so git-specific rules are mirrored rather than simplified, and anything this parser cannot
// settle is reported as a problem instead of being guessed.

export interface DiffPaths {
  /** Repository-relative paths `git apply` would touch, first seen first. Renames give both. */
  readonly paths: string[];
  /** Headers whose names could not be read. Any entry means `paths` may be incomplete. */
  readonly problems: string[];
}

class Unreadable extends Error {}

interface PState {
  p: number;
  known: boolean;
}

/** git's own `isspace`: no vertical tab or form feed. */
function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function squashSlash(name: string): string {
  return name.replace(/\/{2,}/g, "/");
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

/**
 * `unquote_c_style`: `s` starts with `"`. Undefined for a bad escape (git then reads the name
 * unquoted); throws when the closing quote is not on this line, where git would read on into the
 * next lines.
 */
function unquote(s: string): { value: string; end: number } | undefined {
  const bytes: number[] = [];
  let i = 1;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '"') return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (c !== "\\") {
      const char = String.fromCodePoint(s.codePointAt(i) as number);
      bytes.push(...Buffer.from(char, "utf8"));
      i += char.length;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break;
    if (next in ESCAPES) {
      bytes.push(ESCAPES[next] as number);
      i += 2;
    } else if (next === "\\" || next === '"') {
      bytes.push(next.charCodeAt(0));
      i += 2;
    } else if (/^[0-3][0-7][0-7]$/.test(s.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      return undefined;
    }
  }
  throw new Unreadable("a quoted file name does not end on its line");
}

/** `skip_tree_prefix`: drops `p` leading components; undefined when there are fewer. */
function skipTreePrefix(p: number, s: string): string | undefined {
  if (p === 0) return s.startsWith("/") ? undefined : s;
  let slashes = p;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "/" && --slashes <= 0) return i === 0 ? undefined : s.slice(i + 1);
  }
  return undefined;
}

/** `find_name_gnu`: a quoted name with `p` leading components removed. */
function findNameGnu(s: string, p: number): string | undefined {
  const quoted = unquote(s);
  if (quoted === undefined) return undefined;
  let name = quoted.value;
  for (let left = p; left > 0; left--) {
    const slash = name.indexOf("/");
    if (slash === -1) return undefined;
    name = name.slice(slash + 1);
  }
  return squashSlash(name);
}

/**
 * `find_name_common`. Without `end`, the name stops at a newline, carriage return, or (when
 * `stopAtTab`) a tab; spaces are part of it. A shorter `def` that prefixes the name wins, which
 * is how git reads `--- a/f.orig` / `+++ b/f` as `f`.
 */
function findNameCommon(
  s: string,
  def: string | undefined,
  p: number,
  end: number | undefined,
  stopAtTab: boolean,
): string | undefined {
  let start = p === 0 ? 0 : undefined;
  let left = p;
  let i = 0;
  const stop = end ?? s.length;
  while (i < stop) {
    const c = s[i];
    if (end === undefined && isSpace(c) && c !== " " && (c !== "\t" || stopAtTab)) break;
    i++;
    if (c === "/" && --left === 0) start = i;
  }
  if (start === undefined || i === start) return def === undefined ? undefined : squashSlash(def);
  const name = s.slice(start, i);
  if (def !== undefined && def.length < name.length && name.startsWith(def)) {
    return squashSlash(def);
  }
  return squashSlash(name);
}

function findName(s: string, def: string | undefined, p: number, stopAtTab: boolean) {
  if (s.startsWith('"')) {
    const name = findNameGnu(s, p);
    if (name !== undefined) return name;
  }
  return findNameCommon(s, def, p, undefined, stopAtTab);
}

// `diff_timestamp_len`: POSIX `2010-07-05 19:41:17` or GNU `2010-07-05 19:41:17.620000023 -0500`,
// after one tab or any number of spaces.
const TIMESTAMP =
  /(?:\t| +)\d\d(?:\d\d)?-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?(?: [+-]\d{4}| [+-]\d\d:\d\d)?$/;

function findNameTraditional(s: string, def: string | undefined, p: number) {
  if (s.startsWith('"')) {
    const name = findNameGnu(s, p);
    if (name !== undefined) return name;
  }
  const timestamp = TIMESTAMP.exec(s);
  return timestamp === null
    ? findNameCommon(s, def, p, undefined, true)
    : findNameCommon(s, def, p, timestamp.index, false);
}

function isDevNull(s: string): boolean {
  return s.startsWith("/dev/null") && (s.length === 9 || isSpace(s[9]));
}

/** `guess_p_value` with no `--directory` prefix: 0 for a slash-free name, otherwise unknown. */
function guessP(s: string): number {
  if (isDevNull(s)) return -1;
  const name = findNameTraditional(s, undefined, 0);
  if (name === undefined) return -1;
  return name.includes("/") ? -1 : 0;
}

/** `git_header_name`: the name of a `diff --git` line, only when both sides agree on it. */
function gitHeaderName(p: number, rest: string): string | undefined {
  if (rest.startsWith('"')) {
    const first = unquote(rest);
    if (first === undefined) return undefined;
    const name = skipTreePrefix(p, first.value);
    if (name === undefined) return undefined;
    let j = first.end;
    while (j < rest.length && isSpace(rest[j])) j++;
    if (j >= rest.length) return undefined;
    const second = rest[j] === '"' ? unquote(rest.slice(j))?.value : rest.slice(j);
    if (second === undefined) return undefined;
    return skipTreePrefix(p, second) === name ? name : undefined;
  }
  const name = skipTreePrefix(p, rest);
  if (name === undefined) return undefined;
  const quote = name.indexOf('"');
  if (quote !== -1) {
    const second = unquote(name.slice(quote));
    const np = second === undefined ? undefined : skipTreePrefix(p, second.value);
    if (np === undefined) return undefined;
    return np.length < quote && name.startsWith(np) && isSpace(name[np.length]) ? np : undefined;
  }
  for (let len = 0; len < name.length; len++) {
    if (name[len] !== " " && name[len] !== "\t") continue;
    if (len + 1 >= name.length) return undefined;
    const second = skipTreePrefix(p, name.slice(len + 1));
    if (second !== undefined && second === name.slice(0, len)) return second;
  }
  return undefined;
}

interface Header {
  /** Index of the first line after the header. */
  end: number;
  names: string[];
}

const SOURCE_LINE = /^(?:copy from|rename old|rename from) /;
const DESTINATION_LINE = /^(?:copy to|rename new|rename to) /;

/** `parse_git_diff_header`. `lines[start]` starts with `diff --git `. */
function parseGitHeader(lines: readonly string[], start: number, p: number): Header {
  const defName = gitHeaderName(p, (lines[start] as string).slice("diff --git ".length));
  let oldName: string | undefined;
  let newName: string | undefined;
  let isNew = false;
  let isDelete = false;
  // The last element has no newline after it, and git stops at a line without one.
  let i = start + 1;
  for (; i < lines.length - 1; i++) {
    const line = lines[i] as string;
    if (line.startsWith("@@ -")) break;
    if (line.startsWith("--- ")) {
      if (oldName === undefined && !isNew) oldName = findName(line.slice(4), undefined, p, true);
    } else if (line.startsWith("+++ ")) {
      if (newName === undefined && !isDelete) newName = findName(line.slice(4), undefined, p, true);
    } else if (line.startsWith("deleted file mode ")) {
      isDelete = true;
      oldName = defName;
    } else if (line.startsWith("new file mode ")) {
      isNew = true;
      newName = defName;
    } else if (SOURCE_LINE.test(line)) {
      oldName = findName(line.replace(SOURCE_LINE, ""), undefined, 0, false);
    } else if (DESTINATION_LINE.test(line)) {
      newName = findName(line.replace(DESTINATION_LINE, ""), undefined, 0, false);
    } else if (!/^(?:old mode|new mode|similarity index|dissimilarity index|index) /.test(line)) {
      break;
    }
  }
  if (oldName === undefined && newName === undefined) {
    if (defName === undefined) throw new Unreadable("a diff --git header has no file name");
    oldName = defName;
    newName = defName;
  }
  if ((newName === undefined && !isDelete) || (oldName === undefined && !isNew)) {
    throw new Unreadable("a diff --git header lacks a file name");
  }
  // A `diff --git` line with nothing after it is skipped by git as garbage.
  if (i === start + 1) return { end: i, names: [] };
  return { end: i, names: [oldName, newName].filter((n) => n !== undefined) };
}

/** `parse_traditional_patch`: a `---` line followed by `+++` and `@@ -`. */
function parseTraditional(first: string, second: string, state: PState): string[] {
  if (!state.known) {
    let p = guessP(first);
    const q = guessP(second);
    if (p < 0) p = q;
    if (p >= 0 && p === q) {
      state.p = p;
      state.known = true;
    }
  }
  let name: string | undefined;
  if (isDevNull(first)) {
    name = findNameTraditional(second, undefined, state.p);
  } else if (isDevNull(second)) {
    name = findNameTraditional(first, undefined, state.p);
  } else {
    name = findNameTraditional(second, findNameTraditional(first, undefined, state.p), state.p);
  }
  if (name === undefined) throw new Unreadable("a ---/+++ header has no file name");
  return [name];
}

const FRAGMENT_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** Skips the hunks starting at `i` by their line counts; returns the first line after them. */
function skipFragments(lines: readonly string[], start: number): number {
  let i = start;
  while (i < lines.length && (lines[i] as string).startsWith("@@ -")) {
    const header = FRAGMENT_HEADER.exec(lines[i] as string);
    // A malformed hunk makes git refuse the whole patch.
    if (header === null) return i;
    let oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    let newLeft = header[2] === undefined ? 1 : Number(header[2]);
    i++;
    while (oldLeft !== 0 || newLeft !== 0) {
      if (i >= lines.length - 1) return i;
      const line = lines[i] as string;
      if (line === "" || line.startsWith(" ")) {
        oldLeft--;
        newLeft--;
      } else if (line.startsWith("-")) {
        oldLeft--;
      } else if (line.startsWith("+")) {
        newLeft--;
      } else if (!line.startsWith("\\ ") || line.length < 11) {
        return i;
      }
      i++;
    }
  }
  return i;
}

/** The paths a unified diff touches, as `git apply` reads them. */
export function parseDiffPaths(diff: string): DiffPaths {
  const lines = diff.split("\n");
  const state: PState = { p: 1, known: false };
  const paths: string[] = [];
  const problems: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    let header: Header | undefined;
    try {
      if (line.startsWith("diff --git ")) {
        header = parseGitHeader(lines, i, state.p);
      } else if (
        line.startsWith("--- ") &&
        lines[i + 1]?.startsWith("+++ ") &&
        lines[i + 2]?.startsWith("@@ -")
      ) {
        header = {
          end: i + 2,
          names: parseTraditional(line.slice(4), (lines[i + 1] as string).slice(4), state),
        };
      }
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      problems.push(`line ${i + 1}: ${error.message}`);
    }
    if (header === undefined) {
      i++;
      continue;
    }
    for (const name of header.names) if (!paths.includes(name)) paths.push(name);
    i = header.end > i + 1 ? skipFragments(lines, header.end) : header.end;
  }
  return { paths, problems };
}
