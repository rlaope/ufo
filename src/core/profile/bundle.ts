import {
  displayName,
  type FileHotspots,
  heaviest,
  invalid,
  type NameRedactor,
  pct,
  rawName,
  summarize,
} from "./summary.js";

// Bundle stats (`format: bundle-stats`): which modules and packages a production build's bytes
// are in, from the JSON a bundle analyzer leaves in the profile directory.

/** Modules and packages listed by bytes. */
export const TOP_MODULES = 20;
export const TOP_PACKAGES = 10;
/**
 * Entries (modules, module parts, mapped sources, chunks) read of one file, about three times
 * as many as `MAX_PROFILE_BYTES` holds of the shortest entries these tools write; a file with
 * more is refused rather than cut.
 */
export const MAX_BUNDLE_ENTRIES = 500_000;

export type BundleTool = "webpack" | "rollup-plugin-visualizer" | "source-map-explorer";

export interface ModuleShare {
  module: string;
  bytes: number;
  /** Percent of the file's `bytes`, to one decimal. */
  pct: number;
}

export interface PackageShare {
  /** `name` or `@scope/name`, as the path after its last `node_modules/` names it. */
  package: string;
  bytes: number;
  pct: number;
  /** Modules of the package the file lists. */
  modules: number;
}

/** One bundle stats file. Module and package names are the repository's text. */
export interface BundleHotspots {
  file: string;
  valid: true;
  kind: "bundle";
  /** The tool whose JSON the file is. */
  tool: BundleTool;
  /** The bytes of every module the file lists, as `note` says the tool counts them. */
  bytes: number;
  /** rollup-plugin-visualizer with `gzipSize` or `brotliSize`: the modules' compressed bytes. */
  gzip?: number;
  brotli?: number;
  /** webpack: chunk bytes loaded on the initial page load, and on demand. */
  chunks?: { initial: number; async: number };
  modules: ModuleShare[];
  packages: PackageShare[];
  note: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** What a reader makes of one file: bytes by module name as the tool wrote it, or why not. */
type Read =
  | {
      valid: true;
      tool: BundleTool;
      modules: Map<string, number>;
      gzip?: number;
      brotli?: number;
      chunks?: { initial: number; async: number };
      note: string;
    }
  | { valid: false; reason: string };

/** Counts entries read, so a file with too many is refused however they nest. */
class Budget {
  private count = 0;

