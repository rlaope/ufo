import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NODE_EXIT_ON_SIGNAL } from "../../../src/app/profiler.js";
import { BUILTIN_CARDS_DIR } from "../../../src/techniques/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("the npm package", () => {
  it("ships every built-in card where the built registry looks for it", { timeout: 60_000 }, () => {
    const cards = readdirSync(BUILTIN_CARDS_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)));
    expect(cards).toContain(path.join("src", "techniques", "generic", "code-change.yaml"));
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as { files: { path: string }[] }[];
    const files = new Set(packed[0]?.files.map((file) => file.path));
    for (const card of cards) expect(files).toContain(card.split(path.sep).join("/"));
    // The node-cpu preset's preload, where the built app looks for it.
    expect(files).toContain(path.relative(ROOT, NODE_EXIT_ON_SIGNAL).split(path.sep).join("/"));
  });

  // M7 L5: `npx --package <tgz> ufo-agents` runs the bin named ufo-agents, and `npx ufo-agents`
  // the one named like the package (https://docs.npmjs.com/cli/v11/commands/npm-exec).
  it("installs ufo and ufo-agents, both the built CLI, from a directory the package ships", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      files: string[];
    };
    expect(pkg.bin).toEqual({ ufo: "dist/cli/index.js", [pkg.name]: "dist/cli/index.js" });
    expect(pkg.files).toContain("dist");
    const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { bin?: Record<string, string> }>;
    };
    expect(lock.packages[""]?.bin).toEqual(pkg.bin);
  });
});
