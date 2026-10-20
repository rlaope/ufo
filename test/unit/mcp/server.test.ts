import { describe, expect, it } from "vitest";
import { defaultRepository, hostAgentOf } from "../../../src/mcp/server.js";

describe("the server's default repository", () => {
  // M2 B0: no host documents the stdio server's working directory.
  it("is --repo, else CLAUDE_PROJECT_DIR, else the working directory", () => {
    const env = { CLAUDE_PROJECT_DIR: "/projects/claude" };
    expect(defaultRepository({ repo: "/projects/cursor", env, cwd: "/cwd" })).toBe(
      "/projects/cursor",
    );
    expect(defaultRepository({ repo: "sub", env, cwd: "/cwd" })).toBe("/cwd/sub");
    expect(defaultRepository({ env, cwd: "/cwd" })).toBe("/projects/claude");
    expect(defaultRepository({ env: { CLAUDE_PROJECT_DIR: "" }, cwd: "/cwd" })).toBe("/cwd");
    expect(defaultRepository({ env: {}, cwd: "/cwd" })).toBe("/cwd");
  });
});

describe("the host agent of a run", () => {
  it("is the MCP client's name as an id, or mcp", () => {
    expect(hostAgentOf("claude-code")).toBe("claude-code");
    expect(hostAgentOf("Codex CLI")).toBe("codex-cli");
    expect(hostAgentOf("  Cursor (vscode) ")).toBe("cursor-vscode");
    expect(hostAgentOf("123")).toBe("mcp");
    expect(hostAgentOf(undefined)).toBe("mcp");
    expect(hostAgentOf("x".repeat(100))).toHaveLength(64);
  });
});
