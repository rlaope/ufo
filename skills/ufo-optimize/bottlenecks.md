# Bottlenecks: how to tell which one you have

Read this at step 6 of the skill. Name the bottleneck before you choose a technique: a card is
chosen because its `bottlenecks` and `signals` match evidence you have, never because it is
popular. Each category below gives the symptom, the evidence that confirms it, how to get that
evidence per stack, and where to look in `list_techniques`.

Evidence comes from `profile_target` (phase times and the workload's metric line) and from
reading arm A's code and configuration. When the evidence needs a profiler, the profiler's command
has to be part of the approved `ufo.yaml` (a workload or setup command, or a card's command
template); ask the user to add and approve it rather than running it outside UFO.

## startup
- Symptom: the time from launch to the first useful response dominates the metric.
- Confirm: `profile_target` shows `start` (or the whole sample) long while steady-state requests
  are fast; startup traces show where the time goes.
- Evidence by stack: Spring Boot — startup steps from `BufferingApplicationStartup` and the
  `/actuator/startup` endpoint, class loading with `-Xlog:class+load`; JVM — JFR from launch
  (`-XX:StartFlightRecording`); Node — `node --cpu-prof` over boot; Python — `python -X importtime`.
- Cards: `list_techniques` with `bottleneck: startup` (CDS/AOT caches, AOT processing, lazy
  initialization, scanning less, checkpoint/restore, native images).

## cpu
- Symptom: the work is compute-bound; CPU near a core per worker while the metric is slow.
- Confirm: a CPU profile with a few hot frames in the application's own code or a library.
- Evidence: JVM — async-profiler (`asprof -e cpu`) or JFR; Node — `--cpu-prof`; Python — `py-spy
  record`; Go — pprof CPU profile; Rust — a sampling profiler (perf, cargo flamegraph).
- Cards: `bottleneck: cpu`, and `generic.code-change` for a hot loop the profile names.

## allocation
- Symptom: GC pauses or high allocation rates; memory grows with load.
- Confirm: GC logs or allocation profiles show time in GC or allocation-heavy frames.
- Evidence: JVM — `-Xlog:gc*`, JFR allocation events; Node — `--trace-gc`, heap profiles; Go —
  `GODEBUG=gctrace=1`, pprof `alloc_space`; Python — `tracemalloc`.
- Cards: `bottleneck: allocation` (GC choice and heap sizing, reuse and pooling, fewer copies).

## io
- Symptom: threads wait on disk or on synchronous file and crypto calls.
- Confirm: profiles show time blocked in read/write or synchronous file APIs on hot paths.
- Evidence: wall-clock profiles (async-profiler `-e wall`, py-spy with idle frames), Node event-loop
  delay (`perf_hooks.monitorEventLoopDelay`).
- Cards: `bottleneck: io`.

## network
- Symptom: per-request connection setup, TLS handshakes, or chatty remote calls.
- Confirm: a new connection per request, or many sequential round trips to the same service.
- Evidence: client connection-pool metrics, request timing breakdowns, HTTP agent settings.
- Cards: `bottleneck: network` (keep-alive and pooling, batching, concurrent independent calls).

## contention
- Symptom: throughput stops rising with load while CPU stays low; requests queue.
- Confirm: lock or pool waits: JFR monitor and thread-park events, thread dumps, connection-pool
  pending counts, Go block and mutex profiles, py-spy `--gil`.
- Cards: `bottleneck: contention` (pool sizing, worker and thread counts, virtual threads).

## query
- Symptom: database time dominates a request.
- Confirm: per-request query counts (ORM SQL logging), slow statements in `pg_stat_statements`,
  plans from `EXPLAIN (ANALYZE, BUFFERS)` with sequential scans or row estimates far off.
- Cards: `bottleneck: query` (N+1 removal, indexes, keyset pagination, batching, bulk loads,
  statistics).

## serialization
- Symptom: time in encoding or decoding payloads.
- Confirm: profile frames in JSON or other codec code (Jackson, `JSON.stringify`, `json.dumps`,
  `encoding/json`), or new codec objects built per request.
- Cards: `bottleneck: serialization` (reuse codec objects, schema-based or faster encoders).

## build
- Symptom: build or test wall time is the metric.
- Confirm: the build tool's own profile shows where time goes: Gradle `--profile` or a build scan
  (configuration vs execution, cache misses), Maven per-module times, `tsc --extendedDiagnostics`
  or `--generateTrace`, `cargo build --timings`, Docker layer rebuilds in BuildKit output.
- Cards: `bottleneck: build` (configuration and build caches, parallelism, incremental compiles,
  faster linkers, layer ordering).

## bundle
- Symptom: initial-route JavaScript or asset bytes are the metric.
- Confirm: a bundle analyzer (webpack-bundle-analyzer, rollup-plugin-visualizer,
  source-map-explorer, `@next/bundle-analyzer`) shows large modules on the initial route.
- Cards: `bottleneck: bundle` (route splitting, dynamic imports, tree shaking, compression,
  image and font weight).

## rendering
- Symptom: page metrics (LCP, INP) are the metric rather than bytes.
- Confirm: Lighthouse and the browser's performance trace: the LCP element and what delays it,
  long tasks during interaction, render-blocking resources.
- Cards: `bottleneck: rendering` (preloading the LCP resource, deferring third-party scripts,
  responsive images).

## inference
- Symptom: model compute is the metric (tokens per second, time to first token).
- Confirm: server timings and metrics (llama-server timings and `/metrics`, vLLM metrics), batch
  occupancy and slot use, `torch.profiler` for training and custom inference.
- Cards: `bottleneck: inference` (batching and slots, prompt and prefix caches, speculative
  decoding, mixed precision, compilation; quantization only with the lossy opt-in).

## data_loading
- Symptom: the accelerator waits for input.
- Confirm: `torch.profiler` shows time in DataLoader iteration between steps; utilization gaps.
- Cards: `bottleneck: data_loading` (workers, pinned memory, persistent workers).

## caching
- Symptom: the same work is repeated: identical queries, computations, or prompts per request.
- Confirm: repeated identical calls in logs or profiles, low cache hit rates, prompts whose prefix
  changes on every call.
- Cards: `bottleneck: caching`. A cache that can return stale results is lossy.

## Choosing among matching cards
1. Keep only cards whose `stacks` include the target's (from `inspect_target`) or are empty, whose
   `preconditions` hold, and whose `signals` your evidence shows.
2. Order by expected effect on the primary metric, then by risk: lossless first; numeric cards
   only when `ufo.yaml` has a quality oracle that would catch a result outside tolerance; lossy
   and upgrade cards only when `ufo.yaml` grants the matching opt-in.
3. Read the card's `traps` before writing the diff, and its `verification` to know what has to
   hold after it.
