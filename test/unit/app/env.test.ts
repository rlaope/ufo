import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureEnv,
  captureGitEnv,
  describeDefaultEnv,
  processPath,
  safePath,
  secretLikeNames,
  trustProcessPath,
} from "../../../src/app/index.js";

// Security F9: the run's command environment is an allowlist captured at start.

const LAUNCHER = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/someone",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "UTF-8",
  TMPDIR: "/tmp",
  USER: "someone",
  SHELL: "/bin/zsh",
  TERM: "xterm",
  OPENAI_API_KEY: "sk-not-for-commands",
  AWS_SECRET_ACCESS_KEY: "secret",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  JAVA_HOME: "/opt/jdk",
  GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
  NODE_OPTIONS: "--require /tmp/x.js",
};

describe("captureEnv", () => {
  it("keeps the defaults, every LC_*, and listed names, and nothing else", () => {
    expect(captureEnv(LAUNCHER, [])).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/tmp",
      USER: "someone",
      SHELL: "/bin/zsh",
      TERM: "xterm",
    });
    expect(captureEnv(LAUNCHER, ["JAVA_HOME", "MISSING"])).toMatchObject({ JAVA_HOME: "/opt/jdk" });
    expect(Object.keys(captureEnv(LAUNCHER, ["JAVA_HOME"]))).not.toContain("MISSING");
  });

  it("keeps the git configuration variables for the worker's own git only", () => {
    expect(captureGitEnv(LAUNCHER)).toEqual({ GIT_CONFIG_GLOBAL: "/tmp/gitconfig" });
    expect(Object.keys(captureEnv(LAUNCHER, []))).not.toContain("GIT_CONFIG_GLOBAL");
  });

  it("names the defaults for the approval review", () => {
    expect(describeDefaultEnv()).toBe("PATH, HOME, LANG, TMPDIR, USER, SHELL, TERM, LC_*");
  });
});

describe("safePath (security N4)", () => {
  it("drops relative entries and entries inside the repository or UFO's home", () => {
    const value = [
      "/usr/bin",
      "node_modules/.bin",
      "",
      "/repo/bin",
      "/repo",
      "/home/u/.ufo/x",
      "/opt/tools",
    ].join(path.delimiter);
    expect(safePath(value, ["/repo", "/home/u/.ufo"])).toBe(
      ["/usr/bin", "/opt/tools"].join(path.delimiter),
    );
  });

  it("is applied to PATH when the environment is captured", () => {
    const env = captureEnv({ PATH: `./bin${path.delimiter}/usr/bin` }, [], ["/repo"]);
    expect(env.PATH).toBe("/usr/bin");
  });
});

// Security H1: npx and npm scripts put a project's node_modules/.bin, and its parents', first on
// the PATH UFO starts with; UFO's own git, ps, and docker are never found there.
describe("processPath", () => {
  it("also drops every entry with a node_modules segment", () => {
    const value = ["/usr/bin", "/p/node_modules/.bin", "/node_modules/x/bin", "/opt/bin"].join(
      path.delimiter,
    );
    expect(processPath(value, [])).toBe(["/usr/bin", "/opt/bin"].join(path.delimiter));
    expect(processPath(value, ["/opt"])).toBe("/usr/bin");
  });
});

describe("trustProcessPath", () => {
  // Security N3: every working tree around it, not only the one git finds first.
  it("drops the working trees around the working directory before git finds them", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-path-")));
    try {
      // Working trees as git would find them from a subdirectory, a submodule inside a
      // superproject; no git runs to find them.
      mkdirSync(path.join(root, "project", ".git"), { recursive: true });
      mkdirSync(path.join(root, "project", "module", ".git"), { recursive: true });
      mkdirSync(path.join(root, "project", "module", "sub"), { recursive: true });
      const env: NodeJS.ProcessEnv = {
        UFO_HOME: path.join(root, "ufo-home"),
        PATH: [
          path.join(root, "project", "tools"),
          path.join(root, "project", "module", "tools"),
          path.join(root, "parent", "node_modules", ".bin"),
          path.join(root, "ufo-home", "bin"),
          "relative/bin",
          "",
          "/usr/bin",
        ].join(path.delimiter),
      };
      const { repo, dropped } = await trustProcessPath({
        cwd: path.join(root, "project", "module", "sub"),
        env,
      });
      expect(repo).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
      expect(dropped).toHaveLength(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Code review CR-N1: started in your home, or under a home that is itself a repository
  // (dotfiles), UFO keeps the tools installed there; a project's .bin is still dropped.
  it("never drops your home directory or what is installed under it", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-path-")));
    const home = path.join(root, "home");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      mkdirSync(path.join(home, ".git"), { recursive: true });
      mkdirSync(path.join(home, "project"), { recursive: true });
      const installed = [path.join(home, ".nvm", "bin"), path.join(home, ".cargo", "bin")];
      const entries = [
        ...installed,
        path.join(home, "project", "tools"),
        path.join(home, "project", "node_modules", ".bin"),
        "/usr/bin",
      ];
      for (const cwd of [path.join(home, "project"), home]) {
        const env: NodeJS.ProcessEnv = {
          UFO_HOME: path.join(root, "ufo-home"),
          PATH: entries.join(path.delimiter),
        };
        await trustProcessPath({ cwd, env });
        const kept =
          cwd === home
            ? [...installed, path.join(home, "project", "tools"), "/usr/bin"]
            : [...installed, "/usr/bin"];
        expect(env.PATH, cwd).toBe(kept.join(path.delimiter));
      }
    } finally {
      homedir.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Code review CR-N1: a linked worktree's main checkout is the repository too.
  it("drops the main checkout of a linked worktree, read from its .git file", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-path-")));
    try {
      mkdirSync(path.join(root, "main", ".git", "worktrees", "wt"), { recursive: true });
      mkdirSync(path.join(root, "wt"), { recursive: true });
      writeFileSync(
        path.join(root, "wt", ".git"),
        `gitdir: ${path.join(root, "main", ".git", "worktrees", "wt")}\n`,
      );
      const env: NodeJS.ProcessEnv = {
        UFO_HOME: path.join(root, "ufo-home"),
        PATH: [path.join(root, "main", "tools"), "/usr/bin"].join(path.delimiter),
      };
      await trustProcessPath({ cwd: path.join(root, "wt"), env });
      expect(env.PATH).toBe("/usr/bin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("secretLikeNames", () => {
  it("flags names that look like secrets", () => {
    expect(
      secretLikeNames(["JAVA_HOME", "OPENAI_API_KEY", "GH_TOKEN", "AWS_REGION", "TOY_NOISE"]),
    ).toEqual(["OPENAI_API_KEY", "GH_TOKEN", "AWS_REGION"]);
  });
});
