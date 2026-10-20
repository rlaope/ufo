// The app layer as its adapters see it: what the CLI (src/cli) and the MCP server (src/mcp) call,
// with the failure mapping and the result types, and nothing else. The rest of src/app, such as
// opening run state or launching workers, stays behind these workflows. The human-only steps
// and the worker entry are in api-cli.ts, which only the CLI imports (test/unit/app/api.test.ts
// checks both).

export { redact } from "../core/evidence/index.js";
export type { JobRecord } from "../core/jobs/index.js";
export { MAX_WAIT_S } from "../core/jobs/index.js";
export { BottleneckSchema, RepoPathSchema, StackIdSchema } from "../domain/index.js";
export { packageVersion } from "./cards.js";
export type { QueuedChange, SubmitChangeOptions } from "./changes.js";
export { profileTarget, submitChange } from "./changes.js";
export { DRAFT_CONFIG, isDraftConfig } from "./config.js";
export type { AppContext, Repo } from "./context.js";
export {
  bindRepository,
  CONTROL_LOCK_WAIT_MS,
  refuseChangedRepository,
  refuseHomeDirectory,
  trustProcessPath,
} from "./context.js";
export type { ExitCode, Failure } from "./errors.js";
export {
  describeFailure,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  hintFor,
} from "./errors.js";
export type { CapabilityReport, TargetInspection, TechniqueListing } from "./inspect.js";
export { checkCapabilities, getTechnique, inspectTarget, listTechniques } from "./inspect.js";
export type { BaselineResult, ProfileResult, RunReport } from "./jobs/index.js";
export type {
  FinishedReport,
  GetJobOptions,
  ReportResult,
  RunView,
  StatusView,
} from "./queries.js";
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
