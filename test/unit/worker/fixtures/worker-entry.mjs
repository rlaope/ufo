// Test-only stand-in for `ufo worker`: runs the real worker main loop from the TypeScript
// sources with a few trivial job handlers. Node strips the types; the resolve hook maps the
// sources' `./x.js` import specifiers to `./x.ts`.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.endsWith(".ts")
    ) {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { parseWorkerArgv, runWorker, trackChildGroup } = await import(
  "../../../../src/worker/index.ts"
);

const argv = process.argv.slice(2);
const { runDir } = parseWorkerArgv(argv);
const heartbeatIndex = argv.indexOf("--heartbeat-ms");
const heartbeatMs = heartbeatIndex === -1 ? 2000 : Number(argv[heartbeatIndex + 1]);

// Callers await other work first, so the signal may already be aborted: an abort event that
// already fired never fires again.
function untilAborted(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

await runWorker({
  runDir,
  heartbeatMs,
  idleExitMs: 200,
  handlers: {
    echo: (job) => job.input,
    // Starts a child group that ignores SIGTERM, records it, and runs until cancelled.
    stubborn_child: async (job, context) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);",
          job.input.readyFile,
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      await trackChildGroup(runDir, child.pid);
      await untilAborted(context.signal);
    },
    wait_for_cancel: async (_job, context) => {
      context.setProgress({ done: 0, message: "waiting" });
      writeFileSync(`${runDir}/waiting`, "");
      await untilAborted(context.signal);
    },
  },
});
