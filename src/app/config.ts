import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { hashConfig, personMustRun } from "../core/policy/index.js";
import { type UfoConfig, UfoConfigSchema } from "../domain/index.js";
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

/**
 * The draft `ufo init` writes, and `inspect_target` returns while there is no ufo.yaml. It is
 * valid as written; the workload command is a placeholder.
 */
export const DRAFT_CONFIG = `# UFO configuration. Edit it; then ${personMustRun("ufo approve")}.
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
  command: "echo replace this with your benchmark command; exit 1"
oracles: []
#  - name: unit-tests
#    kind: test_pass_set
#    command: node --test --test-reporter=./test/reporter/ufo.mjs
#  - name: smoke
#    kind: smoke
#    command: ./scripts/smoke.sh
targets: []
cards:
  - generic.code-change
optIns: []
# Environment variables commands may see besides PATH, HOME, LANG, LC_*, TMPDIR, USER, SHELL,
# TERM; their values are read when a run starts. Everything else is left out.
env: []
`;
