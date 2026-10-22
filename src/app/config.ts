import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { hashConfig, personMustRun } from "../core/policy/index.js";
import { type UfoConfig, UfoConfigSchema } from "../domain/index.js";
import type { DetectedStack } from "./detect.js";
import { secretLikeNames } from "./env.js";
import { AppError } from "./errors.js";

export const CONFIG_FILE = "ufo.yaml";
const MAX_CONFIG_BYTES = 256 * 1024;

/** Oracle kinds this version can run. The others need packs (M4). */
export const SUPPORTED_ORACLE_KINDS: ReadonlySet<string> = new Set(["test_pass_set", "smoke"]);
/** Guardrail kinds the generic command workload can check. */
export const SUPPORTED_GUARDRAIL_KINDS: ReadonlySet<string> = new Set([
  "error_rate",
  "memory",
  "test_pass_set",
]);

/** Keys of the workload's JSON line that feed the error-rate and memory guardrails. */
export const ERROR_RATE_KEY = "error_rate";
export const RSS_KEY = "rss_bytes";

export interface LoadedConfig {
  readonly path: string;
  /** The exact bytes, as UTF-8; the approval hash is over them. */
  readonly text: string;
  readonly hash: string;
  readonly config: UfoConfig;
}

/**
 * Parses `ufo.yaml` text: YAML without aliases or duplicate keys, then the schema, then the
 * checks this version needs to run it. Throws `config_invalid` naming the first problem.
 */
