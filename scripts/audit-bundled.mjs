// Audits the packages that UFO's runtime dependencies bundle inside their own files, which
// `npm audit` cannot see: the MCP SDK's server package ships ajv and fast-uri in its dist/. A
// bundle's source maps name each copy by the path it was built from (`.pnpm/<name>@<version>/`),
// and each copy found is looked up in OSV (https://osv.dev). Exits 1 when a copy has an advisory
// that is not accepted below. A bundle shipped without source maps, or built from other paths,
// is not seen; check a new runtime dependency's files by hand. Run it before a release:
// `npm run audit:deps` (npm audit of the runtime tree, then this).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Advisories reviewed and accepted, by id, each with why it does not reach UFO. */
const ACCEPTED = {};

const COPY = /node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@(\d[^/_]*)/;

function mapFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : mapFiles(file);
    return entry.name.endsWith(".map") ? [file] : [];
  });
}

// The installed runtime tree, the package's own directory first.
const tree = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .slice(1);

const copies = new Map();
for (const dir of tree) {
  const owner = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
  for (const file of mapFiles(dir)) {
    let sources;
    try {
      sources = JSON.parse(readFileSync(file, "utf8")).sources ?? [];
    } catch {
      continue;
    }
    for (const source of sources) {
      const match = COPY.exec(source);
      if (match === null) continue;
      const name = match[1].replace("+", "/");
      const key = `${name}@${match[2]}`;
      if (!copies.has(key)) copies.set(key, { name, version: match[2], in: new Set() });
      copies.get(key).in.add(owner);
    }
  }
}

const list = [...copies.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const copy of list) {
  console.log(`bundled: ${copy.name}@${copy.version} (in ${[...copy.in].join(", ")})`);
}
// `--list`: the copies only, without asking OSV.
if (list.length === 0 || process.argv.includes("--list")) {
  if (list.length === 0) console.log("no bundled copies found");
  process.exit(0);
}

const response = await fetch("https://api.osv.dev/v1/querybatch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    queries: list.map((copy) => ({
      package: { ecosystem: "npm", name: copy.name },
      version: copy.version,
    })),
  }),
});
if (!response.ok) throw new Error(`OSV answered ${response.status}`);
const { results } = await response.json();

let open = 0;
list.forEach((copy, index) => {
  for (const { id } of results[index]?.vulns ?? []) {
    const accepted = ACCEPTED[id];
    console.log(
      `${accepted === undefined ? "ADVISORY" : "accepted"}: ${copy.name}@${copy.version} ${id} https://osv.dev/vulnerability/${id}${accepted === undefined ? "" : ` (${accepted})`}`,
    );
    if (accepted === undefined) open++;
  }
});
if (open > 0) {
  console.log(
    `${open} advisories in bundled copies: update the dependency that bundles them, or review each and accept it in ACCEPTED in scripts/audit-bundled.mjs with the reason`,
  );
  process.exit(1);
}
console.log("no open advisories in bundled copies");