  /** False once more than `MAX_BUNDLE_ENTRIES` were taken. */
  take(): boolean {
    return ++this.count <= MAX_BUNDLE_ENTRIES;
  }
}

const TOO_MANY = `more than ${MAX_BUNDLE_ENTRIES} entries`;

function add(modules: Map<string, number>, name: string, bytes: number): void {
  const raw = rawName(name);
  modules.set(raw, (modules.get(raw) ?? 0) + bytes);
}

/**
 * One compilation of webpack stats (https://webpack.js.org/api/stats/): `modules`, each with
 * `name`, `size`, and the ids of its `chunks`. The JSON stats also list orphan modules (no
 * chunk) and, inside a concatenated module, the modules it holds; each byte is counted once,
 * in the innermost module.
 */
function addWebpack(
  stats: Json,
  modules: Map<string, number>,
  chunks: { initial: number; async: number; flagged: boolean },
  budget: Budget,
): string | undefined {
  if (!Array.isArray(stats.modules)) return "webpack stats without modules";
  for (const [i, module] of stats.modules.entries()) {
    if (!budget.take()) return TOO_MANY;
    if (!isObject(module) || typeof module.name !== "string" || !isBytes(module.size)) {
      return `module ${i} has no name or size`;
    }
    if (module.orphan === true || (Array.isArray(module.chunks) && module.chunks.length === 0)) {
      continue;
    }
    const inner = Array.isArray(module.modules) ? module.modules : [];
    if (inner.length === 0) {
      add(modules, module.name, module.size);
      continue;
    }
    for (const [j, part] of inner.entries()) {
      if (!budget.take()) return TOO_MANY;
      if (!isObject(part) || typeof part.name !== "string" || !isBytes(part.size)) {
        return `module ${i}.${j} has no name or size`;
      }
      add(modules, part.name, part.size);
    }
  }
  for (const chunk of Array.isArray(stats.chunks) ? stats.chunks : []) {
    if (!budget.take()) return TOO_MANY;
    if (!isObject(chunk) || typeof chunk.initial !== "boolean" || !isBytes(chunk.size)) continue;
    chunks.flagged = true;
    if (chunk.initial) chunks.initial += chunk.size;
    else chunks.async += chunk.size;
  }
  return undefined;
}

function readWebpack(stats: Json): Read {
  const budget = new Budget();
  const modules = new Map<string, number>();
  const chunks = { initial: 0, async: 0, flagged: false };
  // `webpack --json` with several configurations writes one stats object per compiler in
  // `children`; a single compiler's `children` are child compilations (HTML, CSS extraction),
  // left out.
  const compilations =
    !Array.isArray(stats.modules) && Array.isArray(stats.children) ? stats.children : [stats];
  for (const [i, compilation] of compilations.entries()) {
    if (!budget.take()) return invalid(TOO_MANY);
    if (!isObject(compilation)) return invalid(`children[${i}] is not webpack stats`);
    const problem = addWebpack(compilation, modules, chunks, budget);
    if (problem !== undefined) return invalid(problem);
  }
  return {
    valid: true,
    tool: "webpack",
    modules,
    ...(chunks.flagged ? { chunks: { initial: chunks.initial, async: chunks.async } } : {}),
    note: "module sizes are webpack's estimates before minification",
  };
}

/**
 * rollup-plugin-visualizer `template: "raw-data"` (its `VisualizerData`,
 * https://github.com/btd/rollup-plugin-visualizer/blob/master/shared/types.ts): `nodeParts`,
 * one per module in each output chunk with its `renderedLength`, `gzipLength`, and
 * `brotliLength`, and `nodeMetas`, whose `id` names the module. A part is read once, and only
 * its own meta is looked up, so a meta that many parts name costs nothing more.
 */
function readVisualizer(data: Json): Read {
  const { nodeParts, nodeMetas, options } = data;
  if (!isObject(nodeParts) || !isObject(nodeMetas)) {
    return invalid("raw-data without nodeParts or nodeMetas");
  }
  const gzipped = isObject(options) && options.gzip === true;
  const brotlied = isObject(options) && options.brotli === true;
  const fromMaps = isObject(options) && options.sourcemap === true;
  const budget = new Budget();
  const modules = new Map<string, number>();
  let gzip = 0;
  let brotli = 0;
  // Reasons name entries by their place, never by the repository's text.
  let index = 0;
  for (const uid in nodeParts) {
    if (!budget.take()) return invalid(TOO_MANY);
    const part = nodeParts[uid];
    if (!isObject(part) || typeof part.metaUid !== "string" || !isBytes(part.renderedLength)) {
      return invalid(`node part ${index} has no metaUid or renderedLength`);
    }
    const meta = Object.hasOwn(nodeMetas, part.metaUid) ? nodeMetas[part.metaUid] : undefined;
    if (!isObject(meta) || typeof meta.id !== "string") {
      return invalid(`node part ${index} names no module in nodeMetas`);
    }
    index++;
    add(modules, meta.id, part.renderedLength);
    if (gzipped && isBytes(part.gzipLength)) gzip += part.gzipLength;
    if (brotlied && isBytes(part.brotliLength)) brotli += part.brotliLength;
  }
  return {
    valid: true,
    tool: "rollup-plugin-visualizer",
    modules,
    ...(gzipped ? { gzip } : {}),
    ...(brotlied ? { brotli } : {}),
    note: fromMaps
      ? "module sizes are read from the source maps, after minification"
      : "module sizes are rollup's rendered lengths, before minification",
  };
}

/**
 * source-map-explorer `--json` (https://github.com/danvk/source-map-explorer, `ExploreResult`
 * in src/lib/types.d.ts): `results`, one per bundle, whose `files` give each source the bytes
 * of the bundle mapped to it, `[unmapped]` and the other bracketed keys included.
 */
function readSourceMapExplorer(results: unknown[]): Read {
  const budget = new Budget();
  const modules = new Map<string, number>();
  for (const [i, bundle] of results.entries()) {
    if (!budget.take()) return invalid(TOO_MANY);
    if (!isObject(bundle) || !isObject(bundle.files)) {
      return invalid(`results[${i}] has no files`);
    }
    let index = 0;
    for (const source in bundle.files) {
      if (!budget.take()) return invalid(TOO_MANY);
      const entry = bundle.files[source];
      // By its place, never by the repository's text.
      if (!isObject(entry) || !isBytes(entry.size)) {
        return invalid(`results[${i}] file ${index} has no size`);
      }
      add(modules, source, entry.size);
      index++;
    }
  }
  return {
    valid: true,
    tool: "source-map-explorer",
    modules,
    note: "module sizes are the built files' bytes mapped to each source (gzip estimates with --gzip)",
  };
}

/** Which tool's JSON `text` is, and what it lists. */
function readBundle(text: string): Read {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("not JSON");
  }
  if (!isObject(value)) {
    return invalid("not a JSON object: not bundle stats");
  }
  if ("nodeParts" in value || "nodeMetas" in value) return readVisualizer(value);
  if (Array.isArray(value.results)) return readSourceMapExplorer(value.results);
  if (Array.isArray(value.modules) || Array.isArray(value.children)) return readWebpack(value);
  return invalid(
    "not webpack stats, rollup-plugin-visualizer raw-data, or source-map-explorer JSON",
  );
}

