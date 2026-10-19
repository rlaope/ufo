# UFO command line (`ufo`)

This page covers the M1 command line: what each command does, its flags and exit codes, the
`ufo.yaml` format, the lines UFO reads from your workload and test commands, recipe edits, the
approval flow, and where UFO keeps its state. The MCP server (M2) runs the same workflows. The
threat model and what UFO enforces are in [safety.md](safety.md).

## Commands

```
ufo <command> [options]
```

| Command | What it does |
|---|---|
| `init` | Writes a draft `ufo.yaml` at the repository root. Never overwrites an existing file. |
| `approve` | Shows everything `ufo.yaml` lets UFO run and records your approval. Needs an interactive terminal. |
| `measure` | Measures the current `HEAD`: the oracle snapshot, 5 samples, and the noise floor. Leaves no branch or arm behind. |
| `run` | Starts a run, applies each enabled recipe card once with its default parameters, then runs the final check and prints the report. |
| `status` | Lists the repository's runs and the machine lock, and shows the latest run (or `--run <id>`). |
| `resume` | Resumes an interrupted run (for example, after the worker was killed). |
| `cancel` | Cancels a run. Its completed observations stay in the ledger. |
| `report` | Prints a finished run's report, or what is known so far for an unfinished run. |
| `extend-budget` | Raises a run's technique cap or wall-clock budget. Needs an interactive terminal. |
| `worker` | Internal: `ufo worker --run-dir <absolute path>` is the detached worker UFO launches itself. It accepts only a run directory under its own `$UFO_HOME/private/runs/` whose `run.json` names that run (`unsafe_state` otherwise). |

### Options

| Option | Commands | Meaning |
|---|---|---|
| `--allow-lossy` | `approve` | Confirms the `lossy` opt-in that `ufo.yaml` requests. |
| `--allow-upgrade` | `approve` | Confirms the `upgrade` opt-in that `ufo.yaml` requests. |
| `--run <id>` | `status`, `resume`, `cancel`, `report`, `extend-budget` | The run to act on. Default: the latest run of the repository. |
| `--techniques <n>` | `extend-budget` | Techniques to add to the cap. Default: the configured `maxTechniques`. |
| `--minutes <n>` | `extend-budget` | Minutes to add to the wall-clock budget. Default: 0. |
| `--json` | every command | Prints one JSON object on stdout instead of text. |
| `-h`, `--help` | every command | Prints the usage and exits 0. |
| `-v`, `--version` | alone | Prints the package version and exits 0. |

Unknown commands, unknown flags, and positional arguments are usage errors (exit 2). There is no
`--yes`: nothing skips the approval prompt.

### `--json`

With `--json`, stdout holds exactly one JSON object; the approval review and progress lines go to
stderr.

```json
{ "ok": true, "command": "measure", "result": { "runId": "...", "baseline": { "...": "..." } } }
{ "ok": false, "command": "approve", "error": { "code": "policy:non_tty_approval", "message": "..." } }
```

Without `--json`, a failure is one line on stderr: `ufo <command>: <code>: <message>`.

### Exit codes

| Code | Meaning | `error.code` values |
|---|---|---|
| 0 | Success. | |
| 1 | A policy refused the request, the human declined, or the run needs `ufo resume` first. | `policy:<rule>` (see below), `approval_declined`, `opt_in_mismatch`, `config_exists`, `run_not_active`, `run_in_progress`, `worker_not_running`, `measurement_failed`, `ledger_mismatch`, `cancel_pending`, `arms_missing`, `unsafe_state` |
| 2 | Usage or configuration error, or nothing to act on. | `usage`, `not_a_repo`, `config_missing`, `config_invalid`, `cards_invalid`, `no_run`, `unsafe_home` |
| 3 | UFO itself failed. | `internal` |

`ufo run` never leaves a run `running`. When one of its jobs (baseline, recipe, finish) fails, it
cancels the run and exits 1 with `measurement_failed`; the worker log (`logs/worker.err.log` in the
run state) has the detail. When the baseline is refused for noise it finishes the run at once (the
report is kept, no recipe is tried) and exits 1 with `measurement_failed`. `ufo measure` reports a
failed baseline as `measurement_failed` (exit 1), and the run it used ends `failed`.

Policy rules (`policy:<rule>`): `protected_path`, `out_of_scope`, `test_set_shrunk`,
`unapproved_config`, `config_changed`, `opt_in_required`, `target_not_allowed`,
`non_tty_approval`, `budget_exceeded`, `noise_floor`, `unknown_card`, `card_not_enabled`,
`unsafe_repo_config`, `stale_base`. The same names appear as decision reasons when the worker
refuses a change.

