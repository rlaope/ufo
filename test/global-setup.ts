import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds the package once per test run, into a temporary directory laid out as it is installed
// (dist/, package.json, the built-in cards, node_modules), so the CLI and MCP tests spawn what
// the package ships and the working tree's dist/ is never rewritten under a running test. The
// tests find the built CLI in UFO_TEST_BUILT_CLI.
export default function setup(): () => void {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pkg = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ufo-test-pkg-")));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.build.json",
        "--outDir",
        path.join(pkg, "dist"),
      ],
      { cwd: root, stdio: "pipe", encoding: "utf8" },
    );
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    process.stderr.write(`${stdout}${stderr}`);
    rmSync(pkg, { recursive: true, force: true });
    throw new Error("tsc -p tsconfig.build.json failed; its output is above");
  }
  copyFileSync(path.join(root, "package.json"), path.join(pkg, "package.json"));
  cpSync(path.join(root, "src", "techniques"), path.join(pkg, "src", "techniques"), {
    recursive: true,
    filter: (source) => !source.endsWith(".ts"),
  });
  symlinkSync(path.join(root, "node_modules"), path.join(pkg, "node_modules"));
  process.env.UFO_TEST_BUILT_CLI = path.join(pkg, "dist", "cli", "index.js");
  return () => rmSync(pkg, { recursive: true, force: true });
}
