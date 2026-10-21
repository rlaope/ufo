"use strict";

// Preloaded (`--require`) by UFO's node-cpu profile preset. `--cpu-prof` writes its profile
// only when the process exits normally, and SIGTERM or SIGINT without a JavaScript listener
// ends the process without one; UFO stops a `start` process with SIGTERM. So on the main
// thread, a signal with no listener but this one exits normally, with the code the signal would
// have given (128 + its number). A process with a listener of its own keeps its behavior.

const { constants } = require("node:os");
const { isMainThread } = require("node:worker_threads");

if (isMainThread) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (process.listenerCount(signal) === 1) process.exit(128 + constants.signals[signal]);
    });
  }
}
