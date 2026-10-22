import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  convertJfr,
  findJfr,
  JFR_PRINT_ARGS,
  NO_JFR,
  NODE_EXIT_ON_SIGNAL,
  profileSettings,
} from "../../../src/app/profiler.js";
import { createTextRedactor } from "../../../src/core/evidence/index.js";
import { createRunState } from "../../../src/core/jobs/index.js";
import {
  JFR_LIMITS,
  type Parsed,
  summarize,
  summarizeProfile,
} from "../../../src/core/profile/index.js";

// M4 E4: the node-cpu preset and its preload, with the real node binary.

let dir: string;

beforeEach(() => {
  // Real, since V8 names scripts by their real path.
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ufo-preset-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

/**
 * Runs `script` with `env`, sends `signal` once it prints `ready`, and returns how it ended.
 * The child is killed if it is still running 4 s later.
 */
function signalled(script: string, signal: NodeJS.Signals, env: NodeJS.ProcessEnv): Promise<Exit> {
  const file = path.join(dir, "app.mjs");
  writeFileSync(file, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    // Within the test's own 5 s, so a child that ignores the signal never outlives the test.
    const guard = setTimeout(() => child.kill("SIGKILL"), 4000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("ready\n") && !stdout.includes("sent\n")) {
        stdout += "sent\n";
        child.kill(signal);
      }
    });
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      clearTimeout(guard);
      resolve({ code, signal: killedBy, stdout });
    });
  });
}

const WAITS = `setInterval(() => undefined, 1000);
console.log("ready");
`;

function withPreload(extra: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_OPTIONS: `--require "${NODE_EXIT_ON_SIGNAL}"${extra}` };
}

