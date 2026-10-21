import { fileURLToPath } from "node:url";
import {
  PROFILE_DIR_PLACEHOLDER,
  type ProfileFormat,
  type WorkloadProfile,
} from "../domain/index.js";

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
 * (`env:` can list it).
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
