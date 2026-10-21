import {
  type OptIn,
  PROFILE_DIR_PLACEHOLDER,
  profiledSteps,
  type TechniqueCard,
  type UfoConfig,
} from "../domain/index.js";
import type { CardSet } from "./cards.js";
import { describeDefaultEnv, secretLikeNames } from "./env.js";
import { hygieneLimitations } from "./jobs/shared.js";
import { profileSettings } from "./profiler.js";

// What `ufo approve` shows the human before they type `approve`.

export interface ApprovedCommand {
  readonly what: string;
  readonly command: string;
}

/** The approved command set, in the order UFO runs them. */
export function approvedCommands(
  config: UfoConfig,
  cards: readonly TechniqueCard[],
): ApprovedCommand[] {
  const commands: ApprovedCommand[] = [];
  const { workload } = config;
  for (const step of ["setup", "start", "healthcheck", "warmup", "reset"] as const) {
    const command = workload[step];
    if (command !== undefined) commands.push({ what: `workload ${step}`, command });
  }
  commands.push({ what: "workload command", command: workload.command });
  if (workload.teardown !== undefined) {
    commands.push({ what: "workload teardown", command: workload.teardown });
  }
  for (const oracle of config.oracles) {
    commands.push({ what: `oracle ${oracle.name} (${oracle.kind})`, command: oracle.command });
  }
  for (const card of cards) {
    for (const template of card.commandTemplates) {
      commands.push({ what: `card ${card.id} ${template.id}`, command: template.run });
    }
  }
  return commands;
}

/** Long enough that a reader should check the whole line, not skim it. */
const LONG_COMMAND = 200;

function describeCommand(what: string, command: string): string {
  // JSON-quoted, so nothing in the line can hide from the reader.
  const long = command.length > LONG_COMMAND ? ` (long: ${command.length} characters)` : "";
  return `  ${what}${long}: ${JSON.stringify(command)}`;
}

/** `workload.profile`, its preset expanded: each variable JSON-quoted, as the commands are. */
function describeProfile(config: UfoConfig): string[] {
  const { profile } = config.workload;
  if (profile === undefined) return [];
  const settings = profileSettings(profile, PROFILE_DIR_PLACEHOLDER);
  const preset =
    profile.preset === undefined
      ? []
      : [
          `  preset ${profile.preset}: node --cpu-prof, with UFO's preload so a process stopped by SIGTERM or SIGINT still writes its profile${config.env.includes("NODE_OPTIONS") ? "; NODE_OPTIONS goes after the value env: passes" : ""}`,
        ];
  return [
    "",
    "Profiling, for profile_target only (baselines, samples, oracles, and the final check run without it):",
    `  every step of a profile job gets UFO_PROFILE_DIR, a new directory in the run state; UFO reads the ${settings.format} files written there`,
    `  profiled steps: ${profiledSteps(config.workload).join(", ")}; they also get these variables, ${PROFILE_DIR_PLACEHOLDER} replaced with that directory`,
    ...preset,
    ...Object.entries(settings.env).map(([name, value]) =>
      describeCommand(`profile env ${name}`, value),
    ),
  ];
}

function describeEdits(card: TechniqueCard): string[] {
  const defaults = card.params.map((p) => `${p.name}=${String(p.default)}`).join(", ");
  const withDefaults = defaults ? ` (defaults: ${defaults})` : "";
  return card.edits.flatMap((edit) =>
    edit.op === "set_property"
      ? [`  ${card.id}: set ${edit.key}=${edit.value} in ${edit.file}${withDefaults}`]
      : [
          `  ${card.id}: in ${edit.file}${withDefaults}, replace`,
          `    ${JSON.stringify(edit.find)}`,
          "    with",
          `    ${JSON.stringify(edit.replace)}`,
        ],
  );
}

export interface ScriptTableReview {
  /** Files the approved commands dispatch through; patches may not edit them. */
  readonly files: readonly string[];
  /** `name: body` of each package.json script the commands run. */
  readonly npmScripts: readonly string[];
}

export function approvalReview(
  root: string,
  hash: string,
  config: UfoConfig,
  cards: readonly TechniqueCard[],
  sources: CardSet,
  optIns: readonly OptIn[],
  scripts: ScriptTableReview = { files: [], npmScripts: [] },
): string {
  const { objective } = config;
  const lines = [
    `UFO approval for ${root}`,
    `ufo.yaml sha256 ${hash}`,
    "",
    `Objective: ${objective.primary.name} (${objective.primary.unit}, ${objective.primary.direction}, ${objective.primary.kind})`,
    `  scenario: ${objective.scenario}`,
    `  min effect ${(objective.minEffect * 100).toFixed(1)}%, budget ${objective.budget.wallClockMinutes} min / ${objective.budget.maxTechniques} techniques`,
    `  guardrails: ${objective.guardrails.map((g) => g.kind).join(", ") || "defaults only"}`,
    "",
    "Commands UFO will run (with /bin/sh -c, in each arm's directory; {{param}} is filled from the card's typed parameters):",
    ...approvedCommands(config, cards).map(({ what, command }) => describeCommand(what, command)),
    ...describeProfile(config),
  ];
  if (scripts.files.length > 0) {
    lines.push(
      "",
      `Script tables these commands run through (protected from patches): ${scripts.files.join(", ")}`,
      ...scripts.npmScripts.map((line) => `  package.json script ${line}`),
    );
  }
  if (config.cardDirs.length > 0) {
    lines.push("", `Card directories (protected from patches): ${config.cardDirs.join(", ")}`);
  }
  const recipes = cards.filter((card) => card.edits.length > 0);
  if (recipes.length > 0) {
    lines.push("", "Recipe edits (UFO writes the diff itself):", ...recipes.flatMap(describeEdits));
  }
  lines.push("", "Enabled technique cards:");
  for (const card of cards) {
    const needs =
      card.riskClass === "lossy" || card.riskClass === "upgrade"
        ? optIns.includes(card.riskClass)
          ? ` (opt-in ${card.riskClass} granted)`
          : ` (refused: needs the ${card.riskClass} opt-in)`
        : "";
    const source = sources.get(card.id)?.source ?? "unknown source";
    lines.push(`  ${card.id}: ${card.kind}, ${card.riskClass}, from ${source}${needs}`);
  }
  lines.push(
    "",
    `Load targets: loopback and the default Docker bridge${config.targets.length > 0 ? `, plus ${config.targets.join(", ")}` : ""}. UFO checks these names when the run starts and passes the checked addresses as UFO_TARGET_ADDR; it does not control where the workload connects.`,
    `Opt-ins: ${optIns.length > 0 ? optIns.join(", ") : "none"}`,
    `Machine checks before every sample: ${config.hygiene.requireAcPower ? "AC power" : "battery allowed"}, 1-minute load below ${config.hygiene.maxLoadFactor} × cores${hygieneLimitations(config.hygiene).length > 0 ? " (loosened from the defaults; the bundle records it)" : ""}`,
    `Environment of every command: ${describeDefaultEnv()}${config.env.length > 0 ? `, plus ${config.env.join(", ")} from ufo.yaml` : ""}; values are read when the run starts, everything else is left out, and PATH keeps only absolute entries outside the repository and UFO's home`,
    ...(secretLikeNames(config.env).length > 0
      ? [
          `  Warning: env lists names that look like secrets (${secretLikeNames(config.env).join(", ")}); patched code can read every listed variable.`,
        ]
      : []),
    "",
    "Patches are executed code: these commands bound what UFO runs, not what patched code does.",
    "",
  );
  return lines.join("\n");
}
