# Changelog

All notable changes to UFO are listed here. Versions follow [Semantic Versioning](https://semver.org/). The release workflow publishes the section of the tagged version as the GitHub release notes ([docs/release.md](docs/release.md)).

## [0.1.0] - 2026-10-23

The first release.

### CLI and the measurement gate

- `ufo init` writes a draft `ufo.yaml` from the stacks it detects; `ufo approve` records a human-only approval of every command it lets UFO run, from an interactive terminal.
- `ufo measure`, `ufo run`, `ufo status`, `ufo resume`, `ufo cancel`, `ufo report`, and `ufo extend-budget`: runs in UFO's own clones (arm A, the current best; arm B, one candidate), driven by a detached worker, with a ledger, a machine lock, and wall-clock and technique budgets.
- The measurement gate keeps a change only when the primary metric and the correctness oracles agree: deterministic metrics against `min_effect`, stochastic metrics in five interleaved A/B pairs against `min_effect` and twice the noise floor, guardrails, and a fresh baseline-vs-final check for the report and the evidence bundle.
- Policy rejects patches that touch tests, workload or oracle specs, `ufo.yaml`, CI test steps, `.env*` files, or secrets, and any patch that shrinks the test set. UFO never touches your branch or working tree and never pushes.

### MCP server and skill

- `ufo mcp` serves UFO's tools over stdio, bound to one repository: `inspect_target`, `check_capabilities`, `list_techniques` (in pages), `get_technique`, `profile_target`, `start_run`, `submit_change`, `get_job`, `get_run`, `finish_run`, `resume_run`, and `cancel_run`.
- The `ufo-optimize` skill tells the agent how to drive a run.

### Setup

- `ufo setup`, `ufo update`, and `ufo uninstall` install a pinned copy under `$UFO_HOME/pkg` and register its MCP server and skill in Claude Code, Codex, and Cursor, showing each change as a diff and asking first. Uninstall removes exactly what setup added.

### Technique cards

- 92 technique cards from primary sources across server, JVM, build, data, frontend, and AI domains, plus a generic code-change card. Each has signals, preconditions, steps, verification, traps, expected effect, and sources; recipe cards carry their own edits.
- Stack detection from the repository's files (Node and its package managers and frameworks, JVM with Maven, Gradle, and Spring Boot, Python, Go, Rust, Docker, databases, AI serving and clients), with a suggested test command and workload hint per stack, and a working `ufo.yaml` draft.

### Profiler evidence

- `workload.profile` runs the workload once under a profiler: the `node-cpu` preset (V8 CPU profiles) and the `jvm-jfr` preset (JDK Flight Recorder), or the workload's own profiler.
- Formats read into hot spots: collapsed stacks, `cpuprofile`, speedscope, pprof, JFR (through the JDK's `jfr print`), and bundle stats (webpack, rollup-plugin-visualizer, source-map-explorer).
- Frame hints on cards rank `list_techniques` by the frames, modules, and packages a profile found, each match with its evidence.

### Doctor

- `ufo doctor [--json]` checks git, the Node.js UFO needs, and `$UFO_HOME`, then the runtimes and profilers the repository's stacks, `ufo.yaml` (or the draft `ufo init` writes), and `workload.profile` use: the JDK's `jfr`, Go for pprof, py-spy, the bundle analyzer, an async-profiler library. Each gap names what is missing, why, and an install hint; it exits 0 with no gap and 4 with one (`--json`: `ok: true`, gaps in `result.gaps`). It never runs a repository command, and its version probes are bounded by a timeout.

### Supply chain

- Published from GitHub Actions with npm trusted publishing and provenance. No install scripts, and no telemetry.
