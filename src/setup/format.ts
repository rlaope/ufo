import type { SetupReport } from "./index.js";
import { hostNames, type UnchangedView } from "./plan.js";

// Human-readable output of `ufo setup`, `uninstall`, and `update`. `--json` prints the report.

const KIND = { mcp_server: "MCP server", skill: "skill" } as const;

const indented = (text: string, by: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => by + line)
    .join("\n");

const unchangedLine = (item: UnchangedView) =>
  `  ${hostNames(item.hosts)} ${KIND[item.kind]}, ${item.target}: ${item.reason}`;

/** The review printed before the question: hosts found, each change with its diff, the rest. */
export function formatSetupPlan(report: SetupReport): string {
  const lines = [`ufo ${report.command} (ufo-agents@${report.version})`];
  if (report.detected !== undefined) {
    lines.push("", "Hosts:");
    for (const host of report.detected) {
      lines.push(
        `  ${host.name}: ${host.found ? `found (${host.evidence.join(", ")})` : "not found"}`,
      );
    }
  }
  lines.push("", "Changes:");
  for (const change of report.changes) {
    lines.push(
      `  ${hostNames(change.hosts)} ${KIND[change.kind]}, ${change.target}: ${change.detail}`,
    );
    if (change.diff) lines.push(indented(change.diff, "    "));
  }
  if (report.unchanged.length > 0)
    lines.push("", "Unchanged:", ...report.unchanged.map(unchangedLine));
  if (report.command !== "uninstall" && report.changes.some((change) => change.diff)) {
    lines.push(
      "",
      `Each config file is backed up to ${report.backups} before UFO first writes it.`,
    );
  }
  return `${lines.join("\n")}\n\n`;
}

/** The outcome: what changed, or why nothing had to. */
export function formatSetupReport(report: SetupReport): string {
  const lines: string[] = [];
  if (report.changed) {
    const verb = { setup: "Set up", uninstall: "Removed UFO from", update: "Updated" }[
      report.command
    ];
    const hosts = [...new Set(report.changes.flatMap((change) => change.hosts))];
    const count = report.changes.length;
    lines.push(`${verb} ${hostNames(hosts)} (${count} ${count === 1 ? "change" : "changes"}).`);
  } else if (report.hosts.length === 0) {
    lines.push("UFO has not set up any host; nothing to remove.");
  } else {
    lines.push(`Nothing to change for ${hostNames(report.hosts)} (ufo-agents@${report.version}).`);
    lines.push(...report.unchanged.map(unchangedLine));
  }
  lines.push(...report.notes);
  return `${lines.join("\n")}\n`;
}
