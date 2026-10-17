import { expect } from "vitest";
import { DecideInputError, type DecideInputErrorCode } from "../../../src/core/decide/index.js";
import type { Pair } from "../../../src/domain/index.js";

export const CHANGE_ID = "3f2b8c1e-5d4a-4b6f-9e7d-1a2b3c4d5e6f";

/** Noise samples with a noise floor of 0, so `T = minEffect`. */
export const QUIET = [100, 100, 100, 100, 100];

/**
 * Pairs with A = 100 and the given B values. With a lower-is-better metric each pair's
 * improvement is `(100 - b) / 100`, exactly the decimal literal: b = 97 gives 0.03.
 */
export function pairsAt100(...bs: number[]): Pair[] {
  return bs.map((b) => ({ a: 100, b }));
}

export function expectDecideError(run: () => unknown, code: DecideInputErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DecideInputError);
  expect((caught as DecideInputError).code).toBe(code);
}
