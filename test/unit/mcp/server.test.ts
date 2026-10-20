import { describe, expect, it } from "vitest";
import type { Repo } from "../../../src/app/index.js";
import { bindDirectory, bindingFor, isHost } from "../../../src/mcp/server.js";

// M2 B3 (security H2): the server is bound to one repository at startup, by its host's
// convention; no tool input changes it.

const env = { CLAUDE_PROJECT_DIR: "/projects/claude" };

describe("the directory ufo mcp binds to", () => {
  // Security S2-1, S2-2: with where it came from; the working directory is the session's only when
  // it is the bound one.
  it("is --repo for every host when given", () => {
    for (const host of ["claude-code", "codex", "cursor"] as const) {
      expect(bindDirectory({ host, repo: "/projects/given", env, cwd: "/cwd" })).toEqual({
        dir: "/projects/given",
        from: "repo-flag",
      });
    }
  });

  it("is CLAUDE_PROJECT_DIR, else the working directory, for Claude Code", () => {
    expect(bindDirectory({ host: "claude-code", env, cwd: "/cwd" })).toEqual({
      dir: "/projects/claude",
      from: "project-env",
    });
    expect(
      bindDirectory({ host: "claude-code", env: { CLAUDE_PROJECT_DIR: "" }, cwd: "/cwd" }),
    ).toEqual({ dir: "/cwd", from: "cwd" });
  });

  it("is the working directory for Codex, whatever CLAUDE_PROJECT_DIR says", () => {
    expect(bindDirectory({ host: "codex", env, cwd: "/cwd" })).toEqual({
      dir: "/cwd",
      from: "cwd",
    });
  });

  it("needs --repo for Cursor", () => {
    expect(bindDirectory({ host: "cursor", env, cwd: "/cwd" })).toEqual({
      error: "--host cursor needs --repo <absolute path>",
    });
  });

  // A relative path is never resolved against the working directory, and a placeholder the host
  // did not substitute is not a path.
  it("refuses a relative path and a workspaceFolder placeholder left in", () => {
    expect(bindDirectory({ host: "cursor", repo: "sub/dir", env, cwd: "/cwd" })).toEqual({
      error: '--repo must be an absolute path, not "sub/dir"',
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal a host failed to substitute
    const literal = "${workspaceFolder}";
    expect(bindDirectory({ host: "cursor", repo: literal, env, cwd: "/cwd" })).toEqual({
      error: `--repo must be an absolute path, not "${literal}"`,
    });
    expect(
      bindDirectory({ host: "claude-code", env: { CLAUDE_PROJECT_DIR: "rel" }, cwd: "/cwd" }),
    ).toEqual({ error: 'CLAUDE_PROJECT_DIR must be an absolute path, not "rel"' });
  });
});

// Code review R4: calls that arrive together before the first bind share one; a failed bind is
// tried again by the next call, and the pinned repository is what the workflows get.
describe("a late binding", () => {
  it("binds once for calls that arrive together, and again after a failure", async () => {
    const repo = { root: "/projects/late" } as Repo;
    let binds = 0;
    let fail = true;
    const binding = bindingFor("/projects/late", undefined, async () => {
      binds += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (fail) throw new Error("not yet");
      return repo;
    });
    await expect(Promise.all([binding.guard(), binding.guard()])).rejects.toThrow("not yet");
    expect(binds).toBe(1);
    fail = false;
    await Promise.all([binding.guard(), binding.guard(), binding.guard()]);
    expect(binds).toBe(2);
    expect(binding.repo()).toBe(repo);
    expect(binding.root()).toBe("/projects/late");
  });
});

describe("the hosts", () => {
  it("are claude-code, codex, and cursor", () => {
    expect(["claude-code", "codex", "cursor"].every(isHost)).toBe(true);
    expect(isHost("vscode")).toBe(false);
    expect(isHost(undefined)).toBe(false);
  });
});
