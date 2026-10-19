import { describe, expect, it } from "vitest";
import { oneLine } from "../../../src/core/text.js";

describe("oneLine", () => {
  it("folds control characters, trims, and bounds the length", () => {
    expect(oneLine("  a\n\tb\u0000c  ", 100)).toBe("a b c");
    expect(oneLine("abcdefghij", 8)).toBe("abcde...");
    expect(oneLine("abcdefgh", 8)).toBe("abcdefgh");
    expect(oneLine("\n\n", 8, "none")).toBe("none");
  });
});
