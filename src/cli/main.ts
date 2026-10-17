import { readFileSync } from "node:fs";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export interface CliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: ufo [options]

Make anything faster with agents, from p99 latency down to tokens per second.

Options:
  -v, --version  Print the version and exit
  -h, --help     Print this help and exit

UFO is pre-release. Commands will be added as they are implemented.
`;

// Resolves to the package root from both src/cli and dist/cli.
function readVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const pkg: unknown = JSON.parse(raw);
  if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
    const { version } = pkg;
    if (typeof version === "string") return version;
  }
  throw new Error("package.json has no version field");
}

export function main(argv: readonly string[], out: CliOutput): number {
  const [first, ...rest] = argv;
  if (first === undefined || ((first === "-h" || first === "--help") && rest.length === 0)) {
    out.stdout(USAGE);
    return EXIT_OK;
  }
  if ((first === "-v" || first === "--version") && rest.length === 0) {
    out.stdout(`${readVersion()}\n`);
    return EXIT_OK;
  }
  out.stderr(`ufo: unknown arguments: ${argv.join(" ")}\n\n${USAGE}`);
  return EXIT_USAGE;
}
