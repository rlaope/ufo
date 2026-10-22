import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  invalid,
  JFR_EVENT,
  JFR_LIMITS,
  JFR_STACK_DEPTH,
  type JfrLimits,
  JfrReader,
  type Parsed,
} from "../core/profile/index.js";
import {
  PROFILE_DIR_PLACEHOLDER,
  type ProfileFormat,
  type WorkloadProfile,
} from "../domain/index.js";
import { describeResult, runCommand, succeeded } from "./commands.js";
import { inside } from "./env.js";

/** The preload of the `node-cpu` preset, as this UFO ships it. */
export const NODE_EXIT_ON_SIGNAL = fileURLToPath(
  new URL("../../src/presets/node-exit-on-signal.cjs", import.meta.url),
);

/** One `NODE_OPTIONS` argument: double-quoted, so it may hold spaces, with `\` and `"` escaped. */
function nodeOption(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export interface ProfileSettings {
  /** What the profiled steps get. */
  readonly env: Readonly<Record<string, string>>;
  readonly format: ProfileFormat;
}

/**
 * What `workload.profile` gives the profiled steps when the job's profile directory is `dir`
 * (`{{profile_dir}}` for the approval review). `node-cpu` sets `NODE_OPTIONS` to `--cpu-prof`
 * into `dir` and UFO's preload, after the `NODE_OPTIONS` the run's environment already holds
 * (`env:` can list it). `jvm-jfr` likewise adds `-XX:StartFlightRecording` to
 * `JAVA_TOOL_OPTIONS`, with `dir` as the file name: a directory, in which each JVM names its own
 * recording when it exits (JDK 11 and later; `%p` in a file name needs JDK 18).
 */
export function profileSettings(
  profile: WorkloadProfile,
  dir: string,
  runEnv: Readonly<Record<string, string | undefined>> = {},
): ProfileSettings {
  if (profile.preset === "node-cpu") {
    const ours = `--cpu-prof --cpu-prof-dir=${nodeOption(dir)} --require ${nodeOption(NODE_EXIT_ON_SIGNAL)}`;
    const before = runEnv.NODE_OPTIONS ?? "";
    return {
      env: { NODE_OPTIONS: before === "" ? ours : `${before} ${ours}` },
      format: "cpuprofile",
    };
  }
  if (profile.preset === "jvm-jfr") {
    // The JVM's option reader keeps what is between quotes with no escapes, and the recording's
    // options are split at commas, read quotes of their own, and (JDK 18 and later) expand %p and
    // %t in a file name, so none of those can be in the directory.
    if (/[,"'%]/.test(dir)) {
      throw new Error(
        `the profile directory ${dir} holds a comma, a quote, or %, which -XX:StartFlightRecording cannot take`,
      );
    }
    const ours = `"-XX:StartFlightRecording=filename=${dir},dumponexit=true,settings=profile"`;
    const before = runEnv.JAVA_TOOL_OPTIONS ?? "";
    return {
      env: { JAVA_TOOL_OPTIONS: before === "" ? ours : `${before} ${ours}` },
      format: "jfr",
    };
  }
  if (profile.format === undefined) {
    throw new Error("workload.profile has neither a preset nor a format");
  }
  return {
    env: Object.fromEntries(
      Object.entries(profile.env ?? {}).map(([name, value]) => [
        name,
        // A function, so `$&` or `$$` in the path is not a replacement pattern.
        value.replaceAll(PROFILE_DIR_PLACEHOLDER, () => dir),
      ]),
    ),
    format: profile.format,
  };
}

/** What UFO runs on each JFR recording, after the file's path. */
export const JFR_PRINT_ARGS = [
  "print",
  "--json",
  "--events",
  JFR_EVENT,
  "--stack-depth",
  String(JFR_STACK_DEPTH),
] as const;
/** How long one recording's `jfr print` may run before it is stopped. */
export const JFR_PRINT_TIMEOUT_MS = 120_000;
/** Variables `jfr print`, itself a JVM, does not get: they would start a recording in it too. */
const JVM_OPTION_VARIABLES = ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS"];
export const NO_JFR = "no jfr tool next to java or in JAVA_HOME";

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The JDK's `jfr` tool for a run's command environment: `$JAVA_HOME/bin/jfr`, else the one next
 * to the first `java` on its `PATH`, that `java` followed to its real file (`/usr/bin/java` is
 * often a link into the JDK). Never one inside `untrusted` (the repository, UFO's home), where a
 * patch could plant it; `undefined` when there is none.
 */
export async function findJfr(
  env: Readonly<Record<string, string | undefined>>,
  untrusted: readonly string[] = [],
): Promise<string | undefined> {
  // As written and as real paths: macOS's /var is /private/var.
  const roots = [
    ...untrusted.map((root) => path.resolve(root)),
    ...(await Promise.all(untrusted.map((root) => realpath(root).catch(() => path.resolve(root))))),
  ];
  const candidates: string[] = [];
  const home = env.JAVA_HOME;
  if (home !== undefined && path.isAbsolute(home)) candidates.push(path.join(home, "bin", "jfr"));
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(entry) || !(await executable(path.join(entry, "java")))) continue;
    const java = await realpath(path.join(entry, "java")).catch(() => undefined);
    if (java !== undefined) candidates.push(path.join(path.dirname(java), "jfr"));
    break;
  }
  for (const candidate of candidates) {
    if (!(await executable(candidate))) continue;
    const real = await realpath(candidate).catch(() => undefined);
    if (real !== undefined && !inside(real, roots)) return real;
  }
  return undefined;
}

/** `text` as one single-quoted shell word. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export interface JfrConversion {
  /** The tool `findJfr` found; without one every recording is invalid. */
  readonly jfr: string | undefined;
  /** The run's command environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly runDir: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly limits?: JfrLimits;
  readonly timeoutMs?: number;
}

/**
 * The execution samples of one JFR recording, read from `jfr print --json` as it streams, with
 * UFO's command runner (its own process group, a timeout, killed with its group). Reading stops
 * at the output's limits, and a timeout keeps what was read; a recording `jfr` cannot read is
 * invalid with its reason, never a failed job. Throws only when `signal` (the job) is aborted.
 */
export async function convertJfr(file: string, options: JfrConversion): Promise<Parsed> {
  if (options.jfr === undefined) return invalid(NO_JFR);
  const reader = new JfrReader(options.limits ?? JFR_LIMITS);
  const enough = new AbortController();
  const cancel = () => enough.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeoutMs = options.timeoutMs ?? JFR_PRINT_TIMEOUT_MS;
  try {
    const result = await runCommand(
      [shellWord(options.jfr), ...JFR_PRINT_ARGS, shellWord(file)].join(" "),
      {
        runDir: options.runDir,
        cwd: options.cwd,
        env: Object.fromEntries(
          Object.entries(options.env).filter(([name]) => !JVM_OPTION_VARIABLES.includes(name)),
        ),
        label: `profile jfr print ${path.basename(file)}`,
        signal: enough.signal,
        timeoutMs,
        onStdout: (chunk) => {
          if (!reader.push(chunk)) enough.abort();
        },
      },
    );
    options.signal?.throwIfAborted();
    if (result.timedOut) reader.stop(`jfr print ran out of its ${timeoutMs / 1000} s`);
    // Stopped by the reader itself: what it read is the answer.
    else if (!result.aborted && !succeeded(result)) {
      return invalid(describeResult({ ...result, command: "jfr print" }));
    }
    return reader.finish();
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}
