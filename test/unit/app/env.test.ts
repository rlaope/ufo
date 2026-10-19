import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureEnv,
  captureGitEnv,
  describeDefaultEnv,
  safePath,
  secretLikeNames,
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

describe("secretLikeNames", () => {
  it("flags names that look like secrets", () => {
    expect(
      secretLikeNames(["JAVA_HOME", "OPENAI_API_KEY", "GH_TOKEN", "AWS_REGION", "TOY_NOISE"]),
    ).toEqual(["OPENAI_API_KEY", "GH_TOKEN", "AWS_REGION"]);
  });
});
