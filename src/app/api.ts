// The app layer as its adapters see it: what the CLI (src/cli) and the MCP server (src/mcp) call,
// with the failure mapping and the result types, and nothing else. Both import only from this
// module (test/unit/app/api.test.ts checks it). The rest of src/app, such as opening run state
// or launching workers, stays behind these workflows.

export type { JobRecord } from "../core/jobs/index.js";
export { MAX_WAIT_S } from "../core/jobs/index.js";
export { WORKER_COMMAND } from "../worker/index.js";
export type { ApproveResult } from "./approve.js";
export { approve, extendBudget } from "./approve.js";
export type { QueuedChange, SubmitChangeOptions } from "./changes.js";
export { submitChange } from "./changes.js";
export type { AppContext } from "./context.js";
export { CONTROL_LOCK_WAIT_MS } from "./context.js";
export type { ExitCode, Failure } from "./errors.js";
export {
  describeFailure,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  hintFor,
} from "./errors.js";
export type { InitResult } from "./init.js";
export { init } from "./init.js";
export type { BaselineResult, RunReport } from "./jobs/index.js";
export { runAppWorker } from "./jobs/index.js";
export type { FinishedReport, ReportResult, RunView, StatusView } from "./queries.js";
export { getJob, getRun, report, status } from "./queries.js";
export type {
  CancelResult,
  MeasureResult,
  ResumeResult,
  RunToEndResult,
  StartRunOptions,
  StartRunResult,
} from "./run.js";
export { cancelRun, finishRun, measure, resumeRun, runToEnd, startRun } from "./run.js";
