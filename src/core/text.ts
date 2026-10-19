/**
 * `text` on one line (runs of control characters become one space), trimmed, at most `max`
 * characters; a longer line ends in `...`. An empty result gives `fallback`.
 */
export function oneLine(text: string, max: number, fallback = ""): string {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  if (line === "") return fallback;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
