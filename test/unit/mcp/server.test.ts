import { describe, expect, it } from "vitest";
import { bindDirectory, isHost } from "../../../src/mcp/server.js";

// M2 B3 (security H2): the server is bound to one repository at startup, by its host's
// convention; no tool input changes it.

const env = { CLAUDE_PROJECT_DIR: "/projects/claude" };

describe("the directory ufo mcp binds to", () => {
  // Security S2-1: with the directories the agent's session works in, the working directory
  // among them unless --repo named the directory (a host that needs it may start servers anywhere).
  it("is --repo for every host when given", () => {
    for (const host of ["claude-code", "codex", "cursor"] as const) {
      expect(bindDirectory({ host, repo: "/projects/given", env, cwd: "/cwd" })).toEqual({
        dir: "/projects/given",
        session: ["/projects/given"],
      });
    }
  });

  it("is CLAUDE_PROJECT_DIR, else the working directory, for Claude Code", () => {
    expect(bindDirectory({ host: "claude-code", env, cwd: "/cwd" })).toEqual({
      dir: "/projects/claude",
      session: ["/projects/claude", "/cwd"],
    });
    expect(
      bindDirectory({ host: "claude-code", env: { CLAUDE_PROJECT_DIR: "" }, cwd: "/cwd" }),
    ).toEqual({ dir: "/cwd", session: ["/cwd"] });
  });

  it("is the working directory for Codex, whatever CLAUDE_PROJECT_DIR says", () => {
    expect(bindDirectory({ host: "codex", env, cwd: "/cwd" })).toEqual({
      dir: "/cwd",
      session: ["/cwd"],
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

describe("the hosts", () => {
  it("are claude-code, codex, and cursor", () => {
    expect(["claude-code", "codex", "cursor"].every(isHost)).toBe(true);
    expect(isHost("vscode")).toBe(false);
    expect(isHost(undefined)).toBe(false);
  });
});
