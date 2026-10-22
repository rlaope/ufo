import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cancelRun, type ProfileResult, profileTarget, startRun } from "../../src/app/index.js";
import { findJfr, JFR_PRINT_ARGS, NO_JFR } from "../../src/app/profiler.js";
import type { FileHotspots } from "../../src/core/profile/index.js";
import { approveToy, git, makeToy, TIMEOUT_MS, type Toy, waitDone } from "./helpers.js";

// M6: the jvm-jfr preset through a whole profile job. With stand-ins for the JDK's java and jfr
// it runs everywhere; with a real JDK (CI's) a JVM records itself and a JVM it starts, and
// UFO's jfr print reads both recordings.

const FIXTURE = fileURLToPath(new URL("../fixtures/profiles/hot.jfr.json", import.meta.url));

/** The toy with `workload` (each line indented under it), `files` committed, and `env` listed. */
function jvmToy(
  workload: string[],
  files: Record<string, string>,
  env: Record<string, string>,
): { toy: Toy; logDir: string } {
  const logDir = mkdtempSync(path.join(tmpdir(), "ufo-it-jfr-"));
  const all = { TOY_LOG_DIR: logDir, ...env };
  const listed = Object.keys(all)
    .filter((name) => name !== "PATH")
    .map((name) => `  - ${name}\n`)
    .join("");
  const toy = makeToy({
    env: all,
    config: (yaml) => {
      const start = yaml.indexOf("workload:\n");
      const end = yaml.indexOf("cards:\n");
      const lines = ["workload:", ...workload.map((line) => `  ${line}`), "oracles: []", ""];
      return `${yaml.slice(0, start)}${lines.join("\n")}${yaml.slice(end)}env:\n${listed}`;
    },
  });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(toy.repo, name), text);
  git(toy.repo, "add", "--all");
  git(toy.repo, "commit", "--quiet", "--message", "jvm workload");
  return { toy, logDir };
}

async function profileOnce(toy: Toy) {
  const run = await startRun(toy.context);
  expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
  const queued = await profileTarget(toy.context, { runId: run.runId });
  const job = await waitDone(toy, run.runId, queued.jobId);
  expect(job.status, job.error?.message).toBe("succeeded");
  const dir = path.join(toy.runDir(run.runId), "artifacts", `profile-${queued.jobId}`);
  return { run, dir, profile: job.result as unknown as ProfileResult };
}

function selfFrames(file: FileHotspots | undefined): string[] {
  if (file === undefined) throw new Error("no such file");
  if (!file.valid) throw new Error(`${file.file}: ${file.reason}`);
  if (file.kind !== "stacks") throw new Error(`${file.file} is a bundle`);
  return file.self.map((share) => share.frame);
}

/** A secret the workload names a file with; the run passes it as a listed variable. */
const SECRET = "s3cr3t-0123456789abcdef";

const flight = (dir: string) =>
  `"-XX:StartFlightRecording=filename=${dir},dumponexit=true,settings=profile"`;

/** The measured command: in a profile job, what two JVMs would leave, and the variable it got. */
const BENCH = `import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const env = process.env;
writeFileSync(path.join(env.TOY_LOG_DIR, \`options-\${env.UFO_PHASE}\`), env.JAVA_TOOL_OPTIONS ?? "");
if (env.UFO_PROFILE_DIR !== undefined) {
  copyFileSync(env.TOY_FIXTURE, path.join(env.UFO_PROFILE_DIR, "hotspot-pid-1-id-1.jfr"));
  // Named with a secret, which jfr's error repeats.
  writeFileSync(path.join(env.UFO_PROFILE_DIR, \`broken-\${env.TOY_API_TOKEN}.jfr\`), "not a recording");
}
console.log(JSON.stringify({ latency_ms: 1, error_rate: 0 }));
`;

/** A bin directory with a java stand-in, and with `jfr` a stand-in that prints the file. */
function standInJdk(withJfr: boolean): string {
  const bin = mkdtempSync(path.join(tmpdir(), "ufo-it-jdk-"));
  const tool = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  tool("java", "exit 1");
  if (withJfr) {
    tool(
      "jfr",
      [
        '[ -z "$JAVA_TOOL_OPTIONS" ] || { echo "got JAVA_TOOL_OPTIONS" >&2; exit 3; }',
        `[ "$1 $2 $3 $4 $5 $6" = "${JFR_PRINT_ARGS.join(" ")}" ] || { echo "arguments: $*" >&2; exit 2; }`,
        'case "$7" in *broken-*) echo "$7: not a Flight Recorder file" >&2; exit 1;; esac',
        'cat "$7"',
      ].join("\n"),
    );
  }
  return bin;
}