describe("the exit-on-signal preload", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)("turns %s without a listener into a normal exit, code %i", async (signal, code) => {
    const plain = await signalled(WAITS, signal, process.env);
    expect(plain).toMatchObject({ code: null, signal });
    const exit = await signalled(
      `process.on("exit", (code) => console.log(\`exit \${code}\`));\n${WAITS}`,
      signal,
      withPreload(""),
    );
    expect(exit).toMatchObject({ code, signal: null });
    expect(exit.stdout).toContain(`exit ${code}`);
  });

  // signal-exit's rule (v3 counts its listeners on process.__signal_exit_emitter__, v4 on
  // Symbol.for("signal-exit emitter")): it acts only when its listeners are all there are.
  it.each([
    ["v3", "process.__signal_exit_emitter__ = emitter;"],
    [
      "v4",
      'Object.defineProperty(globalThis, Symbol.for("signal-exit emitter"), { value: emitter });',
    ],
  ])(
    "does not wait for signal-exit %s, which waits for it, and its exit callback runs",
    async (_v, publish) => {
      const out = path.join(dir, "prof");
      const { env } = profileSettings({ preset: "node-cpu" }, out);
      const script = `const emitter = { count: 0 };
${publish}
const emit = process.emit;
process.emit = function (event, code, ...rest) {
  if (event === "exit") console.log(\`cleanup \${code}\`);
  return emit.call(this, event, code, ...rest);
};
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, function listener() {
    if (process.listeners(sig).length === emitter.count) {
      process.removeListener(sig, listener);
      console.log("signal-exit acted");
      process.kill(process.pid, sig);
    }
  });
}
emitter.count += 1;
${WAITS}`;
      const bare = await signalled(script, "SIGTERM", process.env);
      expect(bare).toMatchObject({ code: null, signal: "SIGTERM" });
      expect(bare.stdout).toContain("signal-exit acted");
      const started = Date.now();
      const exit = await signalled(script, "SIGTERM", { ...process.env, ...env });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(exit).toMatchObject({ code: 143, signal: null });
      expect(exit.stdout).toContain("cleanup 143");
      expect(readdirSync(out)).toHaveLength(1);
    },
  );

  it("leaves a process with its own listener to it", async () => {
    const exit = await signalled(
      `process.on("SIGTERM", () => {
  console.log("own handler");
  setTimeout(() => process.exit(7), 50);
});
${WAITS}`,
      "SIGTERM",
      withPreload(""),
    );
    expect(exit).toMatchObject({ code: 7, signal: null });
    expect(exit.stdout).toContain("own handler");
  });

  it("listens on the main thread only", async () => {
    const exit = await signalled(
      `import { Worker } from "node:worker_threads";
const worker = new Worker(
  "require('node:worker_threads').parentPort.postMessage([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]);",
  { eval: true },
);
worker.on("message", (counts) => {
  console.log(\`worker \${counts} main \${process.listenerCount("SIGTERM")},\${process.listenerCount("SIGINT")}\`);
  ${WAITS.replace(/\n/g, "\n  ")}
});`,
      "SIGTERM",
      withPreload(""),
    );
    expect(exit.stdout).toContain("worker 0,0 main 1,1");
    expect(exit.code).toBe(143);
  });

  it("lets node --cpu-prof write its profile when the process is stopped with SIGTERM", async () => {
    const out = path.join(dir, 'prof ile "dir"');
    const { env } = profileSettings({ preset: "node-cpu" }, out);
    const script = `function spin() {
  const end = Date.now() + 200;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}
spin();
${WAITS}`;
    const exit = await signalled(script, "SIGTERM", { ...process.env, ...env });
    expect(exit).toMatchObject({ code: 143, signal: null });
    const [file, ...more] = readdirSync(out);
    expect(more).toEqual([]);
    const summary = summarizeProfile(
      file ?? "",
      readFileSync(path.join(out, file ?? ""), "utf8"),
      "cpuprofile",
      [`file://${dir}/`],
    );
    expect(summary).toMatchObject({ valid: true, unit: "microseconds" });
    if (!summary.valid) throw new Error(summary.reason);
    if (summary.kind !== "stacks") throw new Error("a bundle");
    expect(summary.self.map((s) => s.frame)).toContain("spin (app.mjs:1)");
    // Without the preload, the same stop writes nothing.
    rmSync(out, { recursive: true });
    const bare = await signalled(script, "SIGTERM", {
      ...process.env,
      NODE_OPTIONS: `--cpu-prof --cpu-prof-dir="${out.replace(/"/g, '\\"')}"`,
    });
    expect(bare).toMatchObject({ code: null, signal: "SIGTERM" });
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
  });
});

