// A unified diff of one span edit, for the review setup prints before it writes. Setup changes
// one contiguous span, so a single hunk around the lines that differ is the whole diff.

const CONTEXT = 3;

function lines(text: string): string[] {
  if (text === "") return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

/** `before` → `after` as one hunk; `""` when they are equal. `undefined` names a missing file. */
export function unifiedDiff(
  label: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (before === after) return "";
  const a = lines(before ?? "");
  const b = lines(after ?? "");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const from = Math.max(0, head - CONTEXT);
  const trailing = Math.min(CONTEXT, tail);
  const show = (line: string) => line.replace(/\r$/, "");
  const body = [
    ...a.slice(from, head).map((line) => ` ${show(line)}`),
    ...a.slice(head, a.length - tail).map((line) => `-${show(line)}`),
    ...b.slice(head, b.length - tail).map((line) => `+${show(line)}`),
    ...a.slice(a.length - tail, a.length - tail + trailing).map((line) => ` ${show(line)}`),
  ];
  const oldCount = a.length - tail + trailing - from;
  const newCount = b.length - tail + trailing - from;
  const range = (count: number) => `${count === 0 ? from : from + 1},${count}`;
  return [
    `--- ${before === undefined ? "/dev/null" : label}`,
    `+++ ${after === undefined ? "/dev/null" : label}`,
    `@@ -${range(oldCount)} +${range(newCount)} @@`,
    ...body,
    "",
  ].join("\n");
}
