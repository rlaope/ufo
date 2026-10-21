import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_EXIT_ON_SIGNAL, profileSettings } from "../../../src/app/profiler.js";
import { summarizeProfile } from "../../../src/core/profile/index.js";

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
 * The child is killed if it outlives the test's budget.
 */
function signalled(script: string, signal: NodeJS.Signals, env: NodeJS.ProcessEnv): Promise<Exit> {
  const file = path.join(dir, "app.mjs");
  writeFileSync(file, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    const guard = setTimeout(() => child.kill("SIGKILL"), 10_000);
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
