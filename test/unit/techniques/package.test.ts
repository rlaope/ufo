import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  });
});
