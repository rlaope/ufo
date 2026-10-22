import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTextRedactor } from "../../../src/core/evidence/index.js";
import {
  displayName,
  type FileHotspots,
  heaviestFiles,
  hotFrames,
  MAX_BUNDLE_ENTRIES,
  MAX_NAME_BYTES,
  MAX_PROFILE_BYTES,
  matchHints,
  packageOf,
  readProfileDir,
  summarizeProfile,
  TOP_MODULES,
  TOP_PACKAGES,
} from "../../../src/core/profile/index.js";

// M5 V2: bundle stats, on small hand-written files in the shapes webpack, rollup-plugin-visualizer,
// and source-map-explorer document, their shares worked out by hand.

const FIXTURES = fileURLToPath(new URL("../../fixtures/profiles", import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function bundle(text: string, file = "stats.json"): FileHotspots {
  return summarizeProfile(file, text, "bundle-stats");
}

function reasonOf(summary: FileHotspots): string {
  if (summary.valid) throw new Error(`${summary.file} is valid`);
  return summary.reason;
}

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

describe("webpack stats", () => {
  it("count each byte once, in the innermost module, and split chunks by initial", () => {
    expect(bundle(fixture("webpack.stats.json"))).toEqual({
      file: "stats.json",
      valid: true,
      kind: "bundle",
      tool: "webpack",
      bytes: 10_000,
      // The HTML child compilation is left out.
      chunks: { initial: 6000, async: 4000 },
      modules: [
        { module: "./node_modules/chart.js/dist/chart.js", bytes: 3500, pct: 35 },
        { module: "./node_modules/react-dom/cjs/react-dom.production.js", bytes: 3000, pct: 30 },
        { module: "./node_modules/@acme/ui/dist/button.js", bytes: 1300, pct: 13 },
        { module: "./src/app.js", bytes: 1000, pct: 10 },
        { module: "./src/chart.js", bytes: 500, pct: 5 },
        { module: "./src/index.js", bytes: 500, pct: 5 },
        { module: "./node_modules/react/index.js", bytes: 200, pct: 2 },
      ],
      packages: [
        { package: "chart.js", bytes: 3500, pct: 35, modules: 1 },
        { package: "react-dom", bytes: 3000, pct: 30, modules: 1 },
        { package: "@acme/ui", bytes: 1300, pct: 13, modules: 1 },
        { package: "react", bytes: 200, pct: 2, modules: 1 },
      ],
      note: "module sizes are webpack's estimates before minification",
    });
  });

  it("add up the compilers of a multi-compiler build", () => {
    const compiler = (name: string, size: number) => ({
      modules: [{ name, size, chunks: [1] }],
      chunks: [{ id: 1, initial: true, size }],
    });
    const summary = bundle(
      JSON.stringify({
        children: [compiler("./src/a.js", 300), compiler("./node_modules/b/index.js", 100)],
      }),
    );
    expect(summary).toMatchObject({
      valid: true,
      tool: "webpack",
      bytes: 400,
      chunks: { initial: 400, async: 0 },
      packages: [{ package: "b", bytes: 100, pct: 25, modules: 1 }],
    });
  });

  it("leave chunks out when no chunk says whether it is initial", () => {
    const summary = bundle(JSON.stringify({ modules: [{ name: "./a.js", size: 5 }] }));
    expect(summary).toMatchObject({ valid: true, bytes: 5 });
    expect(summary).not.toHaveProperty("chunks");
  });
});

describe("rollup-plugin-visualizer raw-data", () => {
  it("adds up the module parts with their compressed sizes, pnpm packages by name", () => {
    expect(bundle(fixture("visualizer.raw-data.json"))).toEqual({
      file: "stats.json",
      valid: true,
      kind: "bundle",
      tool: "rollup-plugin-visualizer",
      bytes: 10_000,
      gzip: 3700,
      brotli: 3250,
      modules: [
        {
          module:
            "/node_modules/.pnpm/@vue+runtime-core@3.5.13/node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js",
          bytes: 7000,
          pct: 70,
        },
        {
          module: "/node_modules/.pnpm/lodash-es@4.17.21/node_modules/lodash-es/debounce.js",
          bytes: 2000,
          pct: 20,
        },
        { module: "/src/main.ts", bytes: 1000, pct: 10 },
        // A long path keeps its start and end.
      ].map((entry) => ({ ...entry, module: displayName(entry.module) })),
      packages: [
        { package: "@vue/runtime-core", bytes: 7000, pct: 70, modules: 1 },
        { package: "lodash-es", bytes: 2000, pct: 20, modules: 1 },
      ],
      note: "module sizes are rollup's rendered lengths, before minification",
    });
  });

  it("gives compressed sizes only when the plugin computed them, and says when maps sized it", () => {
    const data = JSON.parse(fixture("visualizer.raw-data.json"));
    data.options = { gzip: false, brotli: false, sourcemap: true };
    const summary = bundle(JSON.stringify(data));
    expect(summary).not.toHaveProperty("gzip");
    expect(summary).not.toHaveProperty("brotli");
    expect(summary).toMatchObject({
      note: "module sizes are read from the source maps, after minification",
    });
  });

  it("counts a module in two chunks in both, under one name", () => {
    const data = {
      nodeParts: {
        p1: { renderedLength: 10, metaUid: "m" },
        p2: { renderedLength: 30, metaUid: "m" },
      },
      nodeMetas: { m: { id: "/src/shared.ts" } },
    };
    expect(bundle(JSON.stringify(data))).toMatchObject({
      bytes: 40,
      modules: [{ module: "/src/shared.ts", bytes: 40, pct: 100 }],
    });
  });
});

describe("source-map-explorer --json", () => {
  it("adds up every bundle's mapped sources, unmapped bytes as their own entries", () => {
    expect(bundle(fixture("source-map-explorer.json"))).toEqual({
      file: "stats.json",
      valid: true,
      kind: "bundle",
      tool: "source-map-explorer",
      bytes: 10_000,
      modules: [
        { module: "node_modules/react-dom/cjs/react-dom.production.min.js", bytes: 4000, pct: 40 },
        { module: "node_modules/next/dist/client/index.js", bytes: 3000, pct: 30 },
        { module: "src/pages/index.tsx", bytes: 2800, pct: 28 },
        { module: "[unmapped]", bytes: 149, pct: 1.5 },
        { module: "[sourceMappingURL]", bytes: 50, pct: 0.5 },
        { module: "[EOLs]", bytes: 1, pct: 0 },
      ],
      packages: [
        { package: "react-dom", bytes: 4000, pct: 40, modules: 1 },
        { package: "next", bytes: 3000, pct: 30, modules: 1 },
      ],
      note: "module sizes are the built files' bytes mapped to each source (gzip estimates with --gzip)",
    });
  });
});

describe("a module's package", () => {
  it("is what follows its last node_modules/, scoped or not", () => {
    expect(packageOf("./node_modules/lodash/lodash.js")).toBe("lodash");
    expect(packageOf("./node_modules/@babel/runtime/helpers/esm/extends.js")).toBe(
      "@babel/runtime",
    );
    expect(packageOf("C:\\app\\node_modules\\@mui\\material\\Button\\Button.js")).toBe(
      "@mui/material",
    );
    // A loader request names the resource last.
    expect(packageOf("css ./node_modules/css-loader/dist/cjs.js!./node_modules/x/a.css")).toBe("x");
    expect(
      packageOf(
        ".yarn/cache/react-npm-18.3.1-af38f3c1ae-a27bcfa886.zip/node_modules/react/index.js",
      ),
    ).toBe("react");
    expect(packageOf("./src/index.js")).toBeUndefined();
    expect(packageOf("node_modules/")).toBeUndefined();
    expect(packageOf("node_modules/@scope")).toBeUndefined();
  });

  it("is the inner package in pnpm's store, or the store directory's name", () => {
    expect(packageOf("node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js")).toBe(
      "lodash",
    );
    expect(
      packageOf(
        "node_modules/.pnpm/@tanstack+react-query@5.62.0_react@18.3.1/node_modules/@tanstack/react-query/build/index.js",
      ),
    ).toBe("@tanstack/react-query");
    expect(packageOf("node_modules/.pnpm/@tanstack+react-query@5.62.0_react@18.3.1/x.js")).toBe(
      "@tanstack/react-query",
    );
    expect(packageOf("node_modules/.pnpm/left-pad@1.3.0/x.js")).toBe("left-pad");
    expect(packageOf("node_modules/.pnpm/")).toBeUndefined();
  });

  it("groups the package's modules", () => {
    const summary = bundle(
      JSON.stringify({
        modules: [
          { name: "./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/map.js", size: 30 },
          { name: "./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/_baseMap.js", size: 20 },
          { name: "./node_modules/lodash-es/map.js", size: 10 },
          { name: "./src/index.js", size: 40 },
        ],
      }),
    );
    expect(summary).toMatchObject({
      bytes: 100,
      packages: [
        { package: "lodash", bytes: 50, pct: 50, modules: 2 },
        { package: "lodash-es", bytes: 10, pct: 10, modules: 1 },
      ],
    });
  });
});

describe("a file that is not bundle stats", () => {
  const cases: [string, string, RegExp][] = [
    ["not JSON", "{", /^not JSON$/],
    ["an array", "[]", /not a JSON object/],
    ["another JSON", JSON.stringify({ nodes: [] }), /not webpack stats, rollup-plugin-visualizer/],
    [
      "a webpack module without a size",
      JSON.stringify({ modules: [{ name: "./a.js" }] }),
      /module 0 has no name or size/,
    ],
    [
      "a negative size",
      JSON.stringify({ modules: [{ name: "./a.js", size: -1 }] }),
      /module 0 has no name or size/,
    ],
    [
      "a concatenated module's part without a name",
      JSON.stringify({
        modules: [{ name: "./a.js + 1 modules", size: 1, modules: [{ size: 1 }] }],
      }),
      /module 0\.0 has no name or size/,
    ],
    [
      "a compiler that is no stats",
      JSON.stringify({ children: [7] }),
      /children\[0\] is not webpack stats/,
    ],
    [
      "raw-data without metas",
      JSON.stringify({ nodeParts: {} }),
      /raw-data without nodeParts or nodeMetas/,
    ],
    [
      "a part whose meta is missing",
      JSON.stringify({
        nodeParts: { p: { renderedLength: 1, metaUid: "toString" } },
        nodeMetas: {},
      }),
      /node part 0 names no module/,
    ],
    [
      "a part without a length",
      JSON.stringify({ nodeParts: { p: { metaUid: "m" } }, nodeMetas: { m: { id: "a" } } }),
      /node part 0 has no metaUid or renderedLength/,
    ],
    [
      "a source-map-explorer bundle without files",
      JSON.stringify({ results: [{ bundleName: "a.js" }] }),
      /results\[0\] has no files/,
    ],
    [
      "a mapped source without a size",
      JSON.stringify({ results: [{ files: { "./src/secret-path.js": {} } }] }),
      /results\[0\] file 0 has no size/,
    ],
    ["no module bytes", JSON.stringify({ modules: [] }), /no module bytes/],
    [
      "only orphans",
      JSON.stringify({ modules: [{ name: "./a.js", size: 3, chunks: [], orphan: true }] }),
      /no module bytes/,
    ],
  ];
  for (const [what, text, reason] of cases) {
    it(`is refused with a reason: ${what}`, () => {
      expect(reasonOf(bundle(text))).toMatch(reason);
    });
  }

  it("is never named by the repository's text in a reason", () => {
    const reason = reasonOf(
      bundle(JSON.stringify({ results: [{ files: { "./src/secret-path.js": { size: "1" } } }] })),
    );
    expect(reason).not.toContain("secret-path");
  });
});

describe("a bundle stats file's bounds", () => {
  it("refuses more than MAX_BUNDLE_ENTRIES entries rather than cutting them", () => {
    // The compilation and its modules, as text: one more than the cap, then the cap.
    const stats = (modules: number) =>
      `{"modules":[${'{"name":"./a.js","size":1},'.repeat(modules - 1)}{"name":"./a.js","size":1}]}`;
    expect(reasonOf(bundle(stats(MAX_BUNDLE_ENTRIES)))).toBe(
      `more than ${MAX_BUNDLE_ENTRIES} entries`,
    );
    expect(bundle(stats(MAX_BUNDLE_ENTRIES - 1))).toMatchObject({
      valid: true,
      bytes: MAX_BUNDLE_ENTRIES - 1,
    });
    // A bundle and its mapped sources.
    const sources = (count: number) =>
      `{"results":[{"files":{${Array.from({ length: count }, (_, i) => `"m${i}":{"size":1}`).join(",")}}}]}`;
    expect(reasonOf(bundle(sources(MAX_BUNDLE_ENTRIES)))).toBe(
      `more than ${MAX_BUNDLE_ENTRIES} entries`,
    );
    expect(bundle(sources(10))).toMatchObject({ valid: true, bytes: 10 });
  });

  it("counts the modules inside concatenated ones toward the cap", () => {
    const modules = Array.from({ length: MAX_BUNDLE_ENTRIES / 2 }, (_, i) => ({
      name: `./m${i}.js + 1 modules`,
      size: 2,
      modules: [{ name: `./m${i}.js`, size: 2 }],
    }));
    expect(
      reasonOf(bundle(JSON.stringify({ modules, chunks: [{ initial: true, size: 1 }] }))),
    ).toBe(`more than ${MAX_BUNDLE_ENTRIES} entries`);
  });

  it("lists at most TOP_MODULES modules and TOP_PACKAGES packages, names at most MAX_NAME_BYTES", () => {
    const long = "語".repeat(10_000);
    const modules = Array.from({ length: 50 }, (_, i) => ({
      name: `./node_modules/pkg-${i}-${long}/index-${long}.js`,
      size: 100 + i,
    }));
    const summary = bundle(JSON.stringify({ modules }));
    if (!summary.valid || summary.kind !== "bundle") throw new Error("not a bundle");
    expect(summary.modules).toHaveLength(TOP_MODULES);
    expect(summary.packages).toHaveLength(TOP_PACKAGES);
    for (const name of [
      ...summary.modules.map((m) => m.module),
      ...summary.packages.map((p) => p.package),
    ]) {
      expect(jsonBytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    }
    expect(summary.modules[0]?.module.startsWith("./node_modules/pkg-49-")).toBe(true);
  });

  it("cuts a long name where it is read: names alike at both ends are one module", () => {
    const name = (middle: string) => `./src/${"a".repeat(1000)}${middle}${"z".repeat(1000)}.js`;
    const summary = bundle(
      JSON.stringify({
        modules: [
          { name: name("1"), size: 1 },
          { name: name("2"), size: 2 },
        ],
      }),
    );
    expect(summary).toMatchObject({ bytes: 3, modules: [{ bytes: 3, pct: 100 }] });
  });

  it("looks up each part's own meta once, however many parts name one long meta", () => {
    const nodeParts: Record<string, { renderedLength: number; metaUid: string }> = {};
    for (let i = 0; i < 10_000; i++) nodeParts[`p${i}`] = { renderedLength: 1, metaUid: "m" };
    const summary = bundle(
      JSON.stringify({ nodeParts, nodeMetas: { m: { id: `/src/${"a".repeat(1_000_000)}.js` } } }),
    );
    if (!summary.valid || summary.kind !== "bundle") throw new Error("not a bundle");
    expect(summary.bytes).toBe(10_000);
    expect(summary.modules).toHaveLength(1);
    expect(jsonBytes(summary.modules[0]?.module ?? "")).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});

describe("a module name with a secret in it", () => {
  const KEY = `sk-ant-${"A1b2C3d4".repeat(8)}`;
  const leaks = (text: string) =>
    Array.from({ length: KEY.length - 7 }, (_, i) => KEY.slice(i, i + 8)).some((part) =>
      text.includes(part),
    );

  it("is redacted before it is cut, in modules, packages, and the file name", () => {
    const pad = "x".repeat(120);
    const text = JSON.stringify({
      modules: [
        { name: `./src/${pad}/token=${KEY}/${pad}.js`, size: 10 },
        { name: `./node_modules/${KEY}-${pad}/index.js`, size: 5 },
      ],
    });
    const redact = createTextRedactor({});
    const summary = summarizeProfile(`stats-${KEY}.json`, text, "bundle-stats", [], redact);
    const out = JSON.stringify(summary);
    expect(summary).toMatchObject({ valid: true, bytes: 15 });
    expect(leaks(out)).toBe(false);
    expect(out).toContain("<redacted:");
    // Unredacted, the cut names do show part of the key.
    expect(leaks(JSON.stringify(bundle(text)))).toBe(true);
  });

  it("is redacted when read from a profile directory, by default", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ufo-bundle-"));
    try {
      writeFileSync(
        path.join(dir, "stats.json"),
        JSON.stringify({ modules: [{ name: `./src/${KEY}/${"y".repeat(120)}.js`, size: 1 }] }),
      );
      expect(leaks(JSON.stringify(await readProfileDir(dir, "bundle-stats")))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves arm A's directory out of module paths", () => {
    const arm = "/work/run/arms/a";
    const summary = summarizeProfile(
      "s.json",
      JSON.stringify({ modules: [{ name: `${arm}/src/index.js`, size: 1 }] }),
      "bundle-stats",
      [`${arm}/`],
    );
    expect(summary).toMatchObject({ modules: [{ module: "src/index.js" }] });
  });
});

describe("a profile directory of bundle stats", () => {
  it("reads each file's tool from what it holds, the largest bundle first", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ufo-bundle-"));
    try {
      for (const name of ["webpack.stats.json", "visualizer.raw-data.json"]) {
        writeFileSync(path.join(dir, name), fixture(name));
      }
      writeFileSync(
        path.join(dir, "small.json"),
        JSON.stringify({ results: [{ files: { "src/a.js": { size: 7 } } }] }),
      );
      writeFileSync(path.join(dir, "notes.txt"), "not stats");
      mkdirSync(path.join(dir, "sub"));
      writeFileSync(path.join(dir, "huge.json"), "");
      truncateSync(path.join(dir, "huge.json"), MAX_PROFILE_BYTES + 1);
      const read = await readProfileDir(dir, "bundle-stats");
      expect(
        read.files.map((f) => [f.file, !f.valid ? f.reason : f.kind === "bundle" ? f.tool : ""]),
      ).toEqual([
        ["visualizer.raw-data.json", "rollup-plugin-visualizer"],
        ["webpack.stats.json", "webpack"],
        ["small.json", "source-map-explorer"],
        ["huge.json", "larger than 32 MiB"],
      ]);
      expect(read.omitted).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sorts bundles by their bytes", () => {
    const of = (file: string, bytes: number) =>
      bundle(JSON.stringify({ modules: [{ name: "./a.js", size: bytes }] }), file);
    expect(heaviestFiles([of("s", 1), of("l", 3), of("m", 2)]).files.map((f) => f.file)).toEqual([
      "l",
      "m",
      "s",
    ]);
  });
});

describe("a bundle's hot frames", () => {
  it("are its modules and packages, a package matched as node_modules/<name>/", () => {
    const summary = bundle(
      JSON.stringify({
        modules: [
          { name: "./node_modules/lodash/lodash.js", size: 30 },
          { name: "./node_modules/lodash-es/map.js", size: 20 },
          { name: "./src/index.js", size: 50 },
        ],
      }),
    );
    if (!summary.valid || summary.kind !== "bundle") throw new Error("not a bundle");
    const frames = hotFrames([summary]);
    expect(frames.map(({ frame, share, kind }) => ({ frame, share, kind }))).toEqual([
      { frame: "./src/index.js", share: 0.5, kind: "module" },
      { frame: "./node_modules/lodash/lodash.js", share: 0.3, kind: "module" },
      { frame: "./node_modules/lodash-es/map.js", share: 0.2, kind: "module" },
      { frame: "lodash", share: 0.3, kind: "package" },
      { frame: "lodash-es", share: 0.2, kind: "package" },
    ]);
    // CommonJS lodash, not lodash-es: the module and its package.
    expect(matchHints([{ match: "node_modules/lodash/", minShare: 0.05 }], frames)).toEqual([
      {
        hint: "node_modules/lodash/",
        frame: "./node_modules/lodash/lodash.js",
        share: 0.3,
        kind: "module",
      },
      { hint: "node_modules/lodash/", frame: "lodash", share: 0.3, kind: "package" },
    ]);
  });
});
