import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Variables that would let the developer's own git setup leak into fixture repositories.
const ISOLATED_ENV = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "UFO_HOME",
];

export const TEST_NAME = "Test";
export const TEST_EMAIL = "test@example.invalid";

export interface Sandbox {
  /** Real path of a fresh temporary directory. */
  root: string;
  /** Restores the environment and deletes the directory. */
  restore: () => void;
}

/**
 * Points git at an empty global config and no system config for the rest of the test file, so
 * neither fixtures nor the code under test can read the developer's identity or settings.
 */
export function isolateGit(): Sandbox {
  const saved = new Map(ISOLATED_ENV.map((key) => [key, process.env[key]]));
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ufo-test-")));
  const globalConfig = path.join(root, "global.gitconfig");
  writeFileSync(globalConfig, "");
  for (const key of ISOLATED_ENV) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return {
    root,
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export const BASE_FILES: Record<string, string> = {
  "src/app.js": "export const delayMs = 5;\nexport function handle() {\n  return 'ok';\n}\n",
  "test/app.test.js": "import { handle } from '../src/app.js';\nhandle();\n",
  "package.json": '{ "name": "toy" }\n',
};

/** A repository with one commit and the test identity in its local config. */
export function makeRepo(parent: string, name: string, files = BASE_FILES): string {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "--quiet", "--initial-branch=main");
  gitIn(dir, "config", "user.name", TEST_NAME);
  gitIn(dir, "config", "user.email", TEST_EMAIL);
  writeFiles(dir, files);
  gitIn(dir, "add", "--all");
  gitIn(dir, "commit", "--quiet", "--message", "initial");
  return dir;
}
