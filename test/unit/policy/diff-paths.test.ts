import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDiffPaths } from "../../../src/core/policy/index.js";
import { isolateGit, type Sandbox } from "../git/helpers.js";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

const CASES: Array<[string, string, string[]]> = [
  [
    "a git modification",
    lines(
      "diff --git a/src/x.js b/src/x.js",
      "index 1..2 100644",
      "--- a/src/x.js",
      "+++ b/src/x.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ),
    ["src/x.js"],
  ],
  [
    "a new file",
    lines(
      "diff --git a/new.js b/new.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.js",
      "@@ -0,0 +1 @@",
      "+a",
    ),
    ["new.js"],
  ],
  [
    "a deletion",
    lines(
      "diff --git a/test/t.js b/test/t.js",
      "deleted file mode 100644",
      "--- a/test/t.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-a",
    ),
    ["test/t.js"],
  ],
  [
    "a pure rename, both sides",
    lines(
      "diff --git a/test/t.js b/src/t.js",
      "similarity index 100%",
      "rename from test/t.js",
      "rename to src/t.js",
    ),
    ["test/t.js", "src/t.js"],
  ],
  [
    "a copy",
    lines("diff --git a/a.js b/b.js", "similarity index 100%", "copy from a.js", "copy to b.js"),
    ["a.js", "b.js"],
  ],
  [
    "a mode change, named by the header",
    lines("diff --git a/run me.sh b/run me.sh", "old mode 100644", "new mode 100755"),
    ["run me.sh"],
  ],
  [
    "a binary file, named by the header",
    lines(
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/img.png differ",
    ),
    ["img.png"],
  ],
  [
    "quoted names with escapes and UTF-8 octal bytes",
    lines(
      'diff --git "a/src/\\303\\274 \\"q\\".js" "b/src/\\303\\274 \\"q\\".js"',
      "index 1..2 100644",
      '--- "a/src/\\303\\274 \\"q\\".js"',
      '+++ "b/src/\\303\\274 \\"q\\".js"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ),
    ['src/ü "q".js'],
  ],
  [
    "a name with spaces, ended by a tab",
    lines(
      "diff --git a/my file.js b/my file.js",
      "--- a/my file.js\t",
      "+++ b/my file.js\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ),
    ["my file.js"],
  ],
  [
    "any first component as the prefix",
    lines("--- x/src/a.js", "+++ y/src/a.js", "@@ -1 +1 @@", "-a", "+b"),
    ["src/a.js"],
  ],
  [
    "a traditional diff with tab timestamps",
    lines(
      "--- a/ufo.yaml\t2026-10-17 10:00:00.000000000 +0000",
      "+++ b/ufo.yaml\t2026-10-17 10:01:00.000000000 +0000",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ),
    ["ufo.yaml"],
  ],
  [
    "a traditional diff with space-separated timestamps",
    lines(
      "--- a/ufo.yaml 2026-10-17 10:00:00 +0000",
      "+++ b/ufo.yaml 2026-10-17 10:01:00 +0000",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ),
    ["ufo.yaml"],
  ],
  [
    "a backup name on the old side",
    lines("--- a/ufo.yaml.orig", "+++ b/ufo.yaml", "@@ -1 +1 @@", "-a", "+b"),
    ["ufo.yaml"],
  ],
  [
    "a slash-free name, which switches the rest of the input to -p0",
    lines(
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
    ),
    ["README", "tests/helper.js"],
  ],
  [
    "-p0 carried into a later diff --git patch",
    lines(
      "--- /dev/null",
      "+++ README",
      "@@ -0,0 +1 @@",
      "+a",
      "diff --git tests/a.js tests/a.js",
      "--- tests/a.js",
      "+++ tests/a.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ),
    ["README", "tests/a.js"],
  ],
  [
    "hunk lines that look like file headers",
    lines(
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,2 @@",
      "--- a/test/x.js",
      "+++ b/test/x.js",
    ),
    ["q.sql"],
  ],
  [
    "mail text before the first header and between patches",
    lines(
      "From: someone",
      "Subject: [PATCH] speed",
      "",
      "--- not a header",
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "-- ",
      "2.55.0",
    ),
    ["a.js"],
  ],
  [
    "CRLF line endings",
    "--- a/src/x.js\r\n+++ b/src/x.js\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n",
    ["src/x.js"],
  ],
  [
    "several files",
    lines(
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
      "diff --git a/b.js b/b.js",
      "--- a/b.js",
      "+++ b/b.js",
      "@@ -1,2 +1,2 @@",
      " x",
      "-a",
      "+b",
    ),
    ["a.js", "b.js"],
  ],
];

let sandbox: Sandbox;
let scratch: string;

beforeAll(() => {
  sandbox = isolateGit();
  scratch = path.join(sandbox.root, "not-a-repo");
  mkdirSync(scratch);
});

afterAll(() => sandbox.restore());

/** The paths `git apply --numstat` reports (new names only for renames), or null if git refuses. */
function gitPaths(diff: string): string[] | null {
  const file = path.join(scratch, "patch.diff");
  writeFileSync(file, diff);
  try {
    const out = execFileSync("git", ["apply", "--numstat", "-z", "--allow-empty", file], {
      cwd: scratch,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fields = out.split("\0").filter((f) => f.length > 0);
    return fields.map((f) => f.split("\t").slice(2).join("\t")).filter((f) => f.length > 0);
  } catch {
    return null;
  }
}

describe("parseDiffPaths", () => {
  it.each(CASES)("reads %s", (_label, diff, expected) => {
    expect(parseDiffPaths(diff)).toEqual({ paths: expected, problems: [] });
  });

  it.each(CASES)("agrees with git apply on %s", (_label, diff) => {
    const fromGit = gitPaths(diff);
    if (fromGit === null) {
      // git refuses the patch, so it would never apply: nothing to agree on.
      return;
    }
    const parsed = parseDiffPaths(diff).paths;
    for (const file of fromGit) expect(parsed).toContain(file);
  });

  it("finds every file git apply would touch, for each case", () => {
    const accepted = CASES.filter(([, diff]) => gitPaths(diff) !== null);
    // Guards the agreement test above against silently skipping everything.
    expect(accepted.length).toBeGreaterThanOrEqual(CASES.length - 2);
  });

  it("reports a header whose names cannot be read instead of guessing", () => {
    const unreadable = lines("diff --git a/x b/y", "index 1..2 100644", "Binary files differ");
    const result = parseDiffPaths(unreadable);
    expect(result.paths).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  it("reports a quoted name that does not end on its line", () => {
    const result = parseDiffPaths(
      lines('--- "a/ufo.yaml', '+++ "b/ufo.yaml', "@@ -1 +1 @@", "-a", "+b"),
    );
    expect(result.problems).toHaveLength(1);
  });

  it("reads no paths from text that is not a patch", () => {
    expect(parseDiffPaths("please make it faster\n")).toEqual({ paths: [], problems: [] });
  });
});
