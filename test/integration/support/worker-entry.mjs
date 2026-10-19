// Test stand-in for `ufo worker`: the real worker loop and the app's job handlers, run from the
// TypeScript sources on a pinned machine. UFO_TEST_MACHINE=battery reports battery power, so
// every sample fails the hygiene check; anything else is an idle machine on AC power.
import "./ts-hooks.mjs";

const { runAppWorker } = await import("../../../src/app/index.ts");
const { systemClock } = await import("../../../src/core/measure/index.ts");

const power = process.env.UFO_TEST_MACHINE === "battery" ? "Battery Power" : "AC Power";
const machine = {
  readers: {
    platform: "darwin",
    pmsetBatt: async () => `Now drawing from '${power}'\n`,
    powerSupplies: async () => [],
    loadAverage: () => 0,
    cores: () => 8,
  },
  clock: systemClock,
  dockerVm: async () => undefined,
};

await runAppWorker(process.argv.slice(2), machine, { idleExitMs: 3000 });
