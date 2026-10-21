"use strict";

// Preloaded (`--require`) by UFO's node-cpu profile preset. `--cpu-prof` writes its profile
// only when the process exits normally, and SIGTERM or SIGINT without a JavaScript listener
// ends the process without one; UFO stops a `start` process with SIGTERM. So on the main
// thread, a signal with no listener but this one exits normally, with the code the signal would
// have given (128 + its number). A process with a listener of its own keeps its behavior.
//
// signal-exit (v3 and v4, under execa, write-file-atomic, and others) acts only when its own
// listeners are the only ones, so its listeners are not the process's own: counted as such,
// each side would wait for the other and the signal would do nothing. Its exit callbacks still
// run on the normal exit, since it hooks `process.emit` and `process.reallyExit`.

const { constants } = require("node:os");
const { isMainThread } = require("node:worker_threads");

/** Listeners signal-exit holds per signal: v3 counts them on process, v4 on a global symbol. */
function signalExitListeners() {
  const counts = [process.__signal_exit_emitter__, globalThis[Symbol.for("signal-exit emitter")]];
  return counts.reduce(
    (sum, emitter) => sum + (typeof emitter?.count === "number" ? emitter.count : 0),
    0,
  );
}

if (isMainThread) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (process.listenerCount(signal) - 1 - signalExitListeners() <= 0) {
        process.exit(128 + constants.signals[signal]);
      }
    });
  }
}
