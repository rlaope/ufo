import { readFileSync } from "node:fs";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  type AppContext,
  approve,
  cancelRun,
  describeFailure,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
  extendBudget,
  type Failure,
  init,
  measure,
  report,
  resumeRun,
  runAppWorker,
  runToEnd,
  status,
  WORKER_COMMAND,
} from "../app/api.js";
import { defaultRepository, serveMcp } from "../mcp/index.js";
import {
  formatApprove,
  formatCancel,
  formatExtend,
  formatMeasure,
  formatReport,
  formatResume,
  formatStatus,
} from "./format.js";

export { EXIT_OK, EXIT_USAGE };

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd?: string;
  /** App context besides `cwd` (UFO home, card directories, worker); tests pass their own. */
  context?: Omit<AppContext, "cwd">;
  /** Where SIGINT and SIGTERM arrive; `process` unless a test passes its own. */
  signals?: Pick<NodeJS.EventEmitter, "once" | "off">;
}

/**
 * Runs `work` with a signal that the first Ctrl-C (or SIGTERM) aborts, so `ufo run` and
 * `ufo measure` cancel their run instead of leaving it running with the machine lock held. A
 * second one ends the process as usual.
 */
async function interruptible<T>(
  signals: Pick<NodeJS.EventEmitter, "once" | "off">,
  say: (text: string) => void,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    signals.off("SIGINT", abort);
    signals.off("SIGTERM", abort);
    say("interrupted: cancelling the run (Ctrl-C again to stop waiting)\n");
    controller.abort();
  };
  signals.once("SIGINT", abort);
  signals.once("SIGTERM", abort);
  try {
    return await work(controller.signal);
  } finally {
    signals.off("SIGINT", abort);
    signals.off("SIGTERM", abort);
  }
}

const USAGE = `Usage: ufo <command> [options]

Make anything faster with agents, from p99 latency down to tokens per second.

Commands:
  init                Write a draft ufo.yaml at the repository root (never overwrites)
  approve             Review and approve ufo.yaml; needs an interactive terminal
                        --allow-lossy    confirm the lossy opt-in ufo.yaml requests
                        --allow-upgrade  confirm the upgrade opt-in ufo.yaml requests
  measure             Measure the current HEAD: oracle snapshot, 5 samples, noise floor
  run                 Apply each enabled recipe card once, then the final check and report
  status              List this repository's runs and show the latest one
  resume              Resume an interrupted run
  cancel              Cancel a run; its observations stay in the ledger
  report              Print a run's report
  extend-budget       Raise a run's technique cap or wall-clock budget; needs a terminal
                        --techniques <n>  techniques to add (default: the configured cap)
                        --minutes <n>     minutes to add (default: 0)
  mcp                 Serve UFO's tools to an agent over MCP on stdin and stdout
                        --repo <path>     the default repository (default: $CLAUDE_PROJECT_DIR,
                                          else the working directory)

Options:
  --run <id>     The run for status, resume, cancel, report, extend-budget (default: latest)
  --json         Print one JSON object on stdout instead of text
  -v, --version  Print the version and exit
  -h, --help     Print this help and exit

Exit codes: 0 ok, 1 refused by a policy or the human, 2 usage or config error, 3 internal error.
See docs/cli.md.
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

const COMMANDS = {
  init: {},
  approve: { "allow-lossy": { type: "boolean" }, "allow-upgrade": { type: "boolean" } },
  measure: {},
  run: {},
  status: { run: { type: "string" } },
  resume: { run: { type: "string" } },
  cancel: { run: { type: "string" } },
  report: { run: { type: "string" } },
  "extend-budget": {
    run: { type: "string" },
    techniques: { type: "string" },
    minutes: { type: "string" },
  },
  mcp: { repo: { type: "string" } },
} as const;
type Command = keyof typeof COMMANDS;

function isCommand(name: string): name is Command {
  return Object.hasOwn(COMMANDS, name);
}

class UsageError extends Error {}

function integerFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a non-negative integer`);
  return Number(value);
}

type Values = Record<string, string | boolean | undefined>;

