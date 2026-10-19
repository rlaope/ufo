# UFO: Ultrafast Optimization

Make anything faster with agents, from p99 latency down to tokens per second.

**Point your agent at something slow. Get it back faster, with every number measured and every change in its own commit.**

> [!IMPORTANT]
> The only official sources are the [`ufo-agents`](https://www.npmjs.com/package/ufo-agents) package on npm and [`rlaope/ufo`](https://github.com/rlaope/ufo) on GitHub. The npm package named `ufo` is an unrelated project, so `npx ufo` runs someone else's code.

**Status: pre-release, under active development.** Nothing is published to npm yet, and the commands below describe the design being built.

UFO is one npm package that bundles a CLI, an MCP server, and agent skills. It plugs into your coding agent (Claude Code, Codex, Cursor). The agent proposes optimizations. UFO applies each one, measures it against the current baseline, and keeps it only if the numbers and the correctness checks agree.

## How UFO works

1. **Init.** You and your agent draft `ufo.yaml`: one primary metric, the workload that measures it, correctness oracles, guardrails, and the technique cards to try.
2. **Approve.** You run `ufo approve` in a terminal. It prints every command UFO will run and records a hash of the file. Agents cannot approve, and a changed file needs approval again.
3. **Baseline.** UFO creates a run branch and two clones of your repository under its own home directory: arm A (the current best) and arm B (A plus one candidate). It runs the oracles and measures arm A to learn the noise floor.
4. **Profile.** The domain pack's profiler records evidence: a flame graph, a query log, a bundle analysis, a token trace.
5. **Propose.** The agent reads the evidence, picks a technique card that matches it, and submits one patch.
6. **Decide.** UFO checks the patch against policy, applies it to arm B, builds, runs the oracles, and measures A against B in interleaved pairs.
7. **Keep or revert.** A kept change becomes one commit on the run branch with trailers that link it to its evidence. A dropped change is reverted.
8. **Repeat** until the target ratio, the budget, or the agent stops.
9. **Report.** A final check measures the baseline against the final commit and writes a report and an evidence bundle.

## What you can optimize

Tier 1 domains get a full pack (detector, workload, profiler, oracles, technique cards) and a measured showcase. They are planned for the first release; none has shipped yet.

| Domain | Stack | Primary metric |
|---|---|---|
| Server | JVM / Spring Boot | Startup time: process launch to the first 200 on the health endpoint |
| Build | Gradle | Clean build wall time with a warm, isolated dependency cache |
| Data | Postgres + ORM | Endpoint p95 latency at a fixed arrival rate |
| Frontend | Next.js or Vite | Initial-route JavaScript bytes, gzip |
| AI serving | llama.cpp server (Metal) | Output tokens per second at fixed concurrency |
| AI app | OpenAI-compatible client app | p50 end-to-end latency |
| AI training | PyTorch on MPS | Training samples per second |

Tier 2 domains get a detector, technique cards marked `unverified`, and a shared workload, with no showcase:

- Servers: Node, Python, Go
- Builds: Maven, npm, Cargo, Docker
- Databases: MySQL

Other targets, such as native hot loops, mobile apps, GPU kernels, and serverless cold starts, are tracked as [GitHub issues](https://github.com/rlaope/ufo/issues).

## How UFO keeps numbers honest

- **One primary metric** decides keep or drop. Everything else is a guardrail or reported only.
- **One sample is one independent run:** one process launch, one load run, one build, one page load. Requests inside a run are never separate samples.
- **Deterministic metrics** (bytes, query counts, prompt tokens) take one run per arm plus one repeat, and a change must beat `min_effect` (3% by default).
- **Stochastic metrics** take five interleaved A/B pairs. A change is kept only when the median improvement clears both `min_effect` and twice the noise floor and at least four of five pairs improve. A borderline result gets exactly one round of five more pairs. When the noise floor is above 10%, UFO refuses to decide and names the likely cause.
- **Guardrails** drop a faster change that raises the error rate, grows memory past its budget, loses a passing test, or lowers quality beyond tolerance.
- **Headlines** come from a fresh baseline-vs-final check: the median ratio with its min–max range, the scenario, the number of pairs, the machine, the host agent, and the model as reported by the agent. Per-technique ratios are never multiplied together, and lossless and lossy results are reported separately.
- **Evidence bundles** hold the raw samples, commands, tool versions, diffs, oracle results, and decisions behind every number, so a run can be audited and re-measured.

## Safety

- UFO works in its own clones and keeps its state in its own home directory, outside your repository. Your branch and working tree are never touched, and UFO never pushes. See [docs/safety.md](docs/safety.md) for the threat model.
- Approval is human-only: `ufo approve` requires an interactive terminal, and no MCP tool can approve or widen opt-ins. UFO runs only the approved commands and never calls `sudo`.
- Patches that touch tests, workload or oracle specs, `ufo.yaml`, CI test steps, `.env*` files, or secrets are rejected before they are applied. So is any patch that shrinks the test set.
- Lossy techniques and upgrades are off unless you opt in when approving.
- Load tests target loopback and Docker networks by default. Other targets must be listed in the approved `ufo.yaml`.
- Secrets, connection strings, usernames, and home-directory paths are redacted before an evidence bundle is exported.
- No telemetry, and no install scripts in the package.
- Patches are executed code: the approved command set limits what UFO runs, not what patched code does. See [SECURITY.md](SECURITY.md).

## Contributing

Bug reports, domain pack proposals, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