Refusals that protect UFO's own state:

| Code | When |
|---|---|
| `unsafe_home` (exit 2) | `$UFO_HOME` is a symbolic link, not a directory, not owned by you, writable by group or others, or inside the target repository or its git directory. Nothing is created in the repository. Fix the directory (`chmod 700`) or point `UFO_HOME` elsewhere. |
| `unsafe_state` (exit 1) | Something under `$UFO_HOME` is not what UFO created: a symbolic link in the run state, the approvals, or the arms, a run state file that does not validate, a run state naming another run or repository, or an arm whose git directory is not its own. UFO refuses instead of following it. |
| `policy:unsafe_repo_config` (exit 1) | The repository's `.git/config` sets a key that would make git run a program the repository chose (see [Arms](#runs-budgets-and-decisions)). Remove the key, or move it to your global git config, and start again. |
| `run_in_progress` (exit 1) | Another run holds the machine lock, or a run of this repository is still `running`. The message names the run and how to end it (`ufo resume --run <id>` or `ufo cancel --run <id>`). |
| `cancel_pending` (exit 1) | `ufo resume` on a run whose cancel was requested but did not complete. Run `ufo cancel` again to end it. |
| `arms_missing` (exit 1) | `ufo resume` on a run whose arms under `$UFO_HOME/arms` are gone. It cannot continue; `ufo cancel` ends it. |

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
| `workload` | object | Only `command` is required. Every command is a single line. |
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
| `UFO_PHASE` | `baseline`, `change`, or `final_check` |
| `UFO_SAMPLE_INDEX` | The sample's index, on the workload `command` only |
| `UFO_TARGET_ADDR` | When `targets:` is set: each entry as `host=address`, comma-separated, as checked when the run started |

Whatever a command leaves running in its process group is killed when it exits.

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
verifiedIn: unverified
```

| Edit | Effect |
|---|---|
| `set_property` | In a `key=value` file, rewrites the one line that sets `key`, or appends `key=value` when the key is absent. The key may appear at most once. `value` is one line. |
| `replace_text` | Replaces the exact text `find`, which must occur exactly once in the file, with `replace`. Both at most 10,000 characters. |

`{{param}}` in `value`, `replace`, and command templates must name a declared parameter. A recipe
whose edits do not apply (missing file, `find` not found exactly once) is dropped as
`patch_failed`; one that leaves arm A unchanged is dropped as `no_effect` and does not count
against the budget. Guided cards cannot have edits. In M1, the only command template UFO runs is
the one with id `reset`; every template is still listed for approval.

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
   the environment variables every command will see. Commands may not contain invisible format
   characters or non-ASCII spaces (`config_invalid`).
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
uncommitted changes are not part of the run (a warning says so).

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
an include (`include.*`, `includeIf.*`), `extensions.worktreeConfig`, or a URL rewrite
(`url.*`); or when `.gitattributes` or `.git/info/attributes` names a driver that config
defines. git runs with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TMPDIR`, `TZ`,
`XDG_CONFIG_HOME`, and the `GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM` variables from the process
that runs it. Settings
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
  after a deterministic keep (fewer than five values), the change's own five A samples.
- Finishing the run runs the final check (the base commit in B against the final commit in A, five
  fresh pairs), writes the report and the redacted evidence bundle, publishes the run branch,
  removes the arms (the run branch stays for review), and releases the machine lock. From the moment the finish job is
  queued, the run takes no more changes (`run_not_active`); a job still queued when it ends is
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
| `bundles/<bundle-id>/` | The evidence bundle: `bundle.json`, `diffs/<change-id>.diff`, and `manifest.json` with SHA-256 hashes. |
| other | `heartbeat.json` (the worker's last sign of life), `cancel.json` (a requested cancel), `run.lock` and `control.lock`, and the `samples/` and `artifacts/` directories reserved for packs. |

Run ids look like `20261017-153000-a1b2c3` (UTC time, then random hex). The ledger, job records,
and logs are local, private (mode 0600 in 0700 directories), and unredacted. The evidence bundle is redacted before it is written:
environment values of sensitive variables, connection-string credentials, authorization headers,
bearer tokens, API-key formats, private keys, `KEY=value` secrets, your home directory (as `~`),
username, and hostname.
