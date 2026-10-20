import { SetupError } from "./errors.js";
import { eolOf, lineIndent, type SpanEdit, splice } from "./span.js";

// Span edits of one member of one object in a JSON file (Cursor's `mcpServers.ufo` in
// ~/.cursor/mcp.json). The file is checked with `JSON.parse` first; the scanner below then only
// records where each object member starts and ends.

interface Member {
  readonly key: string;
  /** Offset of the key's opening quote. */
  readonly start: number;
  /** Offset just after the value. */
  readonly end: number;
  readonly value: Node;
}

interface ObjectNode {
  readonly kind: "object";
  /** Offset of `{`. */
  readonly start: number;
  /** Offset just after `}`. */
  readonly end: number;
  readonly members: readonly Member[];
}

type Node = ObjectNode | { readonly kind: "other"; readonly start: number; readonly end: number };

const BOM = "﻿";
const SPACE = " \t\n\r";

function scan(text: string): Node {
  let i = text.startsWith(BOM) ? 1 : 0;
  const skipSpace = () => {
    while (i < text.length && SPACE.includes(text.charAt(i))) i++;
  };
  const string = (): string => {
    const start = i;
    i++;
    while (text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): Node => {
    skipSpace();
    const start = i;
    const c = text.charAt(i);
    if (c === "{") {
      i++;
      const members: Member[] = [];
      skipSpace();
      if (text.charAt(i) === "}") {
        i++;
        return { kind: "object", start, end: i, members };
      }
      for (;;) {
        skipSpace();
        const keyStart = i;
        const key = string();
        skipSpace();
        i++; // the colon
        const member = value();
        members.push({ key, start: keyStart, end: member.end, value: member });
        skipSpace();
        if (text.charAt(i++) === "}") return { kind: "object", start, end: i, members };
      }
    }
    if (c === "[") {
      i++;
      skipSpace();
      if (text.charAt(i) !== "]") {
        for (;;) {
          value();
          skipSpace();
          if (text.charAt(i) !== ",") break;
          i++;
        }
      }
      i++;
      return { kind: "other", start, end: i };
    }
    if (c === '"') {
      string();
      return { kind: "other", start, end: i };
    }
    while (i < text.length && !`,]}${SPACE}`.includes(text.charAt(i))) i++;
    return { kind: "other", start, end: i };
  };
  return value();
}

/** Where `<parent>.<name>` is in the file, or what is missing on the way to it. */
export type JsonEntry =
  | { readonly found: false; readonly root: ObjectNode; readonly parent: ObjectNode | undefined }
  | {
      readonly found: true;
      readonly root: ObjectNode;
      readonly parent: ObjectNode;
      readonly member: Member;
      /** The entry's value as `JSON.parse` reads it. */
      readonly value: unknown;
    };

function only(members: readonly Member[], key: string, where: string): Member | undefined {
  const matches = members.filter((m) => m.key === key);
  if (matches.length > 1) {
    throw new SetupError("host_config_invalid", `${where} has ${key} more than once`);
  }
  return matches[0];
}

/**
 * Finds the member `name` of the root's object member `parent`. Refuses (`host_config_invalid`) a
 * file that is not JSON, whose root or `parent` is not an object, or that repeats either key.
 * `label` names the file in messages.
 */
export function locateJsonEntry(
  text: string,
  parent: string,
  name: string,
  label: string,
): JsonEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch (error) {
    throw new SetupError(
      "host_config_invalid",
      `${label} is not valid JSON (${(error as Error).message}); fix it, or add the ufo server by hand`,
    );
  }
  const root = scan(text);
  if (root.kind !== "object" || typeof parsed !== "object" || parsed === null) {
    throw new SetupError("host_config_invalid", `${label} does not hold a JSON object`);
  }
  const parentMember = only(root.members, parent, label);
  if (parentMember === undefined) return { found: false, root, parent: undefined };
  if (parentMember.value.kind !== "object") {
    throw new SetupError("host_config_invalid", `${parent} in ${label} is not an object`);
  }
  const object = parentMember.value;
  const member = only(object.members, name, `${parent} in ${label}`);
  if (member === undefined) return { found: false, root, parent: object };
  const value = (parsed as Record<string, Record<string, unknown>>)[parent]?.[name];
  return { found: true, root, parent: object, member, value };
}

/** The indentation one level deeper than `object`'s own line, as the file spells it. */
function memberIndent(text: string, object: ObjectNode, unit: string): string {
  const first = object.members[0];
  if (first !== undefined && text.slice(object.start + 1, first.start).includes("\n")) {
    return lineIndent(text, first.start);
  }
  return lineIndent(text, object.start) + unit;
}

/** The file's indentation step: what its root's first member line opens with, else two spaces. */
function indentUnit(text: string, root: ObjectNode): string {
  const first = root.members[0];
  if (first !== undefined && text.slice(root.start + 1, first.start).includes("\n")) {
    const indent = lineIndent(text, first.start);
    if (indent !== "") return indent;
  }
  return "  ";
}

