import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The release workflow (.github/workflows/release.yml) runs these scripts; a mistake in them
// shows only when a tag is pushed, so they are run here against throwaway directories.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ufo-release-"));
  dirs.push(dir);
  return dir;
}

function bash(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, IDENTITY_PATTERN: "", ...env },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/release-check.sh", () => {
  const CHANGELOG = [
    "# Changelog",
    "",
    "## [0.2.0] - 2026-11-01",
    "",
    "- Second.",
    "",
    "## 0.1.0",
    "",
    "### Added",
    "",
    "- First.",
    "",
  ].join("\n");

  /** A copy of the script in a directory with its own package.json and CHANGELOG.md. */
  function fixture(version: string, changelog = CHANGELOG): string {
    const dir = tempDir();
    mkdirSync(path.join(dir, "scripts"));
    copyFileSync(
      path.join(ROOT, "scripts", "release-check.sh"),
      path.join(dir, "scripts", "release-check.sh"),
    );
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version }));
    writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
    return path.join(dir, "scripts", "release-check.sh");
  }

  it("prints the version's section, without its heading, when the tag names the version", () => {
    expect(bash(fixture("0.2.0"), ["v0.2.0"], ROOT)).toEqual({
      status: 0,
      stdout: "- Second.\n",
      stderr: "",
    });
    expect(bash(fixture("0.1.0"), ["v0.1.0"], ROOT).stdout).toBe("### Added\n\n- First.\n");
  });

  it("refuses a tag that is not v plus package.json's version", () => {
    for (const tag of ["v0.1.1", "0.2.0", "v0.2.0-rc.1", "v0.2"]) {
      const result = bash(fixture("0.2.0"), [tag], ROOT);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `release-check: tag ${tag} does not match package.json version 0.2.0\n`,
      );
    }
  });

  it("refuses a version CHANGELOG.md has no section for", () => {
    const result = bash(fixture("0.3.0"), ["v0.3.0"], ROOT);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("release-check: CHANGELOG.md has no section for 0.3.0\n");
  });

  it("needs exactly one tag", () => {
    expect(bash(fixture("0.2.0"), [], ROOT).status).toBe(2);
    expect(bash(fixture("0.2.0"), ["v0.2.0", "extra"], ROOT).status).toBe(2);
  });

  it("passes for this repository's package.json version", () => {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const result = bash(path.join(ROOT, "scripts", "release-check.sh"), [`v${version}`], ROOT);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
  });
});

describe("scripts/identity-gate.sh --dir", () => {
  // A made-up pattern: these tests never see the real one.
  const env = { IDENTITY_PATTERN: "quokka-?zebra" };
  const gate = path.join(ROOT, "scripts", "identity-gate.sh");

  it("passes a directory with no match, outside any git work tree", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "package", "dist"), { recursive: true });
    writeFileSync(path.join(dir, "package", "dist", "index.js"), "export const a = 1;\n");
    const result = bash(gate, ["--dir", path.join(dir, "package")], dir, env);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "identity-gate: passed (paths and file contents under the directory).\n",
    );
  });

  it("fails on a match in a file's contents or name, and never prints the matched text", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "notes.txt"), "by Quokka Zebra\nby QUOKKAZEBRA\n");
    writeFileSync(path.join(dir, "dist", "quokkazebra.js"), "quokka-zebra\n");
    writeFileSync(path.join(dir, "dist", "clean.js"), "clean\n");
    const result = bash(gate, ["--dir", dir], dir, env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("match in file paths:\n  1 name(s)");
    expect(result.stderr).toContain("match in file contents:\n");
    expect(result.stderr).toContain("  dist/notes.txt\n");
    expect(result.stderr).toContain("  (name withheld: it matches the pattern)\n");
    expect(result.stderr).not.toContain("clean.js");
    expect(result.stderr).not.toMatch(/quokka|zebra/i);
  });

  it("refuses a missing directory and extra arguments", () => {
    const dir = tempDir();
    expect(bash(gate, ["--dir", path.join(dir, "missing")], dir, env).status).toBe(2);
    expect(bash(gate, ["--dir"], dir, env).status).toBe(2);
    expect(bash(gate, ["--dir", dir, "more"], dir, env).status).toBe(2);
  });
});

describe("scripts/release-tag-check.sh", () => {
  const script = path.join(ROOT, "scripts", "release-tag-check.sh");
  const TAGGER = "release@example.com";
  const TAG_SHA = "a".repeat(40);

  /**
   * A repository whose HEAD is on origin/main, and a fake `gh` that answers the tag ref and the
   * tag object as GitHub's API would after `--jq`, for the tag object `TAG_SHA` only.
   */
  function fixture(onMain = true) {
    const dir = tempDir();
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
    git("init", "--quiet");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "x",
    );
    const sha = git("rev-parse", "HEAD");
    if (onMain) git("update-ref", "refs/remotes/origin/main", sha);
    const bin = path.join(dir, ".bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$2" in',
        '  */git/ref/tags/v1.0.0) printf "%s\\n" "$FAKE_REF" ;;',
        `  */git/tags/${TAG_SHA}) printf "%s\\n" "$FAKE_TAG" ;;`,
        '  *) echo "gh: unexpected $2" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const run = (tag: { type?: string; target?: string; email?: string }) =>
      bash(script, ["v1.0.0"], dir, {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: sha,
        RELEASE_TAGGER_EMAIL: TAGGER,
        FAKE_REF: `tag ${TAG_SHA}`,
        FAKE_TAG: [tag.type ?? "commit", tag.target ?? sha, tag.email ?? TAGGER].join("\u001f"),
      });
    return { sha, run };
  }

  it("passes a tag by the release tagger at the released commit on main", () => {
    const { run } = fixture();
    expect(run({})).toMatchObject({ status: 0, stdout: "" });
  });

  it("refuses a tag at another commit, by another tagger, or off main", () => {
    const { sha, run } = fixture();
    const other = "b".repeat(40);
    for (const [tag, message] of [
      [{ target: other }, `points at commit ${other}, not the commit this run releases (${sha})`],
      [{ type: "tree" }, "points at tree"],
      [
        { email: "someone@example.com" },
        "tagged by 'someone@example.com', not release@example.com",
      ],
      [{ email: "" }, "tagged by '', not release@example.com"],
    ] as const) {
      const result = run(tag);
      expect(result.status, message).toBe(1);
      expect(result.stdout, message).toContain(message);
    }
    expect(fixture(false).run({})).toMatchObject({
      status: 1,
      stdout: "::error::v1.0.0 is not on main\n",
    });
  });

  it("needs exactly one tag and the release environment", () => {
    const dir = tempDir();
    expect(bash(script, [], dir).status).toBe(2);
    expect(bash(script, ["v1.0.0"], dir, { RELEASE_TAGGER_EMAIL: "" }).status).toBe(2);
  });
});