describe("the jvm-jfr preset, with stand-ins for the JDK's tools", { timeout: TIMEOUT_MS }, () => {
  it("shows its expansion and conversion at approval, then reads each recording with jfr print", async () => {
    const bin = standInJdk(true);
    const { toy, logDir } = jvmToy(
      ["command: node bench.mjs", "profile:", "  preset: jvm-jfr"],
      { "bench.mjs": BENCH },
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        JAVA_TOOL_OPTIONS: "-Xmx64m",
        TOY_FIXTURE: FIXTURE,
        TOY_API_TOKEN: SECRET,
      },
    );
    try {
      const printed: string[] = [];
      await approveToy(toy, { print: (text) => printed.push(text) });
      expect(printed.join("")).toContain(
        [
          "  every step of a profile job gets UFO_PROFILE_DIR, a new directory in the run state; UFO reads the jfr files written there",
          "  profiled steps: command; they also get these variables, {{profile_dir}} replaced with that directory",
          "  preset jvm-jfr: JDK Flight Recorder, built into JDK 11 and later; each JVM a profiled step starts writes its own recording into the directory when it exits, SIGTERM included; JAVA_TOOL_OPTIONS goes after the value env: passes",
          `  profile env JAVA_TOOL_OPTIONS: ${JSON.stringify(flight("{{profile_dir}}"))}`,
          "  each recording is read after teardown with $JAVA_HOME/bin/jfr, else the jfr next to the java on PATH, in the run's environment without JAVA_TOOL_OPTIONS and _JAVA_OPTIONS:",
          `  profile convert: ${JSON.stringify(`jfr ${JFR_PRINT_ARGS.join(" ")} {{profile_dir}}/<file>`)}`,
        ].join("\n"),
      );
      const { run, dir, profile } = await profileOnce(toy);
      const options = (phase: string) =>
        readFileSync(path.join(logDir, `options-${phase}`), "utf8");
      expect(options("baseline")).toBe("-Xmx64m");
      expect(options("profile")).toBe(`-Xmx64m ${flight(dir)}`);
      // Reading the recordings is a timed step of its own, after teardown.
      expect(profile.phases.map((p) => p.phase)).toEqual(["sample", "teardown", "convert"]);
      expect(profile.hotspots).toMatchObject({ format: "jfr", omitted: 0 });
      const [recording, broken] = profile.hotspots?.files ?? [];
      expect(recording).toMatchObject({ file: "hotspot-pid-1-id-1.jfr", unit: "samples" });
      expect(selfFrames(recording)[0]).toBe("Hot.spin");
      // jfr's error repeats the file's name: redacted whole before it was cut.
      expect(broken).toMatchObject({
        valid: false,
        file: expect.stringMatching(/^broken-<redacted:/),
      });
      expect(JSON.stringify(profile.hotspots)).not.toContain(SECRET);
      expect(broken?.valid === false && broken.reason).toMatch(
        /^jfr print exited with code 1: broken-<redacted:[a-z-]+>\.jfr: not a Flight Recorder file$/,
      );
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reports each recording without a jfr tool, and the job still succeeds", async () => {
    const bin = standInJdk(false);
    const { toy, logDir } = jvmToy(
      ["command: node bench.mjs", "profile:", "  preset: jvm-jfr"],
      { "bench.mjs": BENCH },
      { PATH: `${bin}:${process.env.PATH ?? ""}`, TOY_FIXTURE: FIXTURE, TOY_API_TOKEN: SECRET },
    );
    try {
      await approveToy(toy);
      const { run, profile } = await profileOnce(toy);
      expect(profile.sample.valid).toBe(true);
      expect(profile.hotspots?.files).toEqual([
        { file: expect.stringMatching(/^broken-<redacted:/), valid: false, reason: NO_JFR },
        { file: "hotspot-pid-1-id-1.jfr", valid: false, reason: NO_JFR },
      ]);
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
      rmSync(logDir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

// The real JDK: java on PATH with jfr next to its real file, else $JAVA_HOME's. Found without
// running anything, so a machine whose /usr/bin/java is only a stub never runs it.
const VIA_PATH = await findJfr({ PATH: process.env.PATH });
const VIA_HOME =
  VIA_PATH === undefined ? await findJfr({ JAVA_HOME: process.env.JAVA_HOME }) : undefined;
const JDK_JFR = VIA_PATH ?? VIA_HOME;
const JDK_BIN = JDK_JFR === undefined ? undefined : path.dirname(JDK_JFR);
const IN_CI = (process.env.CI ?? "") !== "" && process.env.CI !== "false";

/**
 * Two JVMs, as Maven and its test fork are: the parent spins in parentWork, then starts a child
 * with the same java, which spins in childWork and prints the JSON line. Only a profile job
 * spins or starts the child, so baselines stay short.
 */
const HOT = `public class Hot {
    static long parentWork(long ms) {
        long end = System.currentTimeMillis() + ms, x = 1;
        while (System.currentTimeMillis() < end) {
            for (int i = 0; i < 100_000; i++) x = x * 6364136223846793005L + 1442695040888963407L;
        }
        return x;
    }

    static long childWork(long ms) {
        long end = System.currentTimeMillis() + ms, x = 3;
        while (System.currentTimeMillis() < end) {
            for (int i = 0; i < 100_000; i++) x = x * 2862933555777941757L + 3037000493L;
        }
        return x;
    }

    public static void main(String[] args) throws Exception {
        String line = "{\\"latency_ms\\": 1, \\"error_rate\\": 0}";
        if (System.getenv("UFO_PROFILE_DIR") == null) {
            System.out.println(line);
            return;
        }
        if (args.length > 0) {
            System.out.println(childWork(800) == 42 ? "{}" : line);
            return;
        }
        long x = parentWork(800);
        String java = ProcessHandle.current().info().command().orElseThrow();
        Process child = new ProcessBuilder(java, "Hot.java", "child").inheritIO().start();
        int code = child.waitFor();
        System.exit(x == 42 ? 1 : code);
    }
}
`;

describe("the jvm-jfr preset with a real JVM", { timeout: TIMEOUT_MS }, () => {
  // CI must run this: there a missing JDK fails the test instead of skipping it.
  it.skipIf(JDK_BIN === undefined && !IN_CI)(
    "records a JVM and the JVM it starts, each in its own file, and finds their hot methods",
    async () => {
      expect(JDK_BIN, "no java with jfr next to it on PATH, nor $JAVA_HOME/bin/jfr").toBeDefined();
      const java = path.join(JDK_BIN ?? "", "java");
      // JDK 17 and later print the recording's start on stdout unless -Xlog:jfr+startup says
      // otherwise; older ones know no such tag and refuse it.
      const quiet = spawnSync(java, ["-Xlog:jfr+startup=error", "-version"]).status === 0;
      const env: Record<string, string> = quiet
        ? { JAVA_TOOL_OPTIONS: "-Xlog:jfr+startup=error" }
        : {};
      if (VIA_PATH === undefined) env.JAVA_HOME = process.env.JAVA_HOME ?? "";
      const command = VIA_PATH === undefined ? '"$JAVA_HOME/bin/java" Hot.java' : "java Hot.java";
      const { toy, logDir } = jvmToy(
        [`command: ${command}`, "profile:", "  preset: jvm-jfr"],
        { "Hot.java": HOT },
        env,
      );
      try {
        await approveToy(toy);
        const { run, dir, profile } = await profileOnce(toy);
        // With the startup line quiet, the one line on stdout is the child's.
        if (quiet) expect(profile.sample).toMatchObject({ valid: true });
        expect(profile.hotspots).toMatchObject({ format: "jfr", omitted: 0 });
        const files = profile.hotspots?.files ?? [];
        expect(files, JSON.stringify(files)).toHaveLength(2);
        for (const file of files) expect(file.file).toMatch(/\.jfr$/);
        const holding = (method: string) =>
          files.filter((file) => selfFrames(file).includes(method)).map((file) => file.file);
        expect(holding("Hot.parentWork")).toHaveLength(1);
        expect(holding("Hot.childWork")).toHaveLength(1);
        expect(holding("Hot.parentWork")).not.toEqual(holding("Hot.childWork"));
        expect(git(run.arms.a, "status", "--porcelain")).toBe("");
        expect(dir).not.toContain(run.arms.a);
        await cancelRun(toy.context, { runId: run.runId });
      } finally {
        await toy.cleanup();
        rmSync(logDir, { recursive: true, force: true });
      }
    },
  );
});