export function parseConfigText(text: string, source = CONFIG_FILE): UfoConfig {
  let value: unknown;
  try {
    value = parseYaml(text, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new AppError(
      "config_invalid",
      `${source} is not valid YAML: ${(error as Error).message}`,
    );
  }
  const parsed = UfoConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(
      "config_invalid",
      `${source}: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const config = parsed.data;
  for (const oracle of config.oracles) {
    if (!SUPPORTED_ORACLE_KINDS.has(oracle.kind)) {
      throw new AppError(
        "config_invalid",
        `${source}: oracle ${oracle.name}: kind ${oracle.kind} is not supported yet (supported: ${[...SUPPORTED_ORACLE_KINDS].join(", ")})`,
      );
    }
  }
  for (const guardrail of config.objective.guardrails) {
    if (!SUPPORTED_GUARDRAIL_KINDS.has(guardrail.kind)) {
      throw new AppError(
        "config_invalid",
        `${source}: guardrail ${guardrail.kind} is not supported yet`,
      );
    }
  }
  // The test-set guardrail compares the pass sets a test_pass_set oracle produces; without one
  // it would be shown at approval and enforce nothing.
  const testSetGuardrail = config.objective.guardrails.some((g) => g.kind === "test_pass_set");
  if (testSetGuardrail && !config.oracles.some((o) => o.kind === "test_pass_set")) {
    throw new AppError(
      "config_invalid",
      `${source}: guardrail test_pass_set needs an oracle of kind test_pass_set`,
    );
  }
  // Its values are plain text in ufo.yaml, shown at approval and read by the profiled code.
  const secretLike = secretLikeNames(Object.keys(config.workload.profile?.env ?? {}));
  if (secretLike.length > 0) {
    throw new AppError(
      "config_invalid",
      `${source}: workload.profile.env: ${secretLike.join(", ")} looks like a secret, and ufo.yaml would hold its value in plain text`,
    );
  }
  const reserved = [ERROR_RATE_KEY, RSS_KEY];
  for (const metric of [config.objective.primary, ...config.objective.reportedOnly]) {
    if (reserved.includes(metric.name)) {
      throw new AppError(
        "config_invalid",
        `${source}: metric name ${metric.name} is reserved for the guardrail keys of the workload output`,
      );
    }
  }
  return config;
}

/** Reads and validates `<repoRoot>/ufo.yaml`. */
export async function loadConfig(repoRoot: string): Promise<LoadedConfig> {
  const file = path.join(repoRoot, CONFIG_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError(
        "config_missing",
        `no ${CONFIG_FILE} at the repository root; run ufo init`,
      );
    }
    throw error;
  }
  if (bytes.length > MAX_CONFIG_BYTES) {
    throw new AppError("config_invalid", `${CONFIG_FILE} is larger than ${MAX_CONFIG_BYTES} bytes`);
  }
  const text = bytes.toString("utf8");
  return { path: file, text, hash: hashConfig(bytes), config: parseConfigText(text) };
}

/** The command a draft marks for the person to fill in; it exits 1 until they do. */
export const DRAFT_WORKLOAD_COMMAND = "echo replace this with your benchmark command; exit 1";

const DRAFT_ORACLE_EXAMPLE = `#  - name: unit-tests
#    kind: test_pass_set
#    command: node --test --test-reporter=./test/reporter/ufo.mjs
#  - name: smoke
#    kind: smoke
#    command: ./scripts/smoke.sh
`;

/**
 * A Python `start` that runs under py-spy in a profile job only: `UFO_PROFILE_DIR` is set there
 * alone, so in every measured run `/bin/sh` expands the prefix to nothing.
 */
export const PYTHON_PROFILED_START =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a JS template.
  '${UFO_PROFILE_DIR:+py-spy record -f raw -o "$UFO_PROFILE_DIR/py.txt" -s --} python app.py';

/**
 * webpack-cli's `--json <file>` (https://webpack.js.org/api/cli/), into the profile directory in a
 * profile job only; in every measured run `/bin/sh` expands it to nothing.
 */
export const WEBPACK_PROFILED_STATS =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a JS template.
  '${UFO_PROFILE_DIR:+--json "$UFO_PROFILE_DIR/stats.json"}';

/**
 * source-map-explorer's JSON of the Next.js client chunks (it expands the quoted glob itself),
 * into the profile directory in a profile job only; a measured run skips it.
 */
export const NEXT_PROFILED_STATS =
  '{ [ -z "$UFO_PROFILE_DIR" ] || npx source-map-explorer \'.next/static/chunks/**/*.js\' --json "$UFO_PROFILE_DIR/client.json"; }';

/** The `profile` block of the draft for the detected stacks: Node's preset, others commented. */
function profileNotes(stacks: readonly DetectedStack[]): string {
  const has = (...ids: string[]) => stacks.some((stack) => ids.includes(stack.id));
  let notes = "";
  if (has("node")) {
    notes += `  # profile_target runs the profiled step (start, else the command) under node --cpu-prof, with
  # UFO's preload so a server stopped by SIGTERM still writes its profile (docs/cli.md, "Profiling").
  profile:
    preset: node-cpu
`;
  }
  if (has("jvm", "spring-boot")) {
    notes += `  # JVM: the async-profiler agent (https://github.com/async-profiler/async-profiler), installed
  # separately, writes folded stacks for each JVM. JAVA_TOOL_OPTIONS also reaches the JVMs Maven and
  # Gradle start, each writing its own %p file; whether the agent writes on SIGTERM is unverified.
  # With the server JVM in start, set the library's path (.dylib on macOS, .so on Linux) and
  # uncomment:
  # profile:
  #   env:
  #     JAVA_TOOL_OPTIONS: "-agentpath:/path/to/libasyncProfiler.dylib=start,event=cpu,collapsed,file={{profile_dir}}/prof-%p.collapsed"
  #   steps: [start]
  #   format: collapsed
`;
  }
  if (has("python", "django", "fastapi", "flask")) {
    notes += `  # Python: py-spy wraps start in a profile job only (UFO_PROFILE_DIR is set there alone, so
  # measured runs start the bare command); py-spy needs root on macOS. On Python 3.15+,
  # python \${UFO_PROFILE_DIR:+-m profiling.sampling run --collapsed -o "$UFO_PROFILE_DIR/py.collapsed"} app.py
  # is the built-in alternative (privileges on macOS unconfirmed). Adapt and uncomment:
  # start: ${PYTHON_PROFILED_START}
  # profile:
  #   format: collapsed
`;
  }
  if (has("vite", "webpack", "nextjs")) {
    notes += `  # Bundle: the build leaves a bundle analyzer's JSON in $UFO_PROFILE_DIR, which every step of a
  # profile job gets and no measured run does, so the step that builds (setup or command) writes
  # it there. The default steps ([command] without a start) only choose who gets env; this block
  # has none.
`;
    if (has("vite")) {
      notes += `  # Vite: rollup-plugin-visualizer (https://github.com/btd/rollup-plugin-visualizer, installed
  # separately) last in the config's plugins, in a profile job only:
  #   ...(process.env.UFO_PROFILE_DIR ? [visualizer({ filename: \`\${process.env.UFO_PROFILE_DIR}/stats.json\`,
  #     template: "raw-data", gzipSize: true, brotliSize: true })] : [])
`;
    }
    if (has("webpack")) {
      notes += `  # webpack: webpack-cli writes the stats JSON with --json <file>, in a profile job only:
  #   webpack ${WEBPACK_PROFILED_STATS}
  # or webpack-bundle-analyzer's BundleAnalyzerPlugin with analyzerMode: "disabled",
  # generateStatsFile: true, statsFilename: path.join(process.env.UFO_PROFILE_DIR, "stats.json").
`;
    }
    if (has("nextjs")) {
      notes += `  # Next.js: with productionBrowserSourceMaps: true in next.config, source-map-explorer
  # (https://github.com/danvk/source-map-explorer) maps the client chunks after next build:
  #   next build && ${NEXT_PROFILED_STATS}
  # next analyze writes a format UFO does not read; with next build --webpack, the
  # BundleAnalyzerPlugin above works too.
`;
    }
    notes += `  # To read the bundle${has("node") ? " in place of the node-cpu profile above" : ""}, adapt the build and uncomment:
  # profile:
  #   format: bundle-stats
`;
  }
  return notes;
}

function renderDraft(
  workloadNotes: string,
  oracleNotes: string,
  cardNotes: string,
  profile = "",
): string {
  return `# UFO configuration. Edit it; then ${personMustRun("ufo approve")}.
# Reference: docs/cli.md (ufo.yaml reference).
version: 1
objective:
  # Exactly one primary metric decides keep or drop.
  primary:
    name: latency_ms
    unit: ms
    direction: lower_is_better
    # deterministic: exact repeats (bytes, counts); stochastic: timings (5 interleaved pairs).
    kind: stochastic
    replicationUnit: load_run
  scenario: describe the one measured scenario here
  guardrails:
    - kind: error_rate
  # Smallest improvement worth keeping: 0.03 = 3%.
  minEffect: 0.03
  budget:
    wallClockMinutes: 120
    maxTechniques: 10
workload:
  # Runs in each arm's directory and prints one JSON line on stdout, e.g.
  # {"latency_ms": 12.3, "error_rate": 0}
${workloadNotes}  command: "${DRAFT_WORKLOAD_COMMAND}"
${profile}${oracleNotes}targets: []
cards:
  - generic.code-change
${cardNotes}optIns: []
# Environment variables commands may see besides PATH, HOME, LANG, LC_*, TMPDIR, USER, SHELL,
# TERM; their values are read when a run starts. Everything else is left out.
env: []
`;
}

/**
 * The draft `ufo init` writes, and `inspect_target` returns while there is no ufo.yaml and
 * nothing is detected. It is valid as written; the workload command is a placeholder.
 */
export const DRAFT_CONFIG = renderDraft("", `oracles: []\n${DRAFT_ORACLE_EXAMPLE}`, "");

/**
 * The draft for the stacks found in the repository: their measuring hints, a profile block for
 * profile_target (Node's preset, the JVM's and Python's commented), the detected test command as
 * a commented-out oracle, and the stacks whose cards to enable. `DRAFT_CONFIG` when nothing was
 * detected. It is valid as written; only the workload command is left to fill in.
 */
export function draftConfigFor(stacks: readonly DetectedStack[]): string {
  if (stacks.length === 0) return DRAFT_CONFIG;
  const hints = stacks.flatMap((stack) =>
    stack.suggestions.workloadHint === undefined
      ? []
      : [`  # Detected ${stack.id}: ${stack.suggestions.workloadHint}\n`],
  );
  const workloadNotes = `${hints.join("")}  # FILL IN: the command below fails until you replace it with the one command that\n  # measures your scenario and prints that JSON line.\n`;
  const test = stacks.find((stack) => stack.suggestions.testCommand !== undefined);
  const oracleNotes =
    test?.suggestions.testCommand === undefined
      ? `oracles: []\n${DRAFT_ORACLE_EXAMPLE}`
      : `# Detected test command: ${test.suggestions.testCommand} (${test.id}). A test_pass_set oracle must print one
# stdout line {"ufoTestResults":1,"tests":[{"id":"<test>","outcome":"pass"}]} (docs/cli.md, "Test
# results"), which this command does not do on its own: make it print that line, then uncomment.
oracles: []
#  - name: unit-tests
#    kind: test_pass_set
#    command: ${test.suggestions.testCommand}
`;
  const cardNotes = `# Detected: ${stacks.map((stack) => stack.id).join(", ")}. List the cards for them with the
# list_techniques tool (filter by stack and by the bottleneck the profile shows), then add their ids.
`;
  return renderDraft(workloadNotes, oracleNotes, cardNotes, profileNotes(stacks));
}

/**
 * Whether `text` is exactly the draft this app builds for `stacks`, as `inspect_target` returns
 * them. An MCP adapter exempts that text, and nothing else, from redaction.
 */
export function isDraftConfig(text: unknown, stacks: unknown = []): boolean {
  if (typeof text !== "string" || !Array.isArray(stacks)) return false;
  const shaped = stacks.every((stack: unknown) => {
    const entry = stack as { id?: unknown; suggestions?: unknown } | null;
    return typeof entry?.id === "string" && typeof entry.suggestions === "object";
  });
  return shaped && text === draftConfigFor(stacks as DetectedStack[]);
}
