# UFO command line (`ufo`)

This page covers the command line: what each command does, its flags and exit codes, the
`ufo.yaml` format, the lines UFO reads from your workload and test commands, recipe edits, the
approval flow, and where UFO keeps its state. The MCP server (`ufo mcp`, [mcp.md](mcp.md)) runs
the same workflows. The threat model and what UFO enforces are in [safety.md](safety.md).

## Commands

```
ufo <command> [options]
```

| Command | What it does |
|---|---|
| `init` | Writes a draft `ufo.yaml` at the repository root, built from the stacks detected there (see [Stack detection](#stack-detection-and-the-draft)). Never overwrites an existing file. |
| `approve` | Shows everything `ufo.yaml` lets UFO run and records your approval. Needs an interactive terminal. |
| `measure` | Measures the current `HEAD`: the oracle snapshot, 5 samples, and the noise floor. Leaves no branch or arm behind. |
| `run` | Starts a run, applies each enabled recipe card once with its default parameters, then runs the final check and prints the report. |
| `status` | Lists the repository's runs (those another linked worktree started marked with its path) and the machine lock, and shows this work tree's latest run (or `--run <id>`; a run another work tree started is not shown, and a note names that work tree). Commands without `--run` act on this work tree's latest run. |
| `resume` | Resumes an interrupted run (for example, after the worker was killed). |
| `cancel` | Cancels a run. Its completed observations stay in the ledger. |
| `report` | Prints a finished run's report, or what is known so far for an unfinished run. With `--json`, `result.finished` is `true` for the report and `false` for the run's view. |
| `extend-budget` | Raises a run's technique cap or wall-clock budget. Needs an interactive terminal. |
| `mcp` | Serves UFO's tools to an agent over MCP on stdin and stdout until stdin closes, bound to one repository ([mcp.md](mcp.md)). Your agent's host starts it; `ufo setup` writes its entry. |
| `setup` | Installs this version of UFO into `$UFO_HOME/pkg` and registers that copy's MCP server and the `ufo-optimize` skill in Claude Code, Codex, and Cursor. Shows each change as a diff and asks first. See [Setup, uninstall, and update](#setup-uninstall-and-update). |
| `update` | Installs this version beside the old one and points what `setup` added at it. |
| `uninstall` | Removes exactly what `setup` added, and the copies it installed. |
| `worker` | Internal: `ufo worker --run-dir <absolute path>` is the detached worker UFO launches itself. It accepts only a run directory under its own `$UFO_HOME/private/runs/` whose `run.json` names that run (`unsafe_state` otherwise). |

### Options

| Option | Commands | Meaning |
|---|---|---|
| `--allow-lossy` | `approve` | Confirms the `lossy` opt-in that `ufo.yaml` requests. |
| `--allow-upgrade` | `approve` | Confirms the `upgrade` opt-in that `ufo.yaml` requests. |
| `--run <id>` | `status`, `resume`, `cancel`, `report`, `extend-budget` | The run to act on. Default: the latest run of the repository. A run the repository does not have is `no_run` (exit 2). |
| `--techniques <n>` | `extend-budget` | Techniques to add to the cap. Default: the configured `maxTechniques`. |
| `--minutes <n>` | `extend-budget` | Minutes to add to the wall-clock budget. Default: 0. |
| `--host <host>` | `mcp` | Required: `claude-code`, `codex`, or `cursor`. It decides the repository the server binds to and is recorded as the run's host agent. |
| `--repo <path>` | `mcp` | The repository, an absolute path; required for `cursor`. Default: `$CLAUDE_PROJECT_DIR` (for `claude-code`), else the working directory. A relative path or a placeholder the host left unsubstituted is a usage error (exit 2). |
| `--host <name>` | `setup`, `uninstall`, `update` | Only this host: `claude-code`, `codex`, or `cursor`. Repeatable. Default: for `setup`, every host found; otherwise every host setup configured. |
| `--yes` | `setup`, `uninstall`, `update` | Applies the changes shown without asking (a downgrade is still asked). |
| `--package <file.tgz>` | `setup`, `update` | Installs this `ufo-agents` tarball (`npm pack`) instead of the registry's version. |
| `--json` | every command | Prints one JSON object on stdout instead of text. |
| `-h`, `--help` | every command | Prints the usage and exits 0. |
| `-v`, `--version` | alone | Prints the package version and exits 0. |

Unknown commands, unknown flags, and positional arguments are usage errors (exit 2). `approve` and
`extend-budget` have no `--yes`: nothing skips their prompt.

### `--json`

With `--json`, stdout holds exactly one JSON object; the approval review and progress lines go to
stderr.

```json
{ "ok": true, "command": "measure", "result": { "runId": "...", "baseline": { "...": "..." } } }
{ "ok": false, "command": "approve", "error": { "code": "policy:non_tty_approval", "message": "..." } }
```

Without `--json`, a failure is one line on stderr: `ufo <command>: <code>: <message>`, followed by
`; <hint>` when the message leaves the next step open (`busy`, `run_starting`, `run_finishing`,
`policy:budget_exceeded`). `busy` and `run_starting` are the failures that trying the same command
again later can get past.

Paths in command output, in error messages, and in `--json` results name your home directory as
`~`, like the evidence bundle does, and secrets in error messages are redacted the same way; expand it before you open a path from a script. The arm paths (`arms.a`,
`arms.b` in a run's view and in start and resume results) are the exception: they are absolute
local paths, so an agent can read arm A. The text output shows them with `~` too.

### Exit codes

| Code | Meaning | `error.code` values |
|---|---|---|
| 0 | Success. | |
| 1 | A policy refused the request, the human declined, or the run needs `ufo resume` first. | `policy:<rule>` (see below), `approval_declined`, `opt_in_mismatch`, `config_exists`, `run_not_active`, `run_starting`, `run_finishing`, `run_in_progress`, `run_other_work_tree`, `worker_not_running`, `measurement_failed`, `ledger_mismatch`, `cancel_pending`, `arms_missing`, `interrupted`, `busy`, `unsafe_state` |
| 2 | Usage or configuration error, or nothing to act on. | `usage`, `not_a_repo`, `config_missing`, `config_invalid`, `cards_invalid`, `no_run`, `unsafe_home` |
| 3 | UFO itself failed. | `internal` |

`ufo run` never leaves a run `running`. When one of its jobs (baseline, recipe, finish) fails, it
cancels the run and exits 1 with `measurement_failed`; the worker log (`logs/worker.err.log` in the
run state) has the detail. When the baseline is refused for noise it finishes the run at once (the
report is kept, no recipe is tried) and exits 1 with `measurement_failed`. `ufo measure` reports a
failed baseline as `measurement_failed` (exit 1), and the run it used ends `failed`. It prints the
start's warnings (uncommitted changes left out of the run, earlier runs that could not be cleaned
up) after the baseline, and `--json` has them in `result.warnings`.

Ctrl-C (or SIGTERM) during `ufo run` or `ufo measure` cancels the run as `ufo cancel` does: UFO
stops its worker, cancels its jobs, removes the arms (and, for `measure`, the branch), releases
the machine lock, and exits 1 with `interrupted`. A Ctrl-C during the start fails the start the
same way. A second Ctrl-C ends the process at once: a run left `running` then needs
`ufo cancel`, and the next start removes the arms of a run that had already ended.

Policy rules (`policy:<rule>`): `protected_path`, `out_of_scope`, `test_set_shrunk`,
`unapproved_config`, `config_changed`, `opt_in_required`, `target_not_allowed`,
`non_tty_approval`, `budget_exceeded`, `noise_floor`, `unknown_card`, `card_not_enabled`,
`unsafe_repo_config`, `stale_base`. The same names appear as decision reasons when the worker
refuses a change.

Refusals that protect UFO's own state:

| Code | When |
|---|---|
| `unsafe_home` (exit 2) | `$UFO_HOME` is a symbolic link, not a directory, not owned by you, writable by group or others, or inside the target repository or its git directory. Nothing is created in the repository. Fix the directory (`chmod 700`) or point `UFO_HOME` elsewhere. |
| `unsafe_state` (exit 1) | Something under `$UFO_HOME` is not what UFO created: a symbolic link in the run state, the approvals, or the arms, a run state file that does not validate, a run state naming another run or repository, or an arm whose git directory is not its own. UFO refuses instead of following it. Also a work tree whose git directory is not its own `.git` unless it is a linked worktree or a submodule that names it back: one made with `git init --separate-git-dir` (no `core.worktree`), or whose `.git` is a symbolic link to a directory elsewhere. A submodule passes that check, but starting a run there is refused for its `core.worktree` (`policy:unsafe_repo_config`). |
| `policy:unsafe_repo_config` (exit 1) | The repository's `.git/config` sets a key that would make git run a program the repository chose (see [Arms](#runs-budgets-and-decisions)). Remove the key, or move it to your global git config, and start again. |
| `run_in_progress` (exit 1) | Another run holds the machine lock, or a run of this repository is still `running`: also a start still in progress, or one cut short (it holds the machine lock until `ufo cancel` ends it; when the next start's cleanup could not end it, the message carries the cleanup's error). The message names the run and how to end it (`ufo resume --run <id>` or `ufo cancel --run <id>`), and the work tree to run that in when another linked worktree of the repository started it. |
| `run_other_work_tree` (exit 1) | The run was started in another work tree of this repository (a linked worktree shares its runs). UFO acts on a run only from the work tree that started it; the message names that work tree. |
| `run_starting` (exit 1) | The run is still starting. Try again in a few seconds. |
| `run_finishing` (exit 1) | The run's finish is queued, so it takes no more work. Wait for the finish, then read `ufo report`. |
| `run_not_active` (exit 1) | The run has ended, never finished starting, or only measures (`ufo measure`). |
| `cancel_pending` (exit 1) | `ufo resume` on a run whose cancel was requested but did not complete. Run `ufo cancel` again to end it. |
| `arms_missing` (exit 1) | `ufo resume` on a run whose arms under `$UFO_HOME/arms` are gone. It cannot continue; `ufo cancel` ends it. |
| `busy` (exit 1) | Another UFO command (resume, cancel, finish, queueing a change) held the run's control lock longer than this one waits (120 s on the command line). Nothing was changed; try again. A process stuck holding the run's state lock (`run.lock`, 10 s) is `internal` instead. |

## `ufo.yaml` reference

`ufo.yaml` lives at the repository root. It is parsed as YAML without aliases or duplicate keys,
then checked against a strict schema: an unknown key anywhere is an error (exit 2,
`config_invalid`). The file may be at most 256 KiB.

```yaml
version: 1
objective:
  primary:                      # exactly one metric decides keep or drop
    name: latency_ms            # lowercase identifier; also the key in the workload's JSON line
    unit: ms
    direction: lower_is_better  # or higher_is_better
    kind: stochastic            # deterministic: 1 run per arm + 1 repeat; stochastic: 5 interleaved pairs
    replicationUnit: load_run   # process_launch | load_run | build | page_load | eval_pass | training_pass
  scenario: GET /items, 15 sequential requests on loopback
  guardrails:
    - kind: error_rate          # maxDeltaPp: 0.1 (default), percentage points over arm A
    - kind: memory              # maxRatio: 1.2 (default), RSS of B over A
  reportedOnly: []              # extra metrics: measured and reported, never decide
  minEffect: 0.03               # smallest improvement worth keeping, 0 < minEffect < 1
  targetRatio: 2                # optional, > 1
  budget:
    wallClockMinutes: 120       # default 120, at most one week
    maxTechniques: 10           # default 10, at most 100
workload:
  setup: npm ci && npm run build   # optional; the build, once per arm and job (failing in B: build_failed)
  start: node server.js            # optional; kept running while the arm is sampled
  healthcheck: curl -fs localhost:$UFO_PORT/health   # optional; retried every 250 ms for 60 s
  warmup: node bench/warmup.mjs    # optional
  reset: ./scripts/reset.sh        # optional; before every sample
  command: node bench/latency.mjs  # required; one sample, prints one JSON line
  teardown: ./scripts/stop.sh      # optional
  profile:                         # optional; only profile_target runs it (see Profiling)
    preset: node-cpu               # or env (optional) and format: collapsed | cpuprofile | speedscope
    steps: [start]                 # default: [start] with a start, else [command]
oracles:
  - name: unit-tests
    kind: test_pass_set
    command: node --test --test-reporter=./test/reporter/ufo.mjs
  - name: smoke
    kind: smoke
    command: node bench/smoke.mjs
targets: []                     # load targets beyond loopback and the Docker bridge
cards:                          # enabled technique card ids, in the order `ufo run` applies recipes
  - generic.code-change
cardDirs: []                    # repository directories with more cards, e.g. [ufo/cards]
optIns: []                      # lossy and/or upgrade; granted only by `ufo approve --allow-...`
env: []                         # environment variable names commands may see besides the defaults
hygiene:                        # machine checks before every sample (plan §4.5)
  requireAcPower: true          # default true; false lets samples run on battery
  maxLoadFactor: 0.5            # default 0.5: the 1-minute load must stay below 0.5 × cores
```

| Key | Type | Notes |
|---|---|---|
| `version` | `1` | Required. |
| `objective.primary` | metric | Required. `name` and `unit` are required, as are `direction`, `kind`, `replicationUnit`. |
| `objective.scenario` | text | Required, one line, at most 1000 characters. Used in the headline. |
| `objective.guardrails` | list | At most one per kind. M1 accepts `error_rate`, `memory`, and `test_pass_set` (the pass-set check runs with each `test_pass_set` oracle); `quality` is rejected until the AI packs (M4). |
| `objective.reportedOnly` | list of metrics | At most 16; must not repeat the primary metric. |
| `objective.minEffect` | number | Default `0.03`. |
| `objective.targetRatio` | number | Optional. |
| `objective.budget` | object | `wallClockMinutes` (default 120), `maxTechniques` (default 10). |
| `workload` | object | Only `command` is required. Every command is a single line. `profile` is optional; see [Profiling](#profiling-workloadprofile). |
| `oracles` | list | At most 16, unique `name`. M1 runs `test_pass_set` and `smoke`; the other kinds (`http_golden`, `result_set_equality`, `quality_eval`, `loss_tolerance`) are rejected until their packs exist. |
| `targets` | list | IPv4/IPv6 addresses, CIDR ranges, or hostnames; at most 64. See [Load targets](#load-targets). |
| `cards` | list of ids | Every id must exist in the card catalog (`policy:unknown_card` otherwise). |
| `cardDirs` | list of paths | At most 16 repository-relative directories with technique cards, besides the built-in ones. Each must be a directory inside the repository, reached without a symbolic link (`config_invalid` otherwise). The approval covers their enabled cards, and no change may edit them. |
| `hygiene` | object | `requireAcPower` (default `true`) and `maxLoadFactor` (default `0.5`, at most 64). Loosened values are shown at approval and recorded as limitations in the evidence bundle. |
| `optIns` | list | `lossy`, `upgrade`. |
| `env` | list of names | At most 64 environment variable names passed to every command besides the defaults (see below). `UFO_*` names are reserved. The approval covers the list; the values are read when a run starts. |

The metric names `error_rate` and `rss_bytes` are reserved for the guardrail keys of the workload
output.

### Commands and their environment

Every workload, oracle, and card command runs with `/bin/sh -c` in the arm's directory, in its
own process group; every one except `start` has a 30-minute timeout.

A command does not inherit the environment of whoever started the run. When a run starts, UFO
captures `PATH`, `HOME`, `LANG`, every `LC_*`, `TMPDIR`, `USER`, `SHELL`, `TERM`, and the names
`env:` lists from the starting process, and every command of the run gets exactly those values,
whichever process launches its worker later. API keys, cloud credentials, agent sockets, and
anything else stay out unless `env:` names them. UFO adds these variables:

| Variable | Value |
|---|---|
| `UFO_ARM` | `a` or `b` |
| `UFO_PORT` | A free loopback port, fixed per arm for the job |
| `UFO_RUN_ID` | The run id |
| `UFO_PHASE` | `baseline`, `change`, `final_check`, or `profile` (one profiling run, MCP `profile_target`) |
| `UFO_SAMPLE_INDEX` | The sample's index, on the workload `command` only |
| `UFO_TARGET_ADDR` | When `targets:` is set: each entry as `host=address`, comma-separated, as checked when the run started |
| `UFO_PROFILE_DIR` | In a profile job under `workload.profile` only: the job's profile directory, on every step |

Whatever a command leaves running in its process group is killed when it exits.

### Profiling: `workload.profile`

`profile_target` (MCP) runs the workload once in arm A. With `workload.profile`, it runs it under
the profiler this block sets up and reads what the profiler writes:

- `preset`: a profiler UFO sets up itself; with one, `env` and `format` are not allowed. The only
  one is `node-cpu`: the profiled steps get `NODE_OPTIONS` set to
  `--cpu-prof --cpu-prof-dir="<profile dir>" --require "<UFO's preload>"` (after the value `env:`
  passes, if it lists `NODE_OPTIONS`), and the format is `cpuprofile`. `--cpu-prof` writes only
  when the process exits normally, and Node ends on SIGTERM or SIGINT without writing unless a
  JavaScript listener exits instead; UFO's preload (`src/presets/node-exit-on-signal.cjs`, shipped
  with UFO) is that listener on the main thread, for a process with no listener of its own (it
  exits with 128 + the signal's number). A process with its own listener keeps it, and its
  profile is written when that listener exits. signal-exit's listeners (under execa,
  write-file-atomic, and others) do not count as the process's own: it waits for every other
  listener to be gone, so the preload exits, and signal-exit's exit callbacks run. A listener added
  with `process.prependOnceListener` is gone when the preload's runs, so the preload exits right
  after it: a shutdown it starts asynchronously is cut short. The preload's path is that of the
  UFO install that runs the job, so `ufo update` changes it without a new approval; it is UFO's own
  code, like the rest of the install. `NODE_OPTIONS` reaches every Node process the step starts,
  and each writes its own file.
- `env`: at most 16 variables added to the profiled steps of a profile job, and to nothing else.
  Names are uppercase (`[A-Z_][A-Z0-9_]*`); `PATH`, `HOME`, `UFO_*`, and names that look like
  secrets (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AWS_*`, and the like) are refused
  (`config_invalid`), since the values are plain text in `ufo.yaml`. A value is one line without
  control or invisible format characters, at most 4000 characters, and may be empty.
  `{{profile_dir}}` is its only placeholder; UFO replaces it with the job's profile directory as
  it is, not quoted.
- `steps`: which of `setup`, `start`, `warmup`, and `command` get `env`, each set in the workload.
  Default: `[start]` when the workload has a `start` (a server), else `[command]`.
- `format`: what the profiler writes, required without a preset. `collapsed` is folded stacks, one `root;...;leaf <count>` per
  line (async-profiler `-o collapsed`, py-spy `--format raw`, the stackcollapse scripts); its
  weights are `samples`. `cpuprofile` is V8's `.cpuprofile` (`node --cpu-prof`), weighed in
  microseconds, each sample until the next one. `speedscope` is the speedscope JSON format,
  `sampled` or `evented`, in its own unit; profiles in a unit other than the first one's are left
  out and noted.

Each profile job gets a new, empty directory, `artifacts/profile-<job-id>/` in the run state,
outside both arms, so nothing the profiler writes reaches a diff. Every step of the job gets it as
`UFO_PROFILE_DIR`, so a command can also start a profiler itself. Baselines, samples, oracles,
and the final check never get `env` or `UFO_PROFILE_DIR`: measurement stays unprofiled.

UFO stops `start` after `teardown` with SIGTERM to its process group, then SIGKILL to the group
once the process `start` launched has exited, or 2 s after SIGTERM. A profiler that writes when
its process exits has that long. A wrapper that exits on SIGTERM without waiting for the app,
such as a shell running `cd app && node server.js` (a single command is run in place of the
shell, a list is not), ends the group before the app writes its profile; npm forwards the signal
and waits, so `npm start` is fine.

Since `UFO_PROFILE_DIR` is set only in a profile job, a command can start a profiler itself with
`/bin/sh` parameter expansion, which leaves the bare command in every measured run:

```yaml
workload:
  start: ${UFO_PROFILE_DIR:+py-spy record -f raw -o "$UFO_PROFILE_DIR/py.txt" -s --} python app.py
  command: python bench.py
  profile:
    format: collapsed
```

py-spy (https://github.com/benfred/py-spy) is installed separately and needs root on macOS. On
Python 3.15 and later, `python ${UFO_PROFILE_DIR:+-m profiling.sampling run --collapsed -o
"$UFO_PROFILE_DIR/py.collapsed"} app.py` uses the built-in sampling profiler instead (whether it
needs privileges on macOS is unconfirmed). For a JVM, the async-profiler agent
(https://github.com/async-profiler/async-profiler, installed separately) writes folded stacks
through `JAVA_TOOL_OPTIONS`:

```yaml
  profile:
    env:
      JAVA_TOOL_OPTIONS: "-agentpath:/path/to/libasyncProfiler.dylib=start,event=cpu,collapsed,file={{profile_dir}}/prof-%p.collapsed"
    steps: [start]
    format: collapsed
```

`JAVA_TOOL_OPTIONS` also reaches the JVMs Maven and Gradle start, each writing its own `%p` file;
whether the agent writes its file when the JVM is stopped with SIGTERM is unverified. The draft
`ufo.yaml` (`ufo init`, `inspect_target`) carries the `node-cpu` preset for a Node repository and
these two blocks, commented, for JVM and Python ones.

After the job's teardown, UFO reads the directory's regular files (never through a symbolic
link), the largest first and at most 16 of them, each at most 32 MiB. For each file it sums the
weights and lists, as percentages of the file's total: the 20 frames with the largest self share,
the 20 with the largest total share (a frame counted once per stack, however often recursion
repeats it), and the 10 heaviest stacks by their 5 leaf-most frames, the leaf last and a frame
calling itself shown once, so deep recursion still shows its caller. Frame and file
names are one line of at most 80 bytes, the middle cut out of a longer one, and paths inside arm A
are named relative to the repository. A file that is not the configured format, holds no
samples, is too large, or has more than 1 000 000 folded lines or 500 000 call-tree nodes is
reported with its reason, never failing the job. A V8 file also gives `idle`, the part of its
weight spent in `(idle)`. Several files (one per process, as when `NODE_OPTIONS` reaches child
processes) come back busiest first (weight less `idle`, so a wrapper that only waits on the app
comes after it), then those with a reason; the first 4 are summarized and the others counted in
`omitted`. Without `workload.profile`, the result
has no `hotspots` and the job creates no directory. A FIFO or other non-regular entry is reported,
never opened. If the workload replaced the directory (never followed) or made it unreadable,
`hotspots` has no files and a `reason`; the phases and the sample stay.

The approval covers `workload.profile` like the rest of `ufo.yaml`; `ufo approve` shows the
profiled steps, the format, the preset, and each variable JSON-quoted, a preset's as it expands.

### Workload output: one JSON line

The workload `command` prints exactly one non-empty line on stdout: a JSON object.

```json
{"latency_ms": 12.3, "error_rate": 0, "rss_bytes": 73400320}
```

- The primary metric's key is required: a finite number ≥ 0.
- `error_rate` (0 to 1) is required when the `error_rate` guardrail is configured; `rss_bytes`
  when the `memory` guardrail is. If the workload reports them without the guardrail, the
  defaults apply.
- Keys of `reportedOnly` metrics are allowed. Any other key, a second line, a non-zero exit, or
  a timeout makes the sample invalid.
- An invalid sample is recorded and re-run, up to 3 times; a fourth invalid run of the same
  sample fails the measurement (`inconclusive` for a change, a failed job for a baseline).
- Before each sample UFO checks the machine: AC power, and a 1-minute load average below
  0.5 × the CPU cores. A sleep/wake or clock jump during the sample invalidates it.

### Test results: the `ufoTestResults` line

A `test_pass_set` oracle prints one line on stdout that holds its results; other stdout lines are
ignored, so a runner can print its own report too.

```json
{"ufoTestResults":1,"tests":[{"id":"test/server.test.mjs > GET /items responds","outcome":"pass"},{"id":"test/server.test.mjs > slow check","outcome":"skip"}]}
```

- `id` is unique, one line, at most 1000 characters. `outcome` is `pass`, `fail`, or `skip`.
- At baseline the oracle runs twice. Tests that pass in both runs form the pass set; tests whose
  outcome differs are known-flaky and excluded (listed as limitations); tests that fail in both
  are known-failing and not checked.
- A candidate must pass every test of the pass set, and execute (pass or fail) at least as many
  tests as the baseline did. Otherwise the change is dropped with `policy:test_set_shrunk`, even
  if it is faster. A skipped test does not count as executed.
- `test/fixtures/toy-http/repo/test/reporter/ufo.mjs` is a `node:test` reporter that prints this
  line.

A `smoke` oracle passes when its command exits 0.

## Technique cards and recipe edits

A card (`<dir>/<domain>/<name>.yaml`, id `<domain>.<name>`) owns its risk class: `lossless`,
`numeric`, `lossy` (needs the `lossy` opt-in), or `upgrade` (needs the `upgrade` opt-in; only
these may change lockfiles). `guided` cards are written by the agent. `recipe` cards can carry
`edits`, which UFO applies itself during `ufo run`, with the card's default parameters.

UFO takes the edits from the card as captured at run start (see [Approval](#approval)), reads
each edited file from arm A's commit (regular files only, never through a symlink), applies the
edits in order, and computes the unified diff with git. That diff then goes through exactly the
same checks as an agent's diff: the run's approval, card enabled, opt-in, budget, protected paths
before anything is applied, and git's own list of changed paths after.

```yaml
# <cards dir>/example/no-delay.yaml
id: example.no-delay
domain: example
title: Turn off the configured extra delay
kind: recipe
riskClass: lossless
stacks: [node]           # stack ids the card applies to; [] (the default) means any stack
bottlenecks: [cpu]       # at least one bottleneck category
params:
  - name: delay_ms
    type: integer        # integer | number | boolean | enum (no free-form strings)
    min: 0
    max: 100
    default: 0
edits:
  - op: set_property
    file: toy.properties
    key: items.extra_delay_ms
    value: "{{delay_ms}}"
  - op: replace_text
    file: server.mjs
    find: "await sleep(5);"
    replace: "await sleep({{delay_ms}});"
commandTemplates:
  - id: reset            # run in B after the change is dropped
    run: node --check server.mjs
signals:
  - toy.properties sets a non-zero items.extra_delay_ms
steps:                   # guided cards: the ordered how-to
  - Set items.extra_delay_ms to 0 in toy.properties
expectedEffect: latency drops by the configured delay; measure   # one line, with its condition
sources:                 # primary https URLs; at least one unless the domain is generic
  - https://example.com/docs/extra-delay
verifiedIn: unverified
```

Besides the fields above a card has `preconditions`, `verification`, and `traps` (lists of notes),
`pinnedToolVersions`, `memoryBudget`, and `verifiedIn`. The fields that route an agent to a card:

| Field | Meaning |
|---|---|
| `stacks` | Any of `jvm`, `spring-boot`, `gradle`, `maven`, `node`, `npm`, `pnpm`, `yarn`, `typescript`, `nextjs`, `vite`, `webpack`, `python`, `django`, `fastapi`, `flask`, `sqlalchemy`, `go`, `rust`, `cargo`, `docker`, `postgres`, `mysql`, `hibernate`, `llama-cpp`, `vllm`, `pytorch`, `openai-client`. Empty means any stack. Each at most once. |
| `bottlenecks` | One or more of `startup`, `cpu`, `allocation` (GC and memory), `io`, `network`, `contention` (locks, pools, concurrency), `query` (database), `serialization`, `build`, `bundle` (payload size), `rendering`, `inference`, `data_loading`, `caching` (repeated work that could be reused). Required. |
| `signals` | Observable evidence that points at the card; at least one. |
| `steps` | The ordered how-to a guided card gives the agent. |
| `expectedEffect` | One line saying what to expect and under which condition. |
| `sources` | At most 16 `https` URLs of the primary sources the card was written from. A card outside the `generic` domain needs at least one. |

`list_techniques` filters by `stack` and `bottleneck` and returns these fields (see
[mcp.md](mcp.md)).

| Edit | Effect |
|---|---|
| `set_property` | In a `key=value` file, rewrites the one line that sets `key`, or appends `key=value` when the key is absent. The key may appear at most once. `value` is one line. |
| `replace_text` | Replaces the exact text `find`, which must occur exactly once in the file, with `replace`. Both at most 10,000 characters. |

`{{param}}` in `value`, `replace`, and command templates must name a declared parameter. A recipe
whose edits do not apply (missing file, `find` not found exactly once) is dropped as
`patch_failed`; one that leaves arm A unchanged is dropped as `no_effect` and does not count
against the budget. Guided cards cannot have edits. In M1, the only command template UFO runs is
the one with id `reset`; every template is still listed for approval.

## Stack detection and the draft

`ufo init` and `inspect_target` read the repository root to find its stacks. They only read files:
no repository command runs, symbolic links are not followed, and a file over 256 KiB is skipped.

| Stack ids | Read |
|---|---|
| `node`, `npm`, `pnpm`, `yarn`, `typescript`, `nextjs`, `vite`, `webpack`, `openai-client`, `postgres`, `mysql` | `package.json` (dependencies, `packageManager`, `scripts.test`) and the lockfiles `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`. Express and fastify are plain `node`. |
| `jvm`, `maven`, `gradle`, `spring-boot`, `hibernate`, `postgres`, `mysql` | `pom.xml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `gradle/libs.versions.toml`: the Spring Boot plugin or a starter, JPA or Hibernate, a database driver. |
| `python`, `django`, `fastapi`, `flask`, `sqlalchemy`, `pytorch`, `vllm`, `llama-cpp`, `openai-client`, `postgres`, `mysql` | `pyproject.toml`, `requirements*.txt`, `setup.cfg`, `setup.py`, `pytest.ini`. |
| `go`, `rust`, `cargo` | `go.mod` (and its database drivers), `Cargo.toml`. |
| `docker`, `postgres`, `mysql`, `llama-cpp`, `vllm` | `Dockerfile`, compose files (database images), and `package.json` scripts, `Dockerfile`, `Makefile`, `scripts/*.sh` for `llama-server` or `vllm serve`. |

Each detected stack comes with the evidence (file and match) and two suggestions, fixed text of
UFO's: a `testCommand` (`npm test`, `pnpm test`, `yarn test`, `./gradlew test` or `gradle test`,
`./mvnw -q test` or `mvn -q test`, `pytest`, `go test ./...`, `cargo test`) and a `workloadHint`,
one line on what to measure for the stack.

The draft `ufo.yaml` is built from them: each stack's `workloadHint` as a comment above the
workload command, the command to fill in marked `FILL IN` (the draft is valid as written, and the
command exits 1 until replaced), the detected test command as a commented-out `test_pass_set`
oracle, and a comment naming the detected stacks to filter `list_techniques` by. The oracle stays
commented out because a `test_pass_set` command must print the `ufoTestResults` line (see [Test
results](#test-results-the-ufotestresults-line)), which a plain `npm test` does not. Nothing
detected gives the plain draft.

## Approval

Approval is human-only.

1. `ufo approve` checks that stdin is an interactive terminal before it reads anything. Piped or
   redirected stdin is refused with `policy:non_tty_approval` (exit 1), and nothing is printed or
   recorded. The answer is read from the controlling terminal itself (`/dev/tty`), never from
   stdin or from a caller of the app layer; without a terminal to open the approval is refused
   the same way.
2. It loads `ufo.yaml` and the enabled cards (`policy:unknown_card` for an id no catalog has).
3. Each opt-in in `optIns` must be confirmed by its flag (`--allow-lossy`, `--allow-upgrade`), and
   a flag without a matching request is refused too (`opt_in_mismatch`).
4. It prints the `ufo.yaml` hash, the objective, every command UFO will run (workload steps,
   oracles, and the cards' command templates, each JSON-quoted so nothing in the line can hide,
   with lines over 200 characters flagged), the recipe edits in full (`replace_text` shows the
   whole `find` and `replace`), the script tables the commands run through with the body of each
   package.json script they name, the card directories, the enabled cards with their risk classes
   and where each comes from, the load targets, the opt-ins, the machine checks, and the names of
   the environment variables every command will see, and with `workload.profile` the profiled
   steps, the format, and each profile variable, JSON-quoted. Commands may not contain invisible
   format characters or non-ASCII spaces (`config_invalid`).
5. You type `approve`. Anything else records nothing (`approval_declined`).
6. UFO stores the approval in `$UFO_HOME/private/approvals/<repo-id>.json` (mode 0600), replacing
   an earlier approval of that repository: `sha256(ufo.yaml)`, the opt-ins, the `env:` names, and
   for each enabled card its id, source, and content hash.

The approval covers `ufo.yaml`, every card it enables, the confirmed opt-ins, and the `env:`
names. Its digest is the SHA-256 of a canonical JSON encoding (keys sorted) of
`sha256(ufo.yaml)`, the sorted opt-ins, the sorted `env:` names, and, for each enabled card in id
order:

- the card id;
- its source: `ufo-agents@<version>` for a built-in card, or `dir:<path>` for a card directory,
  with the path relative to the repository root;
- the SHA-256 of its parsed content (after defaults), in the same canonical JSON.

A card that `ufo.yaml` does not enable is not covered: editing, adding, or removing one needs no
new approval. The approval file stores the digest too; a file whose digest does not match its
contents counts as no approval.

Every run start checks the approval against `ufo.yaml` and the cards as they are on disk at that
moment:

- without an approval: `policy:unapproved_config`;
- when a single byte of `ufo.yaml` changed: `policy:config_changed`, "ufo.yaml changed";
- when an enabled card's content or source changed, or the card is gone: `policy:config_changed`,
  naming the card (for example, after a command template or recipe edit in a repository-local
  card). An upgrade of UFO changes the source of every built-in card, so it needs a new approval
  too;
- when the approved opt-ins or `env:` names differ: `policy:config_changed`.

Every process reads approvals from its own `$UFO_HOME`, never from a location named in run state.
The opt-ins a run uses are those of its approved `ufo.yaml` that the approval record also grants.

The run keeps a copy of the approved `ufo.yaml` bytes and of the cards as loaded at start, and the
worker runs only those: it never re-reads your `ufo.yaml` or a card file. A card file edited after
the start has no effect on the run. Before each baseline, change (agent or recipe), and finish
job, the worker checks that the copy still matches the repository's approval. If you approve
something else while a run is active, that run's later jobs are refused with
`policy:config_changed`, naming the card or `ufo.yaml`. A change is dropped with that reason; a
baseline or finish job fails. Cancel the run and start a new one.

`ufo extend-budget` works the same way: a terminal on stdin, a summary of what was used, and the
word `extend`. Only then does the raised cap take effect.

### Load targets

Loopback (`127.0.0.0/8`, `::1`) and the default Docker bridge (`172.17.0.0/16`) are always
allowed. A private address (RFC 1918, IPv6 ULA `fc00::/7`) is allowed only when `targets:` lists
it, a range that contains it, or the hostname that resolves to it. Every other address (public,
link-local, CGNAT) is refused even when listed: external targets are not supported in v1. Each
listed target is resolved once when the run starts; one refused address refuses the run with
`policy:target_not_allowed`. The checked addresses reach every command as `UFO_TARGET_ADDR`
(`host=address`, comma-separated). UFO checks the names; it does not control where the workload
actually connects, so a workload should use `UFO_TARGET_ADDR` rather than resolve names again.

## Runs, budgets, and decisions

A run (`ufo run`, or `start_run` over MCP) creates the branch `ufo/run-<run-id>` at your `HEAD`
and two arms outside the repository: A is the run branch's `HEAD`, B is A plus the candidate
change. Your branch, working tree, index, `.gitignore`, and `.git/info/exclude` are never touched;
uncommitted changes are not part of the run (a warning says so). A start holds the new run's
control lock until its worker runs, so no cancel acts on a run half started. A start that fails
records its run as failed, then removes the branch and the arms it created and its run state.
Whatever cannot be removed, the run branch or the arms directory, the error names, since no run
state is left to find it by: the branch with the command that deletes it
(`git branch -D -- 'ufo/run-<run-id>'`), the arms directory by its path, to remove by hand. A
path in an error is redacted (`~` for your home), so it is not given as a command to paste.

The arms are UFO's own local clones (`git clone --no-checkout --local` without templates), so
they carry none of your repository's config, hooks, or worktree admin data, and your `.git`
gains no `worktrees/` entry. Every git command UFO runs in an arm names its git directory and
work tree explicitly and runs with hooks, fsmonitor, commit and tag signing, automatic gc, and
pagers off; patch diffs never run textconv or external diff programs. Before any git command in
your repository that could run a repository-defined program, and again right before the run
branch is created, UFO checks `.git/config` and refuses the run with `policy:unsafe_repo_config`
when it has a key outside the sections UFO knows (core, user, remote, branch, init, pull, push,
fetch, merge, diff, rebase, submodule, lfs, extensions, and the other common ones), or one that
makes git run a program or reach an endpoint the repository chose: config-based hooks
(`hook.*`; `core.hooksPath` does not turn these off), credential helpers (`credential.*`),
`http.*`, a filter driver (`filter.*`), a diff command or textconv (`diff.external`,
`diff.<driver>.command`, `diff.<driver>.textconv`), a merge driver (`merge.<driver>.driver`), a
signing program (`gpg.*`), `core.worktree`, `core.sshCommand`, `core.askPass`, `core.gitProxy`,
`core.alternateRefsCommand`, a remote helper or upload program (`remote.<name>.uploadpack`,
`.receivepack`, `.vcs`, `.proxy`), a bundle URI (`fetch.bundleURI`), a submodule update command,
recursion into submodules (`submodule.recurse`, `submodule.propagateBranches`), an include
(`include.*`, `includeIf.*`), `extensions.worktreeConfig`, a URL rewrite (`url.*`), a promisor
remote (`extensions.partialClone`, `remote.<name>.promisor`, `.partialCloneFilter`; a partial
clone is refused), or any `lfs.*` key besides `lfs.repositoryformatversion` and
`lfs.<url>.access`/`.locksverify`, and `remote.<name>.lfsurl`/`.lfspushurl` (git-lfs programs and
endpoints);
or when `.gitattributes` or `.git/info/attributes` names a driver that config defines. git runs
with only `PATH` (its absolute entries), `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TMPDIR`,
`TZ`, `XDG_CONFIG_HOME`, and the `GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM` variables from the
process that runs it, never recurses into submodules, and never fetches a missing object
(`GIT_NO_LAZY_FETCH`). Settings
UFO overrides anyway (`core.hooksPath`, `core.fsmonitor`) are allowed. Kept commits reach your
repository only as `ufo/run-<run-id>`, through a fetch from arm A (fast-forward only, no tags, no
`FETCH_HEAD`, no submodules, no maintenance), after the same check.

Each job starts by resetting arm A to its commit (and B to A), so whatever was written into an
arm since the last job is not measured.

- A kept change is one commit on the run branch with the trailers `Ufo-Technique`, `Ufo-Metric`,
  `Ufo-Bundle`, and `Ufo-Change-Id`, authored and committed as the `user.name` and `user.email`
  your repository's git config gives when the run starts. A change that was applied and not kept
  is recorded first; then B is reset to A and the card's `reset` template runs. A failing `reset`
  is recorded as its own `reset_failed` event and fails the job; the decision stays.
- A job interrupted after its decision was recorded returns that decision when it runs again. A
  recorded keep that never reached the run branch is committed only if it is the change the job
  itself queued and it passes the approval, card, opt-in, and protected-path checks again;
  otherwise the job fails and nothing is committed. A job interrupted twice fails, unless its
  decision is recorded: then it is requeued and only finishes what the decision says.
- A diff written against an older arm A (a `baseSha` that is no longer A's commit, because an
  earlier change was kept) is refused before anything is applied, as `policy:stale_base`; it does
  not count against the budget.
- Each change that got past the policy checks counts as one technique, whatever its outcome
  (a patch that does not apply counts too; a refusal does not). When the cap or the wall-clock
  budget is reached, new changes are refused with `policy:budget_exceeded` until
  `ufo extend-budget` raises the limit.
- A noise floor above 10% (MAD over median of the latest five samples at A) refuses decisions with
  `policy:noise_floor`, naming the likely cause. When the samples at the current A already put it
  above 10%, a change is refused before it is applied or measured and does not count against the
  budget. The samples at A are the latest kept change's B values, or the baseline before any keep;
  after a deterministic keep (fewer than five values), the change's own five A samples. A
  baseline refused this way leaves the run unable to decide any change: its view (`ufo status`,
  MCP `get_run`) says `usable: false` with the reason (`not usable:` in the text output), so the
  run should be finished; `ufo run` finishes it at once.
- Finishing the run runs the final check (the base commit in B against the final commit in A, five
  fresh pairs), writes the report and the redacted evidence bundle, publishes the run branch,
  removes the arms (the run branch stays for review), and releases the machine lock. From the moment the finish job is
  queued, the run takes no more changes (`run_finishing`); a job still queued when it ends is
  cancelled. A headline is published only when the final check improves by at least `minEffect`.
- `ufo cancel` stops the worker and every process group it started, removes containers labeled
  `ufo.run=<run-id>`, records the run as cancelled, then removes the arms and releases the
  machine lock, and keeps the ledger. Cancel and finish record the final status before they
  remove the arms, so an interruption in between leaves an ended run with arms on disk, never a
  `running` run without them; the next start of a run in the repository removes such leftovers.
- `ufo resume` refuses a run whose cancel did not complete (`cancel_pending`: cancel it again) and
  a run whose arms are gone (`arms_missing`: cancel it). Otherwise it stops what the interrupted
  run left running, resets both arms to the run branch,
  reconciles the ledger with the commits by `Ufo-Change-Id` (a commit without its ledger entry
  gets the entry; anything else stops with `ledger_mismatch` before any job is touched),
  requeues the interrupted job (once), publishes the run branch, and starts a worker for the
  queued jobs.
- Before signalling anything, cancel and resume check that it is still what the run started: a
  process group whose leader has another start time is skipped, the worker must still run
  `worker --run-dir <run dir>`, and only containers labeled `ufo.run=<run-id>` or
  `ufo.run=<run-id>.<suffix>` are removed.
- Resume, cancel, finish, and the calls that queue work (`submit_change`, `ufo run`'s recipes)
  take turns per run: a second one waits for the first, then sees the run as it left it (for
  example, `run_not_active` after a cancel).
- The machine lock belongs to the run from its start until it finishes, is cancelled, or fails
  to start; a worker that exits after idling does not release it. A new `ufo run` or
  `ufo measure` refuses with `run_in_progress`, naming the active run, instead of clearing its
  lock; a `running` run of the same repository whose worker stopped is named with both ways out,
  `ufo resume --run <id>` and `ufo cancel --run <id>`. A lock is stale, and cleared, only when
  its run is no longer `running` or its state is gone.
- Waiting on a job never outlives the worker. When the job is queued or running and the worker
  is gone (it crashed or was killed), `ufo run` and `get_job` stop within about two seconds with
  `worker_not_running` (exit 1), which asks for `ufo resume`; the job stays queued, or is
  requeued by the resume, and runs on the new worker. `ufo measure` closes its run instead and
  reports `measurement_failed` (exit 1): run it again.

## Setup, uninstall, and update

`ufo setup` installs one exact version of UFO into UFO's own home and registers that copy's MCP
server and the `ufo-optimize` skill in each coding agent it finds. `ufo uninstall` removes exactly
what setup added, and `ufo update` installs the running version beside the old one and points the
hosts at it.

```
ufo setup     [--host <name>]... [--package <file.tgz>] [--yes] [--json]
ufo update    [--host <name>]... [--package <file.tgz>] [--yes] [--json]
ufo uninstall [--host <name>]... [--yes] [--json]
```

| Host (`--host`) | Found when | MCP server | Skill |
|---|---|---|---|
| Claude Code (`claude-code`) | its `claude` answers `--version` | `claude mcp add --scope user ufo -- <node> <cli> mcp --host claude-code`, through Claude Code's own CLI. Setup reads `~/.claude.json` but never writes it. | `~/.claude/skills/ufo-optimize/` |
| Codex (`codex`) | `codex` on `PATH`, the CLI inside `/Applications/ChatGPT.app`, or `~/.codex` | The `[mcp_servers.ufo]` table in `~/.codex/config.toml` | `~/.agents/skills/ufo-optimize/` |
| Cursor (`cursor`) | `agent` or `cursor-agent` on `PATH`, `/Applications/Cursor.app`, or `~/.cursor` | The `ufo` member of `mcpServers` in `~/.cursor/mcp.json` | `~/.agents/skills/ufo-optimize/`, shared with Codex |

Only the hosts in scope are probed: with `--host`, only those. `claude`, `codex`, `agent`,
`cursor-agent`, `npm`, and `node` are found as absolute paths on `PATH` after the same filtering
every `ufo` process applies ([safety.md](safety.md) R3b: no empty or relative entry, none in the
working directory or its project, none with a `node_modules` segment, none in UFO's home), and
the plan names them by those paths. `claude` runs with your home as its working directory.
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` move Claude Code's and Codex's files, as they do for the
hosts.

### The installed copy

A host starts UFO at every launch, in every project, so setup never registers `npx`, which
resolves a package name each time. It installs the version that runs (`npx ufo-agents@1.2.3
setup` installs 1.2.3) into `$UFO_HOME/pkg/<version>` (mode 0700, checked like the rest of UFO's
home, apart from the arms):

```
npm install --prefix <prefix> --ignore-scripts --omit=dev --no-audit --no-fund \
  --package-lock=true --save=true --dry-run=false --global=false \
  --registry=https://registry.npmjs.org/ ufo-agents@<version>
```

npm runs from the prefix, with every `npm_config_*` variable removed from its environment; the
flags beat an `.npmrc` that turns the lockfile off or makes the install a dry run. Setup first
reads the registry's metadata for that version, then checks that npm wrote a lockfile
(`install_failed` otherwise), that it installed `ufo-agents@<version>`, that the lockfile's
integrity for it is the registry's `dist.integrity`, and that every package in the lockfile is
the registry's own tarball of its name and version,
`https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz` (a scoped registry in an `.npmrc`,
or a URL to another package's tarball, must not swap a dependency); `integrity_mismatch`
otherwise, and nothing is set up. It refuses (`package_unavailable`) to
install `0.0.0` (an unreleased checkout), a version that is not exact, or one the registry does
not have. The name `ufo-agents` is not published yet, so until it is, install a tarball:
`--package <file.tgz>` (from `npm pack`) installs that file instead, and setup records its
sha512 and checks the lockfile against it. The installed copy is placed only once it checks out
(a copy it replaces is put back if that fails), and leftovers of an interrupted install
(`pkg/.install-*` and `pkg/.old-*`, never a version's own directory) are swept at the next setup or
uninstall. A copy already installed with the integrity the
record holds is reused without asking the registry, so a second setup works offline.

While a run holds the machine lock, setup and uninstall refuse to replace or remove an installed
copy (`run_in_progress`): the run's worker may be running from it. Finish or cancel the run
first. Installing a new version beside it is allowed.

Every host entry starts that copy with an absolute node: the `node` on the filtered `PATH` when it
is the binary running setup (a stable link such as Homebrew's), else that binary's real path.
Either way, that binary's real directory must pass the same `PATH` rules: setup refuses
(`node_untrusted`) a node inside the working directory's project or under `node_modules`, since
hosts would start it at every launch. Every entry also names the UFO home, `~/.ufo` included
(`env` in Codex's and Cursor's entries, `claude mcp add -e UFO_HOME=...`): hosts start servers
with an environment of their own, and one that passes a `UFO_HOME` must not move the server's
home. A `UFO_HOME` inside the working directory's project is refused (`unsafe_home`).

```toml
[mcp_servers.ufo]
command = "/opt/homebrew/bin/node"
args = ["/Users/you/.ufo/pkg/1.2.3/node_modules/ufo-agents/dist/cli/index.js", "mcp", "--host", "codex"]
startup_timeout_sec = 60
env = { UFO_HOME = "/Users/you/.ufo" }
```

```json
"ufo": {
  "type": "stdio",
  "command": "/opt/homebrew/bin/node",
  "args": ["/Users/you/.ufo/pkg/1.2.3/node_modules/ufo-agents/dist/cli/index.js", "mcp", "--host", "cursor", "--repo", "${workspaceFolder}"],
  "env": { "UFO_HOME": "/Users/you/.ufo" }
}
```

The skill is copied from the installed copy, after checking it is the one the plan showed. Codex
waits 10 seconds for a server to start by default; setup gives it 60. Cursor passes the open
workspace as `--repo`; Claude Code sets `CLAUDE_PROJECT_DIR`, and Codex starts the server in its
own working directory ([mcp.md](mcp.md)). Restart each host, or reconnect with `/mcp`, after
setup, update, or uninstall. Cursor also reads `~/.claude/skills`, so with Claude Code set up too
it may list the skill twice. Setup stores no credentials of its own.

### What setup does

1. Detects the hosts in scope. A named host that is not installed is refused (`host_not_found`).
2. Works out every change and prints it: the install, the command it runs for Claude Code, a
   unified diff for each config file, and the skill directories. Diffs are redacted like every
   other output (secrets in the lines around and removed by the edit, and your home as `~`), on
   the terminal and in `--json`. When nothing would change it says so and exits 0, so a second
   `ufo setup` leaves every file as it was.
3. Asks `Apply these changes? Type "yes":` on the terminal (`/dev/tty`). Anything else writes
   nothing (`approval_declined`). `--yes` applies without asking (see
   [safety.md](safety.md) R9). Without `--yes` and without a terminal it refuses (`no_terminal`).
   Going back to an older version than a host starts now (a downgrade) is asked on the terminal
   even with `--yes`: type `downgrade`. That includes a skill directory another host shares at a
   newer version (`setup --host cursor` after Codex was set up at a newer one).
4. Installs the package, if it is not in place.
5. Before its first write to a Codex or Cursor config, copies the file to
   `$UFO_HOME/private/setup/backups/<host>-<file name>` (mode 0600).
6. Records the change in `$UFO_HOME/private/setup/setup.json`, then makes it: each host's entry
   and version, the hashes of the config file before and after, the text it inserted, the hash of
   each skill file, and each installed copy. Until a write is confirmed, the record holds both the
   old and the new entry as UFO's, so an interruption in between never leaves an entry UFO does
   not recognize.
7. Writes. The TOML and JSON files are edited at the span of the `ufo` entry only: the
   `[mcp_servers.ufo]` table goes at the end of the file after one blank line, and the `ufo` member
   after the last server in `mcpServers` (the file or `mcpServers` is created when missing), in the
   file's own indentation and line endings. Nothing else is re-serialized, so comments, order, and
   formatting stay. The file is replaced atomically (a temp file, fsynced, renamed, and the
   directory fsynced) and keeps its mode (a new file gets 0600); a symbolic link to it stays a
   link.

Each step re-reads its file first. If the file changed after the plan was shown, setup stops
(`changed_during_setup`) and writes nothing more; run it again. Hosts edit their own files:
Codex's `codex mcp add` rewrites UFO's `startup_timeout_sec = 60` as `60.0`, and its inline
`env = { ... }` as an `[mcp_servers.ufo.env]` table after UFO's; setup reads both as the same
entry, and uninstall and re-pins take out that table with UFO's. An `env` table with anything but
strings, or another `[mcp_servers.ufo.*]` table, is not UFO's (`entry_conflict`).

When `claude mcp add` fails, or succeeds without the entry showing up as UFO's in
`~/.claude.json` (for example because `CLAUDE_CONFIG_DIR` differs), setup removes what it added
and records nothing. A re-pin removes the old server first; if the new one cannot be added, setup
adds the old one back, or says that it could not (`host_cli_failed`: run `ufo setup` again).

Before writing anything, setup refuses:

- a config file it cannot edit safely (`host_config_invalid`): invalid TOML or JSON (JSON with
  comments included), text that is not UTF-8, a repeated `ufo` or `mcpServers` key, or
  `mcp_servers` written as an inline table, an array of tables, or another value;
- a `ufo` server, or a `ufo-optimize` skill directory, that differs from what UFO would write and
  that UFO did not write (`entry_conflict`); the message names the file of the skill that
  differs. Setup never overwrites a server or skill of yours. Remove or rename it, or leave that
  host out with `--host`. An entry identical to UFO's that UFO did not write is left alone, by
  setup and by uninstall. Finder's `.DS_Store` files in a skill directory are ignored.

Only one setup, uninstall, or update runs at a time; another one waits 10 seconds, then fails with
`busy` (exit 1, retryable): wait for the other one to finish and run the command again.

### Uninstall

`ufo uninstall` acts only on what `setup.json` records, for every host or the `--host` ones (a
`--host` that UFO has not set up is named in the output):

- A config file still byte-identical to what setup last wrote, with no other writer in between, is
  restored from its backup. A file setup created is deleted.
- A file changed since (hosts rewrite their configs) keeps every other byte and loses only the
  `ufo` entry. Setup's own insertion is taken out exactly when the host left those bytes alone;
  otherwise the entry goes with its separating comma (JSON) or the blank line before it (TOML).
  Either way, the result must parse and hold no `ufo` entry.
- Claude Code's server is removed with `claude mcp remove ufo --scope user`.
- A skill directory is removed when its files are exactly what setup installed. The directory
  Codex and Cursor share stays until both are uninstalled.
- Each installed copy no remaining host starts is removed from `$UFO_HOME/pkg`.
- A `ufo` entry or skill directory changed since setup wrote it (an `env` the host added to the
  server included) is refused (`entry_conflict`); remove it by hand. One that is already gone is
  forgotten.

With nothing recorded, uninstall says so and exits 0.

### Update

`ufo update` does what setup does, for the hosts setup configured: it installs this version
beside the one installed (the old copy stays until uninstall, since a running host may still use
it), points each `ufo` entry at it (Claude Code: `claude mcp remove`, then `claude mcp add`), and
refreshes the skill directories. An entry or skill someone removed since is forgotten, not added
back; `ufo setup` adds it again. It refuses with `not_set_up` when setup configured none of the
hosts.

### Setup exit codes

The three commands use the exit codes above, with these `error.code` values:

| Code | Exit | When |
|---|---|---|
| `usage` | 2 | An unknown `--host` name, or a `--package` file that is missing or not a `ufo-agents` tarball. |
| `host_not_found` | 2 | No host found, a `--host` that is not installed, or no `claude` on `PATH` for Claude Code. |
| `not_set_up` | 2 | `ufo update` with nothing set up. |
| `host_config_invalid` | 2 | A host config setup cannot edit safely (see above). |
| `package_unavailable` | 2 | `0.0.0`, a version that is not exact, or one the registry does not have; use `--package`. |
| `no_terminal` | 2 | No terminal to ask on, and no `--yes`. |
| `entry_conflict` | 1 | A `ufo` server or skill that UFO did not write, or changed since it did; or a record naming another config file (`HOME` or the host's config directory moved). |
| `changed_during_setup` | 1 | A file changed between the plan and the write. |
| `integrity_mismatch` | 1 | The installed package is not the version, integrity, or skill the plan showed, or a package in its lockfile came from another registry. |
| `node_untrusted` | 1 | The node that would be registered is inside the project or under `node_modules`; run setup with another node. |
| `run_in_progress` | 1 | A run holds the machine lock, and setup would replace or remove the copy its worker may run from. |
| `approval_declined` | 1 | The answer was not `yes` (or `downgrade`); nothing was written. |
| `busy` | 1 | Another setup, uninstall, or update held the lock for 10 seconds; retryable. |
| `unsafe_state` | 1 | `setup.json` or a backup is not what setup wrote. |
| `host_cli_failed` | 3 | `claude mcp add` or `remove` failed, or did not change the config as expected. |
| `install_failed` | 3 | No `npm` on `PATH`, the registry could not be reached, `npm install` failed (or was stopped at its 10-minute limit; the message names the signal), or it wrote no lockfile. |

With `--json`, `result` holds `command`, `version` (setup and update), `hosts` (the hosts acted
on), `detected` (setup only: each host probed, `found`, and the evidence), `notSetUp` (`--host`
names UFO has not set up), `changes` (each with `hosts`, `kind` of `package`, `mcp_server`, or
`skill`, `target`, `action` of `install`, `replace`, `add`, `repin`, `remove`, or `restore`,
`detail`, and `diff` for a config file), `unchanged` (each with its `reason`), `changed`,
`backups`, and `notes`.

## Where UFO keeps state

`$UFO_HOME` defaults to `~/.ufo`. UFO creates it with mode 0700 and refuses (`unsafe_home`) one
that is a symbolic link, not a directory, not owned by you, writable by group or others, or
inside the target repository or its git directory. Nothing UFO writes lives in your repository
or its `.git`, except the `ufo/run-<run-id>` branch and its objects.

| Path | Contents |
|---|---|
| `$UFO_HOME/private/` | Everything UFO trusts, mode 0700 (files 0600). Never give an agent write access to it. |
| `$UFO_HOME/private/approvals/<repo-id>.json` | The latest approval of a repository: `sha256(ufo.yaml)`, the enabled cards (id, source, content hash), the opt-ins, the `env:` names, and the digest over all of them. `<repo-id>` is 16 hex characters of the SHA-256 of the repository's git directory path. |
| `$UFO_HOME/private/runs/<repo-id>/<run-id>/` | The run state. |
| `$UFO_HOME/private/lock` | The machine lock: one run at a time per machine, held by a run (run id and repository id) for its whole life. |
| `$UFO_HOME/arms/<repo-id>/<run-id>/{a,b}` | The two arms (local clones) of a run, where the agent reads code and workloads run. Removed when the run finishes or is cancelled. |
| `$UFO_HOME/private/setup/` | What `ufo setup` wrote: `setup.json`, and `backups/` with each edited host config as it was before setup's first write (see [Setup, uninstall, and update](#setup-uninstall-and-update)). |
| `$UFO_HOME/pkg/<version>/` | The copy of UFO that host entries start, installed by `ufo setup` and `ufo update` (mode 0700). Removed by `ufo uninstall`. |

UFO opens run state files without following symbolic links and checks every directory on the way
with `lstat`; a planted symlink is refused (`unsafe_state`). The run directory, its repository id,
the arm paths, and the branch are always derived from the run id and UFO's own home; run state
never names them.

A run state directory holds:

| File | Contents |
|---|---|
| `run.json` | Status (`running`, `finished`, `cancelled`, `failed`), SHAs of the baseline and both arms, the worker PID and start time, and the process groups (with their leaders' start times), ports, and container labels the run started. |
| `app.json` | The approved `ufo.yaml` bytes and hash, the card catalog as loaded at start (each card with its source), the repository's path and base commit, the commit identity, the captured command environment, host agent, and self-reported model id. Its repository and run ids must match the run directory, and the repository at its path must still have that id. |
| `ledger.jsonl` | Append-only events: `run_started`, `baseline_measured`, `baseline_failed`, `change_started`, `decision`, `change_committed`, `budget_extended`, `final_check`, `run_finished`, `run_cancelled`, `run_resumed`, `job_requeued`. |
| `jobs/job-NNNNNN.json` | One record per job, with status, progress, and result. |
| `logs/` | `worker.out.log`, `worker.err.log`, `commands.log` (every command with its exit status), and `start-<arm>.log`. |
| `report.json` | The finished run's report. |
| `artifacts/profile-<job-id>.json` | A profile (MCP `profile_target`): arm A's commit, each workload step's wall time, the workload's JSON line or why the sample was not valid, and with `workload.profile` the hot spots. |
| `artifacts/profile-<job-id>/` | With `workload.profile`: what the profiler wrote during that profile job, as it wrote it. |
| `bundles/<bundle-id>/` | The evidence bundle: `bundle.json`, `diffs/<change-id>.diff`, and `manifest.json` with SHA-256 hashes. |
| other | `heartbeat.json` (the worker's last sign of life), `cancel.json` (a requested cancel), `run.lock` and `control.lock`, and the `samples/` directory reserved for packs. |

Run ids look like `20261017-153000-a1b2c3` (UTC time, then random hex). The ledger, job records,
and logs are local, private (mode 0600 in 0700 directories), and unredacted. The evidence bundle is redacted before it is written:
environment values of sensitive variables, connection-string credentials, authorization headers,
bearer tokens, API-key formats, private keys, `KEY=value` secrets, your home directory (as `~`),
username, and hostname.
