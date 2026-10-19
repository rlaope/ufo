// Runs the real `ufo` CLI from the TypeScript sources, as `node cli-entry.mjs <args>`.
import "./ts-hooks.mjs";

await import("../../../src/cli/index.ts");
