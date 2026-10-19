import type { CardParam, RecipeEdit, TechniqueCard } from "../domain/index.js";

export type ParamValue = number | boolean | string;

/** A recipe whose edits cannot be applied to arm A, e.g. its `find` text is not there. */
export class RecipeEditError extends Error {
  override name = "RecipeEditError";
}

/** The card's parameters at their defaults: `ufo run` applies recipes this way. */
export function defaultParams(card: Pick<TechniqueCard, "params">): Map<string, ParamValue> {
  return new Map(card.params.map((param: CardParam) => [param.name, param.default]));
}

/** Replaces each `{{name}}` with its parameter value. */
export function substitute(text: string, params: ReadonlyMap<string, ParamValue>): string {
  return text.replace(/\{\{([^}]*)\}\}/g, (_match, name: string) => {
    const value = params.get(name);
    if (value === undefined) throw new RecipeEditError(`no value for parameter ${name}`);
    return String(value);
  });
}

function countOccurrences(content: string, find: string): number {
  let count = 0;
  for (let at = content.indexOf(find); at !== -1; at = content.indexOf(find, at + find.length)) {
    count++;
  }
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Applies one edit to the content of `edit.file`. */
export function applyEdit(
  content: string,
  edit: RecipeEdit,
  params: ReadonlyMap<string, ParamValue>,
): string {
  if (edit.op === "replace_text") {
    const count = countOccurrences(content, edit.find);
    if (count !== 1) {
      throw new RecipeEditError(
        `${edit.file}: the text to replace must occur exactly once, found ${count}`,
      );
    }
    return content.replace(edit.find, () => substitute(edit.replace, params));
  }
  const value = substitute(edit.value, params);
  const line = new RegExp(`^([ \\t]*${escapeRegExp(edit.key)}[ \\t]*=[ \\t]*).*$`, "gm");
  const matches = [...content.matchAll(line)];
  if (matches.length > 1) {
    throw new RecipeEditError(
      `${edit.file}: property ${edit.key} is set ${matches.length} times; expected at most once`,
    );
  }
  if (matches.length === 1) {
    return content.replace(line, (_match, prefix: string) => `${prefix}${value}`);
  }
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${edit.key}=${value}\n`;
}

/**
 * Runs a recipe's edits in order against files read from arm A and returns the new content of
 * every file they touch. `read` returns `undefined` for a path that is not a regular file.
 */
export async function applyRecipeEdits(
  card: Pick<TechniqueCard, "id" | "params" | "edits">,
  read: (file: string) => Promise<string | undefined>,
  params: ReadonlyMap<string, ParamValue> = defaultParams(card),
): Promise<Map<string, string>> {
  if (card.edits.length === 0) {
    throw new RecipeEditError(`card ${card.id} has no edits UFO can apply on its own`);
  }
  const files = new Map<string, string>();
  for (const edit of card.edits) {
    let content = files.get(edit.file);
    if (content === undefined) {
      content = await read(edit.file);
      if (content === undefined) {
        throw new RecipeEditError(`${edit.file} is not a regular file at arm A`);
      }
    }
    files.set(edit.file, applyEdit(content, edit, params));
  }
  return files;
}
