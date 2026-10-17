import { describe, expect, it } from "vitest";
import {
  checkPaths,
  checkProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
  LOCKFILE_PATHS,
  protectedPathsFor,
} from "../../../src/core/policy/index.js";
import { labelSchema, MAX_NOTE_LENGTH } from "../../../src/domain/index.js";

function modify(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
}

const DEFAULTS = protectedPathsFor("lossless", []);

describe("checkProtectedPaths (AC 3)", () => {
  it.each([
    "test/app.test.js",
    "src/__tests__/handler.ts",
    "pkg/api/handler_test.go",
    "tests/test_api.py",
    "src/test/java/AppTest.java",
    "spec/models/user_spec.rb",
    "web/src/__snapshots__/page.snap",
    "vitest.config.ts",
    "benchmarks/load.js",
    "ufo.yaml",
    "services/api/ufo.yaml",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    ".env",
    ".env.production",
    "config/server.pem",
    "deploy/id_ed25519",
    ".npmrc",
    "package-lock.json",
    "Cargo.lock",
    "TESTS/Upper.case.js",
  ])("rejects a patch that edits %s", (file) => {
    const violation = checkProtectedPaths(modify(file), DEFAULTS);
    expect(violation).toMatchObject({ rule: "protected_path", subjects: [file] });
  });

  it.each([
    "src/app.js",
    "src/latest.ts",
    "lib/contest.py",
    "README.md",
    "Dockerfile",
    "build.gradle",
  ])("accepts a patch that edits %s", (file) => {
    expect(checkProtectedPaths(modify(file), DEFAULTS)).toBeUndefined();
  });

  it("rejects deleting a test and renaming a test away", () => {
    const deletion = [
      "diff --git a/test/app.test.js b/test/app.test.js",
      "deleted file mode 100644",
      "--- a/test/app.test.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-a",
      "",
    ].join("\n");
    expect(checkProtectedPaths(deletion, DEFAULTS)?.rule).toBe("protected_path");
    const rename = [
      "diff --git a/test/slow.js b/src/slow.js",
      "similarity index 100%",
      "rename from test/slow.js",
      "rename to src/slow.js",
      "",
    ].join("\n");
    expect(checkProtectedPaths(rename, DEFAULTS)?.subjects).toEqual(["test/slow.js"]);
  });

  it("rejects the -p0 trick that hides a test path behind a slash-free file", () => {
    const diff = [
      "--- README",
      "+++ README",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- tests/helper.js",
      "+++ tests/helper.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(checkProtectedPaths(diff, DEFAULTS)?.subjects).toEqual(["tests/helper.js"]);
  });

  it("rejects a patch whose file names cannot be read", () => {
    const diff = ["diff --git a/x b/y", "index 1..2 100644", "Binary files differ", ""].join("\n");
    expect(checkProtectedPaths(diff, DEFAULTS)?.rule).toBe("protected_path");
  });

  it("protects configured globs, including directories without a trailing glob", () => {
    expect(checkProtectedPaths(modify("perf/run.sh"), [...DEFAULTS, "perf/"])?.rule).toBe(
      "protected_path",
    );
    expect(checkProtectedPaths(modify("perf/run.sh"), DEFAULTS)).toBeUndefined();
  });

  it("lets only an approved upgrade card change lockfiles", () => {
    const diff = modify("package-lock.json");
    expect(checkProtectedPaths(diff, protectedPathsFor("upgrade", []))?.rule).toBe(
      "protected_path",
    );
    expect(checkProtectedPaths(diff, protectedPathsFor("lossy", ["lossy", "upgrade"]))?.rule).toBe(
      "protected_path",
    );
    expect(checkProtectedPaths(diff, protectedPathsFor("upgrade", ["upgrade"]))).toBeUndefined();
    expect(DEFAULT_PROTECTED_PATHS).not.toContain(LOCKFILE_PATHS[0]);
  });

  it("rejects paths outside the monorepo scope", () => {
    const scope = ["services/api"];
    expect(checkProtectedPaths(modify("services/api/src/a.js"), DEFAULTS, scope)).toBeUndefined();
    expect(checkProtectedPaths(modify("services/web/src/a.js"), DEFAULTS, scope)).toMatchObject({
      rule: "out_of_scope",
      subjects: ["services/web/src/a.js"],
    });
  });
});

describe("checkPaths", () => {
  it("treats paths that leave the repository as protected", () => {
    expect(checkPaths(["../outside.js"], [])?.rule).toBe("protected_path");
    expect(checkPaths(["/etc/hosts"], [])?.rule).toBe("protected_path");
    expect(checkPaths(["src/../ufo.yaml"], DEFAULTS)?.subjects).toEqual(["ufo.yaml"]);
  });

  it("produces a detail that fits a decision", () => {
    const many = Array.from({ length: 500 }, (_, i) => `test/case-${i}-${"x".repeat(20)}.js`);
    const violation = checkPaths(many, DEFAULTS);
    expect(violation?.subjects).toHaveLength(500);
    expect(labelSchema(MAX_NOTE_LENGTH).safeParse(violation?.detail).success).toBe(true);
  });
});
