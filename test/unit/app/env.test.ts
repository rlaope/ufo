import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bindRepository,
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

  // Code review M1 (with R5): a repository at your home (dotfiles) is no project: neither it nor
  // what is installed under your home is dropped, from your home or a folder under it, and it is
  // none of the project roots setup checks its UFO home against. A worktree of it keeps them too.
  it("keeps what is under your home when your home is a repository", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-path-")));
    const home = path.join(root, "home");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      mkdirSync(path.join(home, "notes"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: home, stdio: "ignore" });
      git("init", "--quiet");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "x",
      );
      git("worktree", "add", "--quiet", "--detach", path.join(home, "wt"));
      const installed = path.join(home, ".local", "bin");
      for (const cwd of [home, path.join(home, "notes"), path.join(home, "wt")]) {
        const env: NodeJS.ProcessEnv = {
          UFO_HOME: path.join(home, ".ufo"),
          PATH: [installed, "/usr/bin"].join(path.delimiter),
        };
        const { repo, projectRoots } = await trustProcessPath({ cwd, env });
        expect(env.PATH, cwd).toBe([installed, "/usr/bin"].join(path.delimiter));
        expect(projectRoots, cwd).not.toContain(home);
        if (cwd === path.join(home, "wt")) expect(repo?.root).toBe(cwd);
        else expect(repo, cwd).toBeUndefined();
      }
      // Code review F1: a bind that refuses it (ufo mcp) leaves PATH as it was, for later runs.
      const env: NodeJS.ProcessEnv = {
        UFO_HOME: path.join(home, ".ufo"),
        PATH: [installed, "/usr/bin"].join(path.delimiter),
      };
      const notes = path.join(home, "notes");
      await expect(
        bindRepository({ dir: notes, cwd: notes, env, requireRepo: true }),
      ).rejects.toMatchObject({ code: "not_a_repo" });
      expect(env.PATH).toBe([installed, "/usr/bin"].join(path.delimiter));
    } finally {
      homedir.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Code review CR-N1: a linked worktree's main checkout is the repository too.
  it("drops the main checkout of a linked worktree, read from its .git file", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-path-")));
    try {
      const linked = path.join(root, "main", ".git", "worktrees", "wt");
      mkdirSync(linked, { recursive: true });
      mkdirSync(path.join(root, "wt"), { recursive: true });
      writeFileSync(path.join(root, "wt", ".git"), `gitdir: ${linked}\n`);
      writeFileSync(path.join(linked, "gitdir"), `${path.join(root, "wt", ".git")}\n`);
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

  // Security S2-6: a .git file names a main checkout only as a linked worktree's git directory
  // that names it back; any other directory it names stays on PATH.
  it("keeps a directory a .git file names unless it is the worktree's main checkout", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-path-")));
    try {
      const dotGit = path.join(root, "project", ".git");
      // Not a worktree's git directory, though it names the .git file back.
      const submodule = path.join(root, "sys", "bin", ".git", "modules", "x");
      mkdirSync(submodule, { recursive: true });
      writeFileSync(path.join(submodule, "gitdir"), `${dotGit}\n`);
      // Worktrees' git directories that do not name it back: no link, and one to elsewhere.
      const unlinked = path.join(root, "other", ".git", "worktrees", "project");
      const elsewhere = path.join(root, "other", ".git", "worktrees", "elsewhere");
      mkdirSync(unlinked, { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      mkdirSync(path.join(root, "elsewhere"), { recursive: true });
      writeFileSync(path.join(elsewhere, "gitdir"), `${path.join(root, "elsewhere", ".git")}\n`);
      mkdirSync(path.join(root, "project"), { recursive: true });
      const entries = [
        path.join(root, "sys", "bin"),
        path.join(root, "other", "tools"),
        "/usr/bin",
      ];
      for (const named of [submodule, unlinked, elsewhere]) {
        writeFileSync(dotGit, `gitdir: ${named}\n`);
        const env: NodeJS.ProcessEnv = {
          UFO_HOME: path.join(root, "ufo-home"),
          PATH: entries.join(path.delimiter),
        };
        await trustProcessPath({ cwd: path.join(root, "project"), env });
        expect(env.PATH, named).toBe(entries.join(path.delimiter));
      }
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
