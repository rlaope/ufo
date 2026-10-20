// Helpers shared by the TOML and JSON span edits. Setup changes a host's config file only at the
// span of UFO's own entry; every other byte stays as it was, and nothing is re-serialized.

/** One edit setup made: the text it put in, and the text that stood there before. */
export interface SpanEdit {
  readonly replaced: string;
  readonly inserted: string;
}

/** The line ending a file uses: CRLF when its first line ends with one, else LF. */
export function eolOf(text: string): string {
  const lf = text.indexOf("\n");
  return lf > 0 && text[lf - 1] === "\r" ? "\r\n" : "\n";
}

/** The spaces and tabs that open the line holding `offset`. */
export function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

/** `text` with `[start, end)` replaced by `replacement`. */
export function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * Reverses `edit` exactly: when its inserted text occurs once in `text` (the host left those bytes
 * alone), that occurrence is put back to what it replaced. `undefined` otherwise; the caller then
 * removes the entry by rule. The caller checks that the result is still a valid file.
 */
export function undoEdit(text: string, edit: SpanEdit): string | undefined {
  const at = text.indexOf(edit.inserted);
  if (edit.inserted === "" || at < 0 || text.indexOf(edit.inserted, at + 1) >= 0) return undefined;
  return splice(text, at, at + edit.inserted.length, edit.replaced);
}

/** `edit` after its entry text `before` became `after` (a re-pin); `null` when it no longer holds it. */
export function repinEdit(edit: SpanEdit | null, before: string, after: string): SpanEdit | null {
  if (edit === null) return null;
  const at = edit.inserted.indexOf(before);
  if (at < 0) return null;
  return {
    replaced: edit.replaced,
    inserted: splice(edit.inserted, at, at + before.length, after),
  };
}
