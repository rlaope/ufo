import { describe, expect, it } from "vitest";
import { hintFor } from "../../../src/app/index.js";
import { checkOptIn, personMustRun, requireTty } from "../../../src/core/policy/index.js";

// M2 B3b (security M3): an agent reads these messages. Every one that names a human-only step
// says that a person runs it in their own terminal and that an agent must not.

const APPROVE = "a person must run `ufo approve` in their own terminal; an agent must not run it";

describe("a message naming a human-only step", () => {
  it("says a person must run it in their own terminal, and an agent must not", () => {
    expect(personMustRun("ufo approve")).toBe(APPROVE);
    expect(checkOptIn("lossy", [])?.detail).toBe(
      "lossy cards need the lossy opt-in; a person must run `ufo approve --allow-lossy` in their own terminal; an agent must not run it",
    );
    expect(hintFor("policy:budget_exceeded")).toContain(
      "a person must run `ufo extend-budget` in their own terminal; an agent must not run it",
    );
    let refused: unknown;
    try {
      requireTty({ isTTY: false });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      violation: { detail: `ufo approve needs an interactive terminal on stdin: ${APPROVE}` },
    });
  });
});