describe("profileSettings", () => {
  it("expands node-cpu into NODE_OPTIONS after the one the run passes, quoted for node", () => {
    const preload = NODE_EXIT_ON_SIGNAL.replace(/[\\"]/g, "\\$&");
    expect(profileSettings({ preset: "node-cpu" }, "/runs/a b/p")).toEqual({
      env: { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir="/runs/a b/p" --require "${preload}"` },
      format: "cpuprofile",
    });
    expect(
      profileSettings({ preset: "node-cpu" }, '/x"y', { NODE_OPTIONS: "--max-old-space-size=512" }),
    ).toEqual({
      env: {
        NODE_OPTIONS: `--max-old-space-size=512 --cpu-prof --cpu-prof-dir="/x\\"y" --require "${preload}"`,
      },
      format: "cpuprofile",
    });
    expect(existsSync(NODE_EXIT_ON_SIGNAL)).toBe(true);
  });

  it("puts the directory in place of {{profile_dir}} in the listed variables", () => {
    expect(
      profileSettings(
        { env: { OUT: "{{profile_dir}}/a-{{profile_dir}}", N: "1" }, format: "collapsed" },
        "/p",
      ),
    ).toEqual({ env: { OUT: "/p/a-/p", N: "1" }, format: "collapsed" });
    // The directory as it is, never a replacement pattern.
    expect(
      profileSettings({ env: { OUT: "{{profile_dir}}/x" }, format: "collapsed" }, "/r$&$$/p").env,
    ).toEqual({ OUT: "/r$&$$/p/x" });
    expect(profileSettings({ format: "speedscope" }, "/p")).toEqual({
      env: {},
      format: "speedscope",
    });
  });
});

// M6: the jvm-jfr preset, its jfr tool, and the conversion, with stand-ins for the JDK's tools.
describe("the jvm-jfr preset", () => {
  const flight = (dir: string) =>
    `"-XX:StartFlightRecording=filename=${dir},dumponexit=true,settings=profile"`;

  it("adds a recording into the directory to JAVA_TOOL_OPTIONS, after the one the run passes", () => {
    expect(profileSettings({ preset: "jvm-jfr" }, "/runs/a b/p")).toEqual({
      env: { JAVA_TOOL_OPTIONS: flight("/runs/a b/p") },
      format: "jfr",
    });
    expect(
      profileSettings({ preset: "jvm-jfr" }, "/p", { JAVA_TOOL_OPTIONS: "-Xmx512m -Dx='a b'" }).env,
    ).toEqual({ JAVA_TOOL_OPTIONS: `-Xmx512m -Dx='a b' ${flight("/p")}` });
    expect(profileSettings({ preset: "jvm-jfr" }, "{{profile_dir}}").env).toEqual({
      JAVA_TOOL_OPTIONS: flight("{{profile_dir}}"),
    });
  });

  it.each([",", '"', "'", "%"])("refuses a directory with %s in it", (char) => {
    expect(() => profileSettings({ preset: "jvm-jfr" }, `/runs/a${char}b/p`)).toThrow(
      "-XX:StartFlightRecording cannot take",
    );
  });
});

describe("findJfr", () => {
  /** An executable script at `file`. */
  function tool(file: string, body = "exit 0"): string {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  it("takes $JAVA_HOME/bin/jfr, else the jfr next to the real file of the first java on PATH", async () => {
    const home = path.join(dir, "jdk-a");
    tool(path.join(home, "bin", "jfr"));
    const jdk = path.join(dir, "jdk-b", "bin");
    tool(path.join(jdk, "java"));
    tool(path.join(jdk, "jfr"));
    // /usr/bin/java as an alternatives link into the JDK.
    mkdirSync(path.join(dir, "usr-bin"));
    symlinkSync(path.join(jdk, "java"), path.join(dir, "usr-bin", "java"));
    const PATH = ["relative/bin", path.join(dir, "empty"), path.join(dir, "usr-bin")].join(":");
    expect(await findJfr({ JAVA_HOME: home, PATH })).toBe(path.join(home, "bin", "jfr"));
    expect(await findJfr({ PATH })).toBe(path.join(jdk, "jfr"));
    // A JAVA_HOME without jfr, or not absolute, leaves PATH's.
    expect(await findJfr({ JAVA_HOME: path.join(dir, "empty"), PATH })).toBe(path.join(jdk, "jfr"));
    expect(await findJfr({ JAVA_HOME: "jdk-a", PATH })).toBe(path.join(jdk, "jfr"));
    expect(await findJfr({})).toBeUndefined();
  });

  it("looks next to the first java only, and skips a jfr it cannot run", async () => {
    tool(path.join(dir, "first", "java"));
    tool(path.join(dir, "second", "java"));
    tool(path.join(dir, "second", "jfr"));
    const PATH = `${path.join(dir, "first")}:${path.join(dir, "second")}`;
    expect(await findJfr({ PATH })).toBeUndefined();
    tool(path.join(dir, "first", "jfr"));
    expect(await findJfr({ PATH })).toBe(path.join(dir, "first", "jfr"));
    chmodSync(path.join(dir, "first", "jfr"), 0o644);
    expect(await findJfr({ PATH })).toBeUndefined();
  });

  it("searches the PATH UFO's own processes get: no node_modules entry, none inside untrusted", async () => {
    const jdk = path.join(dir, "jdk", "bin");
    tool(path.join(jdk, "java"));
    tool(path.join(jdk, "jfr"));
    // npx puts a project's .bin directories first; a package could ship a java and a jfr there.
    const bin = path.join(dir, "app", "node_modules", ".bin");
    tool(path.join(bin, "java"));
    tool(path.join(bin, "jfr"));
    expect(await findJfr({ PATH: `${bin}:${jdk}` })).toBe(path.join(jdk, "jfr"));
    // An entry inside a git directory, as captureEnv's roots list them.
    const gitDir = path.join(dir, "repo", ".git");
    tool(path.join(gitDir, "hooks", "java"));
    tool(path.join(gitDir, "hooks", "jfr"));
    const PATH = `${path.join(gitDir, "hooks")}:${jdk}`;
    expect(await findJfr({ PATH }, [gitDir])).toBe(path.join(jdk, "jfr"));
  });

  it("never takes a jfr under node_modules, however it is reached", async () => {
    const pkg = path.join(dir, "app", "node_modules", "some-jdk", "bin");
    tool(path.join(pkg, "java"));
    tool(path.join(pkg, "jfr"));
    // A java outside that leads into it, and a JAVA_HOME there.
    mkdirSync(path.join(dir, "bin"));
    symlinkSync(path.join(pkg, "java"), path.join(dir, "bin", "java"));
    expect(await findJfr({ PATH: path.join(dir, "bin") })).toBeUndefined();
    expect(await findJfr({ JAVA_HOME: path.dirname(pkg) })).toBeUndefined();
    // A JAVA_HOME there leaves PATH's.
    const jdk = path.join(dir, "jdk", "bin");
    tool(path.join(jdk, "java"));
    tool(path.join(jdk, "jfr"));
    expect(await findJfr({ JAVA_HOME: path.dirname(pkg), PATH: jdk })).toBe(path.join(jdk, "jfr"));
  });

  it("never takes a jfr inside the repository or UFO's home", async () => {
    const repo = path.join(dir, "repo");
    tool(path.join(repo, "jdk", "bin", "jfr"));
    tool(path.join(repo, "jdk", "bin", "java"));
    // A java outside that leads inside.
    mkdirSync(path.join(dir, "bin"));
    symlinkSync(path.join(repo, "jdk", "bin", "java"), path.join(dir, "bin", "java"));
    const env = { JAVA_HOME: path.join(repo, "jdk"), PATH: path.join(dir, "bin") };
    expect(await findJfr(env)).toBe(path.join(repo, "jdk", "bin", "jfr"));
    expect(await findJfr(env, [repo])).toBeUndefined();
  });
});

describe("convertJfr", () => {
  const FIXTURE = fileURLToPath(new URL("../../fixtures/profiles/hot.jfr.json", import.meta.url));
  let runDir: string;

  beforeEach(async () => {
    ({ runDir } = await createRunState(dir, { runId: "run-jfr", repoId: "repo" }));
  });

  /** A stand-in for the JDK's jfr: refuses JVM option variables and other arguments, then `body`. */
  function fakeJfr(body: string): string {
    const file = path.join(dir, "jdk", "bin", "jfr");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        "#!/bin/sh",
        '[ -z "$JAVA_TOOL_OPTIONS$_JAVA_OPTIONS" ] || { echo "a JVM option variable" >&2; exit 3; }',
        `[ "$1 $2 $3 $4 $5 $6" = "${JFR_PRINT_ARGS.join(" ")}" ] || { echo "arguments: $*" >&2; exit 2; }`,
        body,
        "",
      ].join("\n"),
    );
    chmodSync(file, 0o755);
    return file;
  }

  const convert = (
    jfr: string | undefined,
    extra: Partial<Parameters<typeof convertJfr>[1]> = {},
  ) =>
    convertJfr(path.join(dir, "it's a.jfr"), {
      jfr,
      env: {
        PATH: process.env.PATH ?? "",
        JAVA_TOOL_OPTIONS: "-XX:StartFlightRecording",
        _JAVA_OPTIONS: "-Xmx1g",
      },
      runDir,
      cwd: dir,
      redact: (text) => text,
      ...extra,
    });

  const summary = (parsed: Parsed) => summarize("x.jfr", parsed);

  it("reads what jfr print writes, without the run's JVM option variables", async () => {
    writeFileSync(path.join(dir, "it's a.jfr"), readFileSync(FIXTURE));
    const parsed = await convert(fakeJfr('cat "$7"'));
    expect(summary(parsed)).toMatchObject({
      valid: true,
      weight: 3,
      self: [{ frame: "Hot.spin", pct: 66.7 }, expect.anything()],
    });
  });

  it("reports a recording jfr cannot read, and no jfr at all, as invalid files", async () => {
    const failed = await convert(fakeJfr('echo "jfr: not a recording" >&2; exit 1'));
    expect(failed).toEqual({
      valid: false,
      reason: "jfr print exited with code 1: jfr: not a recording",
    });
    expect(await convert(undefined)).toEqual({ valid: false, reason: NO_JFR });
  });

  it("redacts jfr's error whole before cutting it: the file's name is the workload's", async () => {
    const secret = "s3cr3t-0123456789abcdef";
    const file = path.join(dir, `${"x".repeat(400)}-${secret}.jfr`);
    const jfr = fakeJfr('echo "jfr: could not read $7, not a recording" >&2; exit 1');
    const parsed = await convertJfr(file, {
      jfr,
      env: { PATH: process.env.PATH ?? "" },
      runDir,
      cwd: dir,
      redact: createTextRedactor({ env: { UFO_TEST_API_TOKEN: secret } }),
    });
    if (parsed.valid) throw new Error("valid");
    expect(parsed.reason).not.toContain(secret);
    // Unredacted, the cut would keep only the secret's end.
    expect(parsed.reason).not.toContain(secret.slice(-8));
    expect(parsed.reason).toMatch(
      /^jfr print exited with code 1: x+-<redacted:[a-z-]+>\.jfr, not a recording$/,
    );
  });

  it("stops jfr print at the output limit and keeps the samples read", async () => {
    const event =
      '{"type": "jdk.ExecutionSample", "values": {"stackTrace": {"truncated": false, "frames": [{"method": {"type": {"name": "app\\/Loop"}, "name": "run"}}]}}}';
    // Endless output, until UFO stops it.
    const jfr = fakeJfr(
      `printf '{"recording": {"events": ['; while :; do printf '%s, ' '${event}'; done`,
    );
    const started = performance.now();
    // Its own timeout, so the endless writer is gone within the test even if the limit failed.
    const parsed = summary(
      await convert(jfr, { limits: { ...JFR_LIMITS, outputBytes: 65_536 }, timeoutMs: 3000 }),
    );
    // Stopped at the limit, well before its own timeout.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(parsed).toMatchObject({ valid: true, self: [{ frame: "app.Loop.run", pct: 100 }] });
    expect(parsed.valid && parsed.kind === "stacks" && parsed.note).toMatch(
      /^jfr print wrote more than 0\.0625 MiB: the first \d+ samples are counted$/,
    );
  });

  it("keeps what was read when jfr print runs out of time", async () => {
    const jfr = fakeJfr(
      `cat <<'EOF'\n{"recording": {"events": [{"type": "jdk.ExecutionSample", "values": {"stackTrace": {"frames": [{"method": {"type": {"name": "A"}, "name": "b"}}]}}}\nEOF\nexec sleep 30`,
    );
    // Long enough that the shell has written its event on a loaded machine.
    const parsed = summary(await convert(jfr, { timeoutMs: 1500 }));
    expect(parsed).toMatchObject({ valid: true, weight: 1 });
    expect(parsed.valid && parsed.kind === "stacks" && parsed.note).toBe(
      "jfr print ran out of its 1.5 s: the first 1 samples are counted",
    );
  });

  it("throws when the job is cancelled, rather than reporting the file", async () => {
    const cancelled = new AbortController();
    const running = convert(fakeJfr("exec sleep 30"), { signal: cancelled.signal });
    setTimeout(() => cancelled.abort(new Error("cancelled")), 100);
    await expect(running).rejects.toThrow("cancelled");
  });
});
