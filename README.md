# UFO: Ultrafast Optimization

Make anything faster with agents, from p99 latency down to tokens per second.

**Point your agent at something slow. Get it back faster, with every number measured and every change in its own commit.**

> [!IMPORTANT]
> The only official sources are the [`ufo-agents`](https://www.npmjs.com/package/ufo-agents) package on npm and [`rlaope/ufo`](https://github.com/rlaope/ufo) on GitHub. The npm package named `ufo` is an unrelated project, so `npx ufo` runs someone else's code.

**Status: 0.1.0, early release.**

UFO is an agent toolkit for making software measurably faster: one npm package with a CLI, an MCP server, and an agent skill for Claude Code, Codex, and Cursor. Coding agents can write a patch, but they often lack the performance knowledge to pick the right one. UFO supplies that knowledge: a method for naming the bottleneck, technique cards written from primary sources (when to use each one, how, how to verify it, and its traps), stack detection that writes a working `ufo.yaml` draft, and hot spots read from your profiler's output. It also supplies a measurement gate. The agent proposes one change at a time, and UFO keeps it only when interleaved A/B measurements and your correctness oracles agree.

## Quick start

1. **Set up your agent.**

   ```sh
   npx ufo-agents setup
   ```

   Setup installs this version under `$UFO_HOME/pkg` (default `~/.ufo`) and registers its MCP server and the `ufo-optimize` skill in each host it finds: Claude Code (`claude-code`), Codex (`codex`), and Cursor (`cursor`). It shows every change as a diff and asks first. `--host <id>` limits it to the hosts you name. Restart the host afterwards, or reconnect with `/mcp`.

2. **Check the machine.** In the repository you want to optimize:

   ```sh
   npx ufo-agents doctor
   ```

   It names each tool the repository's runs need and this machine lacks (git, Node.js 22 or later, and the runtimes and profilers its stacks and `ufo.yaml` use), each with an install hint. It exits 4 when something is missing.

3. **Ask your agent to optimize something**, for example "make `GET /items` faster" or "shrink the initial JavaScript bundle". The `ufo-optimize` skill tells it how to drive UFO.

Terminal commands are written below as `ufo <command>`. Run them as `npx ufo-agents <command>`, or install the CLI with `npm install -g ufo-agents`. Use the version setup installed: an approval covers the built-in cards of one UFO version.

## How a run goes

You agree with the agent on one primary metric, its direction, the scenario, and a command that runs the scenario and prints the metric as one JSON line. Then the agent works through UFO's MCP tools:

1. **Draft.** `inspect_target` detects the stacks and, without a `ufo.yaml`, returns a commented draft. The agent fills in the workload command, the oracles (the test suite whose passing set must not shrink), the cards to enable, and the `workload.profile` block. `ufo init` writes the same draft from the terminal.
2. **Approve.** You read the file and run `ufo approve` in your own terminal. It prints every command UFO will run and records a hash of `ufo.yaml` and of each enabled card. No MCP tool approves, and a changed file needs approval again.
3. **Check.** `check_capabilities` reports programs the approved commands need that are missing; `ufo doctor` also checks what the stack and the profiler need.
4. **Baseline.** `start_run` creates the branch `ufo/run-<id>` and two clones of your repository under UFO's home: arm A (the current best) and arm B (A plus one candidate). Its baseline job runs the oracles and measures arm A to learn the noise floor.
5. **Profile.** `profile_target` runs the workload once in arm A under the profiler `workload.profile` sets up and returns the hot spots: the top self and total frames and the heaviest stacks, or a bundle's largest modules and packages.
6. **Choose.** The agent names the bottleneck with the skill's bottleneck guide, then calls `list_techniques` with the stack, the bottleneck, and `profile_job_id`. Cards whose frame hints match the profile come first, each with the frame and share that matched. It reads each candidate with `get_technique` and checks its signals and preconditions against the evidence.
7. **Change.** The agent writes one diff against arm A and calls `submit_change` with the card, the diff, its hypothesis, and the evidence. It polls `get_job` for UFO's decision: keep, drop, or inconclusive, with the reason. A kept change becomes the new arm A.
8. **Finish.** `finish_run` measures the baseline against the final commit, writes the report and an evidence bundle, and leaves the run branch in your repository for you to review and merge.

The tools that start work return a job id at once, and the agent polls `get_job` until the job is done. If a run is interrupted, `resume_run` continues it and `cancel_run` ends it. You raise a run's budget with `ufo extend-budget`, also in your own terminal.

Without an agent, `ufo measure` measures the current `HEAD`, and `ufo run` applies the enabled recipe cards from your own card directories. All built-in cards are guided: the agent writes their changes.

The MCP tools are described in [docs/mcp.md](docs/mcp.md), and the commands, `ufo.yaml`, and profiling in [docs/cli.md](docs/cli.md).

## Stacks and profiler evidence

UFO detects stacks by reading files at the repository root; it runs no repository command. Each detected stack gets a suggested test command and a hint on what to measure, and the draft `ufo.yaml` carries the profiler block for it.

| Stack | Detected from | Profiler evidence UFO reads |
|---|---|---|
| Node | `package.json` and its lockfiles | `preset: node-cpu`: V8 `.cpuprofile` files from `node --cpu-prof`, active in the draft |
| JVM, Spring Boot (Maven, Gradle) | `pom.xml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `gradle/libs.versions.toml` | `preset: jvm-jfr`: JDK Flight Recorder recordings, read with the JDK's `jfr print`. Alternative: async-profiler's `collapsed` output through `JAVA_TOOL_OPTIONS` |
| Go | `go.mod` | `format: pprof`, from `go test -cpuprofile` or a server's `net/http/pprof` |
| Python | `pyproject.toml`, `requirements*.txt`, `setup.cfg`, `setup.py`, `pytest.ini` | `format: collapsed`, from py-spy (`record -f raw`; needs root on macOS) or, on Python 3.15 and later, `python -m profiling.sampling run --collapsed`, as a wrapper that only a profile job expands |
| Frontend bundles (Vite, webpack, Next.js) | `package.json` | `format: bundle-stats`: rollup-plugin-visualizer `raw-data` JSON, webpack stats, or source-map-explorer `--json` |
| Any stack | | Any profiler that writes `collapsed` or `speedscope` files into `$UFO_PROFILE_DIR` |

UFO also detects Rust (Cargo), Docker, Postgres and MySQL, Hibernate, llama.cpp, vLLM, PyTorch, and OpenAI-compatible clients, so `list_techniques` can filter cards by them. They have no profiler block in the draft. Profiling runs only in profile jobs: baselines, samples, oracles, and the final check stay unprofiled.

## Technique cards

UFO ships 92 technique cards, plus one generic card for a plain behavior-preserving code change. Each card was written from primary sources, such as a project's official documentation, and links them. It lists the signals that point at it, its preconditions, steps, verification, traps, and expected effect.

| Domain | Cards | Covers |
|---|---|---|
| `server` | 16 | Node, Python, and Go services: event-loop blocking, worker threads, keep-alive, serialization, GC and memory limits, PGO |
| `jvm` | 15 | JVM and Spring Boot: startup (CDS, AOT cache, Spring AOT, lazy init, CRaC, native image), GC, heap sizing, pools, virtual threads |
| `build` | 16 | Gradle, Maven, TypeScript, npm, Cargo, and Docker builds: caches, parallelism, incremental compilation, linkers |
| `data` | 11 | SQL databases and ORMs: N+1 queries, indexes, pagination, batching, pooling, prepared statements |
| `frontend` | 14 | Bundles and page loads: code splitting, tree shaking, images, fonts, compression, Next.js and Vite settings |
| `ai` | 20 | llama.cpp, vLLM, PyTorch, and LLM client apps: batching, caching, quantization, mixed precision, prompt reuse, streaming |

- **Risk classes.** A card, not the agent, owns its risk class: `lossless` (64 cards), `numeric` (7), `lossy` (17), or `upgrade` (5). Lossy cards and upgrades are refused unless you opt in when approving (`ufo approve --allow-lossy`, `--allow-upgrade`). Only upgrade cards may change lockfiles.
- **Frame hints.** 19 cards name profiler frames, or bundle modules and packages, that point at them. With a profile, `list_techniques` puts the matching cards first, each with its evidence. A match is a lead to check against the card's signals, not proof.
- **Unverified.** Every card is marked `verifiedIn: unverified`. None has yet been confirmed by a measured run in a real project. Treat a card as a well-sourced hypothesis that UFO's measurement keeps or drops.
- **Your own cards.** `cardDirs` in `ufo.yaml` adds card directories from your repository, in the same format ([docs/cli.md](docs/cli.md#technique-cards-and-recipe-edits)).

## How UFO keeps numbers honest

- **One primary metric** decides keep or drop. Other metrics are guardrails or reported only.
- **One sample is one independent run:** one process launch, one load run, one build, one page load. Requests inside a run are never separate samples.
- **Deterministic metrics** (bytes, query counts) take one run per arm plus one repeat, and a change must improve by at least `minEffect` (3% by default). A metric that does not repeat exactly is measured as stochastic instead.
- **Stochastic metrics** take five interleaved A/B pairs. A change is kept only when the median improvement reaches both `minEffect` and twice the noise floor, and at least four of the five pairs improve. A borderline result gets one round of five more pairs, and then needs eight of ten. When the noise floor is above 10%, UFO refuses to decide and names the likely cause.
- **Oracles and guardrails** drop a faster change that loses a passing test, fails a smoke check, raises the error rate, or grows memory past its budget. This release runs `test_pass_set` and `smoke` oracles. It has no quality or result-set oracle, so for numeric and lossy cards your tests decide what still counts as correct.
- **The headline** comes from a fresh check of the baseline against the final commit, never from multiplying per-change results: the median ratio with its min–max range, the scenario, the number of pairs, the machine, the host agent, and the model the agent reports. It is published only when that check improves by at least `minEffect`.
- **The evidence bundle** holds the samples, commands, tool versions, diffs, oracle results, and decisions behind every number, redacted, so a run can be audited and measured again.

## Safety

- UFO works in its own clones and keeps its state in its own home directory, outside your repository. Your branch and working tree are never touched, and UFO never pushes. Kept changes reach your repository only as the `ufo/run-<id>` branch.
- Approval is human-only: `ufo approve` requires an interactive terminal, and no MCP tool can approve, widen opt-ins, or raise a budget. UFO runs only the approved commands, and API keys and other variables of your shell reach them only when `env:` in `ufo.yaml` names them.
- A change that touches tests, benchmarks, `ufo.yaml`, CI, secrets, the scripts the approved commands run, or lockfiles outside upgrade cards is refused before it is applied. So is one that shrinks the test pass set.
- Load targets are loopback and the default Docker bridge. A private address must be listed in the approved `ufo.yaml`, and public addresses are refused.
- Evidence bundles, reports, and every result UFO returns are redacted: secrets, credentials in URLs, your username, hostname, and home directory.
- No telemetry, and no install scripts in the package.
- Patches are executed code: the approved command set limits what UFO runs, not what patched code does. Run untrusted repositories in a sandbox or VM, and review the run branch like any other contribution.

The threat model, and what UFO enforces and cannot prevent, are in [docs/safety.md](docs/safety.md). See also [SECURITY.md](SECURITY.md).

## Contributing

Bug reports, technique card proposals, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
