import type { OptIn, TechniqueCard, UfoConfig } from "../domain/index.js";
import type { CardSet } from "./cards.js";
import { describeDefaultEnv } from "./env.js";
import { hygieneLimitations } from "./jobs/shared.js";

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

function describeEdits(card: TechniqueCard): string[] {
  const defaults = card.params.map((p) => `${p.name}=${String(p.default)}`).join(", ");
  return card.edits.map((edit) =>
    edit.op === "set_property"
      ? `  ${card.id}: set ${edit.key}=${edit.value} in ${edit.file}${defaults ? ` (defaults: ${defaults})` : ""}`
      : `  ${card.id}: replace ${JSON.stringify(edit.find.slice(0, 60))} in ${edit.file}`,
  );
}

export function approvalReview(
  root: string,
  hash: string,
  config: UfoConfig,
  cards: readonly TechniqueCard[],
  sources: CardSet,
  optIns: readonly OptIn[],
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
    ...approvedCommands(config, cards).map(({ what, command }) => `  ${what}: ${command}`),
  ];
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
    `Load targets: loopback and the default Docker bridge${config.targets.length > 0 ? `, plus ${config.targets.join(", ")}` : ""}`,
    `Opt-ins: ${optIns.length > 0 ? optIns.join(", ") : "none"}`,
    `Machine checks before every sample: ${config.hygiene.requireAcPower ? "AC power" : "battery allowed"}, 1-minute load below ${config.hygiene.maxLoadFactor} × cores${hygieneLimitations(config.hygiene).length > 0 ? " (loosened from the defaults; the bundle records it)" : ""}`,
    `Environment of every command: ${describeDefaultEnv()}${config.env.length > 0 ? `, plus ${config.env.join(", ")} from ufo.yaml` : ""}; values are read when the run starts, everything else is left out`,
    "",
    "Patches are executed code: these commands bound what UFO runs, not what patched code does.",
    "",
  );
  return lines.join("\n");
}
