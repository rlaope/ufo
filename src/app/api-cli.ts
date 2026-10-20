// What only the command line may call besides api.ts: the human-only steps, which ask a person
// at a terminal (`ufo approve`, `ufo extend-budget`), `ufo init`, and the detached worker's
// entry. The MCP server never imports this module (test/unit/app/api.test.ts checks it).

export { WORKER_COMMAND } from "../worker/index.js";
export type { ApproveResult } from "./approve.js";
export { approve, extendBudget } from "./approve.js";
export type { InitResult } from "./init.js";
export { init } from "./init.js";
export { runAppWorker } from "./jobs/index.js";
