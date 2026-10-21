import { invalid, type Parsed, Tally } from "./summary.js";

/** Lines (distinct stacks) of a folded file; a larger one is refused rather than cut. */
export const MAX_COLLAPSED_LINES = 1_000_000;

const COUNT = /^\d+(?:\.\d+)?$/;

/**
 * Folded stacks, one `root;...;leaf <count>` per line, as async-profiler `-o collapsed`,
 * py-spy `--format raw`, and the stackcollapse scripts write them. Frame names may contain
 * spaces; the count is what follows the last space or tab.
 */
export function parseCollapsed(text: string): Parsed {
  // Counted before anything is kept, without an array of every line.
  let stacks = 0;
  for (const _ of text.matchAll(/\S[^\n]*/g)) {
    if (++stacks > MAX_COLLAPSED_LINES) return invalid(`more than ${MAX_COLLAPSED_LINES} stacks`);
  }
  const tally = new Tally();
  let index = 0;
  for (let from = 0; from <= text.length; index++) {
    const end = text.indexOf("\n", from);
    const raw = text.slice(from, end === -1 ? text.length : end);
    from = end === -1 ? text.length + 1 : end + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const at = Math.max(line.lastIndexOf(" "), line.lastIndexOf("\t"));
    const count = line.slice(at + 1);
    if (at <= 0 || !COUNT.test(count)) {
      return invalid(`line ${index + 1} is not \`frame;frame;... count\``);
    }
    tally.addSample(line.slice(0, at).trimEnd().split(";"), Number(count));
  }
  return { valid: true, tally, unit: "samples" };
}