async function execute(
  command: Exclude<Command, "mcp">,
  values: Values,
  context: AppContext,
  io: CliIo,
  json: boolean,
): Promise<{ result: unknown; text: string }> {
  const runId = typeof values.run === "string" ? values.run : undefined;
  const scoped = runId === undefined ? {} : { runId };
  // With --json, stdout carries only the JSON result; reviews and progress go to stderr.
  const print = json ? io.stderr : io.stdout;
  const progress = (text: string) => io.stderr(`${text}\n`);
  switch (command) {
    case "init": {
      const result = await init(context);
      return {
        result,
        text: `Wrote ${result.path}. Edit it, then run ufo approve in a terminal.\n`,
      };
    }
    case "approve": {
      // The human answers on the terminal itself (`/dev/tty`); stdin must be a TTY.
      const result = await approve(context, {
        print,
        allowLossy: values["allow-lossy"] === true,
        allowUpgrade: values["allow-upgrade"] === true,
      });
      return { result, text: formatApprove(result) };
    }
    case "measure": {
      const result = await interruptible(io.signals ?? process, io.stderr, (signal) =>
        measure(context, {
          signal,
          onProgress: (job) => progress(`baseline: ${job.progress?.message ?? job.status}`),
        }),
      );
      return { result, text: formatMeasure(result) };
    }
    case "run": {
      const result = await interruptible(io.signals ?? process, io.stderr, (signal) =>
        runToEnd(context, { onProgress: progress, signal }),
      );
      return { result: result.report, text: formatReport(result.report) };
    }
    case "status": {
      const result = await status(context, scoped);
      return { result, text: formatStatus(result) };
    }
    case "resume": {
      const result = await resumeRun(context, scoped);
      return { result, text: formatResume(result) };
    }
    case "cancel": {
      const result = await cancelRun(context, scoped);
      return { result, text: formatCancel(result) };
    }
    case "report": {
      const result = await report(context, scoped);
      return { result, text: formatReport(result) };
    }
    case "extend-budget": {
      const techniques = integerFlag(values.techniques as string | undefined, "techniques");
      const minutes = integerFlag(values.minutes as string | undefined, "minutes");
      const result = await extendBudget(context, {
        ...scoped,
        print,
        ...(techniques === undefined ? {} : { techniques }),
        ...(minutes === undefined ? {} : { minutes }),
      });
      return { result, text: formatExtend(result) };
    }
  }
}

/** Runs one `ufo` invocation and returns its exit code (docs/cli.md). */

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || ((first === "-h" || first === "--help") && rest.length === 0)) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if ((first === "-v" || first === "--version") && rest.length === 0) {
    io.stdout(`${readVersion()}\n`);
    return EXIT_OK;
  }
  if (first === WORKER_COMMAND) {
    await runAppWorker(argv);
    return EXIT_OK;
  }
  if (!isCommand(first)) {
    io.stderr(`ufo: unknown arguments: ${argv.join(" ")}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  let values: Values;
  try {
    const options: ParseArgsOptionsConfig = {
      ...COMMANDS[first],
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    };
    values = parseArgs({ args: [...rest], options, strict: true, allowPositionals: false })
      .values as Values;
  } catch (error) {
    io.stderr(`ufo ${first}: ${(error as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (values.help === true) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (first === "mcp") {
    // Until stdin closes. stdout is the protocol's; nothing else may print there.
    await serveMcp({
      repo: defaultRepository({
        repo: typeof values.repo === "string" ? values.repo : undefined,
        env: process.env,
        cwd: io.cwd ?? process.cwd(),
      }),
      context: io.context,
      log: (line) => io.stderr(`${line}\n`),
    });
    return EXIT_OK;
  }
  const json = values.json === true;
  const context: AppContext = { ...io.context, cwd: io.cwd ?? process.cwd() };
  try {
    const { result, text } = await execute(first, values, context, io, json);
    io.stdout(json ? `${JSON.stringify({ ok: true, command: first, result }, null, 2)}\n` : text);
    return EXIT_OK;
  } catch (error) {
    const failure: Failure =
      error instanceof UsageError
        ? { exitCode: EXIT_USAGE, code: "usage", message: error.message, retryable: false }
        : describeFailure(error);
    if (json) {
      io.stdout(
        `${JSON.stringify({ ok: false, command: first, error: { code: failure.code, message: failure.message } }, null, 2)}\n`,
      );
    } else {
      const { hint } = failure;
      io.stderr(`ufo ${first}: ${failure.code}: ${failure.message}${hint ? `; ${hint}` : ""}\n`);
    }
    return failure.exitCode === EXIT_OK ? EXIT_INTERNAL : failure.exitCode;
  }
}
