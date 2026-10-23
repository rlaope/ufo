// What only the command line may call besides api.ts: the human-only steps, which ask a person
// at a terminal (`ufo approve`, `ufo extend-budget`), `ufo init`, `ufo doctor`, and the detached
// worker's entry. Also what `ufo setup`, `uninstall`, and `update` (src/setup, which only the CLI runs)
// need: the terminal prompt, UFO's home checks, the PATH rules for the node it registers, the
// machine lock's holder, and a lock file. The MCP server never imports
// this module (test/unit/app/api.test.ts checks it).

export { heldMachineLock, LockTimeoutError, withLockFile } from "../core/jobs/index.js";
export { ensureTrustedDir, PRIVATE_DIR, trustedHome, ufoHome } from "../core/paths.js";
export { WORKER_COMMAND } from "../worker/index.js";
export type { ApproveResult } from "./approve.js";
export { approve, extendBudget } from "./approve.js";
export type { DoctorReport } from "./doctor.js";
export { doctor, EXIT_GAPS } from "./doctor.js";
export { processPath } from "./env.js";
export type { InitResult } from "./init.js";
export { init } from "./init.js";
export { runAppWorker } from "./jobs/index.js";
export { askTerminal } from "./terminal.js";
