import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BundleIdSchema,
  CommandLineSchema,
  GitShaSchema,
  IdSchema,
  idRecord,
  labelSchema,
  MAX_COMMAND_LENGTH,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PATH_LENGTH,
  MAX_RECORD_ENTRIES,
  RepoPathSchema,
  SCHEMA_VERSION,
  Sha256HexSchema,
  uniqueArray,
} from "../../../src/domain/index.js";
import { expectAccepts, expectRejects, SHA_A, SHA256 } from "./fixtures.js";

describe("SCHEMA_VERSION", () => {
  it("is 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("IdSchema", () => {
  it.each(["startup_ms", "jvm.aot-cache", "p95", "a"])("accepts %s", (id) => {
    expectAccepts(IdSchema, id);
  });

  it("accepts an id at the length limit", () => {
    expectAccepts(IdSchema, "a".repeat(MAX_ID_LENGTH));
  });

  it.each([
    ["empty", ""],
    ["overlong", "a".repeat(MAX_ID_LENGTH + 1)],
    ["uppercase", "Startup"],
    ["leading digit", "9lives"],
    ["space", "start up"],
    ["trailing separator", "startup_"],
    ["double separator", "start__up"],
    ["not a string", 42],
  ])("rejects %s", (_label, value) => {
    expectRejects(IdSchema, value);
  });
});

describe("GitShaSchema", () => {
  it("accepts a full lowercase SHA", () => {
    expectAccepts(GitShaSchema, SHA_A);
  });

  it.each([
    ["empty", ""],
    ["abbreviated", SHA_A.slice(0, 7)],
    ["overlong", `${SHA_A}0`],
    ["uppercase", SHA_A.toUpperCase()],
    ["non-hex", `${SHA_A.slice(0, 39)}g`],
    ["not a string", null],
  ])("rejects %s", (_label, value) => {
    expectRejects(GitShaSchema, value);
  });
});

describe("Sha256HexSchema", () => {
  it("accepts a lowercase digest", () => {
    expectAccepts(Sha256HexSchema, SHA256);
  });

  it.each([
    ["empty", ""],
    ["short", SHA256.slice(0, 63)],
    ["overlong", `${SHA256}0`],
    ["uppercase", SHA256.toUpperCase()],
    ["git SHA", SHA_A],
  ])("rejects %s", (_label, value) => {
    expectRejects(Sha256HexSchema, value);
  });
});

describe("labelSchema", () => {
  const Label = labelSchema();

  it("trims surrounding whitespace", () => {
    expect(expectAccepts(Label, "  GC pauses  ")).toBe("GC pauses");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["overlong", "x".repeat(MAX_LABEL_LENGTH + 1)],
    ["newline", "line one\nline two"],
    ["escape character", "red\u001b[31m"],
    ["not a string", ["a"]],
  ])("rejects %s", (_label, value) => {
    expectRejects(Label, value);
  });

  it("honors a custom limit", () => {
    expectAccepts(labelSchema(4), "abcd");
    expectRejects(labelSchema(4), "abcde");
  });
});

describe("CommandLineSchema", () => {
  it("accepts a single command line", () => {
    expectAccepts(CommandLineSchema, "k6 run --quiet load/script.js");
  });

  it.each([
    ["empty", ""],
    ["overlong", "x".repeat(MAX_COMMAND_LENGTH + 1)],
    ["two lines", "echo ok\nrm -rf build"],
    ["carriage return", "echo ok\rrm -rf build"],
    ["NUL byte", "echo\u0000ok"],
  ])("rejects %s", (_label, value) => {
    expectRejects(CommandLineSchema, value);
  });
});

describe("RepoPathSchema", () => {
  it.each(["src/test/**", ".env*", "ufo.yaml", "a/b/c.ts"])("accepts %s", (path) => {
    expectAccepts(RepoPathSchema, path);
  });

  it.each([
    ["empty", ""],
    ["overlong", "a".repeat(MAX_PATH_LENGTH + 1)],
    ["absolute", "/etc/passwd"],
    ["parent segment", "src/../../etc"],
    ["backslash", "src\\main"],
    ["control character", "src/\u0007"],
  ])("rejects %s", (_label, value) => {
    expectRejects(RepoPathSchema, value);
  });
});

describe("BundleIdSchema", () => {
  it("accepts a bundle id", () => {
    expectAccepts(BundleIdSchema, "server-jvm-2026-10-17.1");
  });

  it.each([
    ["empty", ""],
    ["overlong", "a".repeat(129)],
    ["uppercase", "Server"],
    ["slash", "a/b"],
  ])("rejects %s", (_label, value) => {
    expectRejects(BundleIdSchema, value);
  });
});

describe("uniqueArray", () => {
  const Names = uniqueArray(z.string(), 3, (s) => s, "names");

  it("accepts unique values up to the limit", () => {
    expectAccepts(Names, ["a", "b", "c"]);
  });

  it("rejects duplicates and overlong arrays", () => {
    expectRejects(Names, ["a", "a"]);
    expectRejects(Names, ["a", "b", "c", "d"]);
  });
});

describe("idRecord", () => {
  const Values = idRecord(z.number());
  const entries = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, i]));

  it("accepts up to the entry limit", () => {
    expectAccepts(Values, entries(MAX_RECORD_ENTRIES));
  });

  it("rejects too many entries, bad keys, and bad values", () => {
    expectRejects(Values, entries(MAX_RECORD_ENTRIES + 1));
    expectRejects(Values, { "Not An Id": 1 });
    expectRejects(Values, { ok: "1" });
  });
});
