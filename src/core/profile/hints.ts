import type { FrameShare } from "./summary.js";

// Which frame hints of a card a profile's hot spots show. Pure and bounded: hints are compared
// as plain substrings, never as patterns, against the frames a summary already lists.

/** Matched frames kept per card, the largest share first. */
export const MAX_EVIDENCE = 3;

export interface HintMatcher {
  /** A plain, case-sensitive substring of a frame name. */
  readonly match: string;
  /** The share of the profile, in (0, 1], the frame needs. */
  readonly minShare: number;
}

export interface HintEvidence {
  hint: string;
  /** The frame as the profile's summary shows it: the repository's text. */
  frame: string;
  /** The frame's share of its file's total weight, in [0, 1]. */
  share: number;
  /** The list the share comes from, the larger of the two when the frame is in both. */
  kind: "self" | "total";
}

/** The lists of one profile file the matcher reads; a file that could not be read has none. */
export type HintedFile =
  | {
      readonly valid: true;
      readonly self: readonly FrameShare[];
      readonly total: readonly FrameShare[];
    }
  | { readonly valid: false };

export interface HotFrame {
  readonly frame: string;
  /** The frame with every `/` as `.`: async-profiler writes `com/foo/Bar.baz`, JFR `com.foo.Bar.baz`. */
  readonly normalized: string;
  readonly share: number;
  readonly kind: "self" | "total";
}

/** Every frame of the valid files' top self and total lists, at the larger of its shares. */
export function hotFrames(files: readonly HintedFile[]): HotFrame[] {
  const best = new Map<string, HotFrame>();
  for (const file of files) {
    if (!file.valid) continue;
    for (const kind of ["self", "total"] as const) {
      for (const { frame, pct } of file[kind]) {
        const share = Math.round(pct * 10) / 1000;
        const seen = best.get(frame);
        if (seen === undefined || share > seen.share) {
          best.set(frame, { frame, normalized: frame.replaceAll("/", "."), share, kind });
        }
      }
    }
  }
  return [...best.values()];
}

/**
 * The frames that point at a card: those holding one of its hints, as written or normalized,
 * with at least that hint's share; at most `MAX_EVIDENCE`, the largest share first, one entry
 * per frame.
 */
export function matchHints(
  hints: readonly HintMatcher[],
  frames: readonly HotFrame[],
): HintEvidence[] {
  const found: HintEvidence[] = [];
  for (const { frame, normalized, share, kind } of frames) {
    const hint = hints.find(
      (h) => share >= h.minShare && (frame.includes(h.match) || normalized.includes(h.match)),
    );
    if (hint !== undefined) found.push({ hint: hint.match, frame, share, kind });
  }
  return found
    .sort((a, b) => b.share - a.share || (a.frame < b.frame ? -1 : a.frame > b.frame ? 1 : 0))
    .slice(0, MAX_EVIDENCE);
}
