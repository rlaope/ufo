import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `npm run build` once per test run: the CLI and MCP tests spawn dist/cli/index.js, what the
// package ships, and test files building it side by side would overwrite it under each other.
export default function setup(): void {
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: root, stdio: "pipe" },
  );
}