/** `"key": value`, pretty-printed at `indent` with the file's step and line ending. */
function renderMember(key: string, value: unknown, indent: string, unit: string, eol: string) {
  return `${JSON.stringify(key)}: ${JSON.stringify(value, null, unit)
    .split("\n")
    .join(eol + indent)}`;
}

/** Whether `object`'s members sit on their own lines (else it is written on one line). */
function multiline(text: string, object: ObjectNode): boolean {
  const first = object.members[0];
  return first === undefined || text.slice(object.start + 1, first.start).includes("\n");
}

/** Appends `key: value` as the last member of `object`. */
function appendMember(
  text: string,
  root: ObjectNode,
  object: ObjectNode,
  key: string,
  value: unknown,
): { text: string; edit: SpanEdit } {
  const eol = eolOf(text);
  const unit = indentUnit(text, root);
  const last = object.members.at(-1);
  if (last === undefined) {
    // An empty object: its inner whitespace gives way to the member on its own line.
    const indent = memberIndent(text, object, unit);
    const inserted = `${eol}${indent}${renderMember(key, value, indent, unit, eol)}${eol}${lineIndent(text, object.start)}`;
    const replaced = text.slice(object.start + 1, object.end - 1);
    return {
      text: splice(text, object.start + 1, object.end - 1, inserted),
      edit: { replaced, inserted },
    };
  }
  const inserted = multiline(text, object)
    ? `,${eol}${memberIndent(text, object, unit)}${renderMember(key, value, memberIndent(text, object, unit), unit, eol)}`
    : `, ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  return { text: splice(text, last.end, last.end, inserted), edit: { replaced: "", inserted } };
}

export interface JsonInsert {
  readonly text: string;
  readonly edit: SpanEdit;
  /** Whether the insert added `parent` itself. */
  readonly parentCreated: boolean;
}

/**
 * Adds `<parent>.<name>: value` to `text` (`undefined` or blank: a new file), as the last member
 * of `parent`, creating `parent` as the root's last member when it is missing. The entry must be
 * absent (`locateJsonEntry`).
 */
export function insertJsonEntry(
  text: string | undefined,
  parent: string,
  name: string,
  value: unknown,
  label: string,
): JsonInsert {
  if (text === undefined || text.trim() === "") {
    const inserted = `${JSON.stringify({ [parent]: { [name]: value } }, null, 2)}\n`;
    return { text: inserted, edit: { replaced: text ?? "", inserted }, parentCreated: true };
  }
  const located = locateJsonEntry(text, parent, name, label);
  if (located.found) throw new Error(`${label} already has ${parent}.${name}`);
  if (located.parent === undefined) {
    const added = appendMember(text, located.root, located.root, parent, { [name]: value });
    return { ...added, parentCreated: true };
  }
  return { ...appendMember(text, located.root, located.parent, name, value), parentCreated: false };
}

/** `text` without `object.members[index]` and the comma and space that separated it. */
function removeMember(text: string, object: ObjectNode, index: number): string {
  const member = object.members[index];
  if (member === undefined) return text;
  if (object.members.length === 1) return splice(text, object.start + 1, object.end - 1, "");
  const previous = object.members[index - 1];
  if (index === object.members.length - 1 && previous !== undefined) {
    return splice(text, previous.end, member.end, "");
  }
  const next = object.members[index + 1];
  return next === undefined ? text : splice(text, member.start, next.start, "");
}

/**
 * Removes `<parent>.<name>` by rule (when `undoEdit` cannot reverse setup's own edit): the member
 * and one separating comma; an only member leaves `{}`. With `parentCreated`, a `parent` left
 * empty goes too.
 */
export function removeJsonEntry(
  text: string,
  parent: string,
  name: string,
  parentCreated: boolean,
  label: string,
): string {
  const located = locateJsonEntry(text, parent, name, label);
  if (!located.found) return text;
  const removed = removeMember(
    text,
    located.parent,
    located.parent.members.indexOf(located.member),
  );
  if (!parentCreated) return removed;
  const after = locateJsonEntry(removed, parent, name, label);
  if (after.parent === undefined || after.parent.members.length > 0) return removed;
  const index = after.root.members.findIndex((m) => m.key === parent);
  return removeMember(removed, after.root, index);
}

/** Replaces the value of `<parent>.<name>` (present) with `value`; returns both entry texts. */
export function replaceJsonEntry(
  text: string,
  parent: string,
  name: string,
  value: unknown,
  label: string,
): { text: string; before: string; after: string } {
  const located = locateJsonEntry(text, parent, name, label);
  if (!located.found) throw new Error(`${label} has no ${parent}.${name}`);
  const { member } = located;
  const before = text.slice(member.start, member.end);
  const after = multiline(text, located.parent)
    ? renderMember(
        name,
        value,
        lineIndent(text, member.start),
        indentUnit(text, located.root),
        eolOf(text),
      )
    : `${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  return { text: splice(text, member.start, member.end, after), before, after };
}