/**
 * The npm package of a module path: after its last `node_modules/`, `name` or `@scope/name`. In
 * pnpm's store (`node_modules/.pnpm/<name>@<version>/node_modules/<name>/`) that is the inner
 * one; a path that stops at the store's directory is named by it, `@scope+name` as `@scope/name`.
 */
export function packageOf(module: string): string | undefined {
  const path = module.replaceAll("\\", "/");
  const at = path.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const [first = "", second = ""] = path.slice(at + "node_modules/".length).split("/", 2);
  if (first === ".pnpm") {
    const dir = second.replace(/^(@[^+/]+)\+/, "$1/");
    const version = dir.indexOf("@", 1);
    const name = version === -1 ? dir : dir.slice(0, version);
    return name === "" ? undefined : name;
  }
  if (first.startsWith("@")) return second === "" ? undefined : `${first}/${second}`;
  return first === "" ? undefined : first;
}

/** The modules and packages of one bundle stats file; never throws for what the text holds. */
export function summarizeBundle(
  file: string,
  text: string,
  prefixes: readonly string[] = [],
  redact?: NameRedactor,
): FileHotspots {
  const read = readBundle(text);
  if (!read.valid) return summarize(file, read, [], redact);
  const name = displayName(file, [], redact);
  const bytes = [...read.modules.values()].reduce((sum, b) => sum + b, 0);
  if (!(bytes > 0) || !Number.isFinite(bytes)) {
    return { file: name, valid: false, reason: "the stats hold no module bytes" };
  }
  const packages = new Map<string, { bytes: number; modules: number }>();
  for (const [module, size] of read.modules) {
    const pkg = packageOf(module);
    if (pkg === undefined) continue;
    const entry = packages.get(pkg);
    if (entry === undefined) packages.set(pkg, { bytes: size, modules: 1 });
    else {
      entry.bytes += size;
      entry.modules++;
    }
  }
  return {
    file: name,
    valid: true,
    kind: "bundle",
    tool: read.tool,
    bytes,
    ...(read.gzip === undefined ? {} : { gzip: read.gzip }),
    ...(read.brotli === undefined ? {} : { brotli: read.brotli }),
    ...(read.chunks === undefined ? {} : { chunks: read.chunks }),
    modules: heaviest(read.modules, (b) => b, TOP_MODULES).map(([module, size]) => ({
      module: displayName(module, prefixes, redact),
      bytes: size,
      pct: pct(size, bytes),
    })),
    packages: heaviest(packages, (p) => p.bytes, TOP_PACKAGES).map(([pkg, entry]) => ({
      package: displayName(pkg, [], redact),
      bytes: entry.bytes,
      pct: pct(entry.bytes, bytes),
      modules: entry.modules,
    })),
    note: read.note,
  };
}
