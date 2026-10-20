# Safety and threat model

UFO lets a coding agent propose changes that UFO applies, measures, and commits. The agent and
the repository it works on are not trusted; the human at the terminal and UFO's own home
directory are. This page says what that means, what UFO enforces, and what it cannot.

## Who can do what

| | Capability | Example |
|---|---|---|
| A | Untrusted repository content, including `.git`, and the agent's tool inputs (diffs, hypotheses, card choices). | A README telling the agent to run something; a crafted `.gitattributes`; a diff that edits the tests. |
| B | A, plus silent file edits anywhere inside the project directory. | An agent tool that writes files without asking. |
| B′ | B, plus write access to `$UFO_HOME/arms`. | An agent allowed to edit the arm it reads code from. |
| C | Arbitrary shell commands as the user. | An agent with an unrestricted terminal. |

UFO is designed to hold against A and B, and to keep B′ from reaching anything outside the
arms. Against C it can only make misuse visible: a shell running as you can do anything you can.

## What UFO enforces

**Human-only approval.** `ufo approve` and `ufo extend-budget` need an interactive terminal on
stdin and read the answer from the controlling terminal (`/dev/tty`) themselves. No flag, MCP
tool, or app-layer parameter can answer for the human. The approval records `sha256(ufo.yaml)`,
every enabled technique card (source and content hash), the opt-ins, and the names of the
environment variables commands may see, under one digest. A run starts only on exactly that, and
every job checks it again.

**A trusted home.** Everything UFO relies on lives under `$UFO_HOME/private/` (mode 0700, files
0600): approvals, run state, and the machine lock. UFO refuses a `$UFO_HOME` that is a symbolic
link, not owned by you, writable by group or others, or inside the repository or its git
directory. Nothing UFO trusts is read from the repository or its `.git`. Run state files are
opened without following symbolic links, and every directory on the way is checked.

**Derived, never stored, locations.** Where approvals are read, which repository a run belongs
to, where its arms are, and which branch it writes are derived from UFO's own home, the run id,
and the repository as it resolves now. Run state that names another run or repository is
refused. `ufo worker` accepts only a run directory under its own home's runs directory.

**Arms that are UFO's own clones.** The two arms are local clones without your repository's
config, hooks, or templates. Every git command in an arm names its git directory and work tree,
runs without hooks, fsmonitor, signing, textconv, external diff programs, or pagers, and first
checks that the arm is still the directory UFO created. Before git runs in your repository, UFO
refuses repository config outside a list of known sections, and keys inside them that would make
git run a program or reach an endpoint the repository chose (config-based hooks, which
`core.hooksPath` does not turn off, credential helpers, `http.*`, filter, diff, and merge drivers,
signing programs, `core.worktree`, SSH and proxy commands, remote helper programs, bundle URIs,
includes, per-worktree config, URL rewrites, recursion into submodules, git-lfs programs and
endpoints, promisor remotes; see [cli.md](cli.md)). git itself runs with an allowlisted
environment, never recurses into submodules (whose own config UFO does not check), and never
fetches a missing object. Your repository receives only the
`ufo/run-<run-id>` branch, by a fast-forward fetch from arm A.

**Policy before code.** A change is refused before it is applied when it touches a protected path
(tests, benchmarks, `ufo.yaml`, CI, secrets, git attributes and submodules, the declared card
directories, the script tables the approved commands run through such as `package.json` or a
`Makefile`, lockfiles outside `upgrade` cards), names a card that
is not enabled, needs an opt-in the approval does not grant, or exceeds the budget; git's own
list of changed paths is checked again after applying. Tests that shrink the pass set are
refused. A decision recorded in the ledger never carries code past these checks: after a crash,
a recorded keep is committed only for the change its job queued, and only after the same checks
pass again.

**Bounded commands and environment.** UFO runs only the approved command lines, and the review
shows each one JSON-quoted; a command with invisible format characters or non-ASCII spaces is
refused, so what you read is what runs. Each runs in its
own process group, with exactly the environment captured when the run started (`PATH`, `HOME`,
`LANG`, `LC_*`, `TMPDIR`, `USER`, `SHELL`, `TERM`, and the approved `env:` names). Other variables
of the launching process, such as API keys or agent sockets, are not passed on.

**Careful cleanup.** Cancel and resume signal a process only after checking its start time (and,
for the worker, its command line), and remove only containers labeled with the run's own id.
Arm A is reset to its commit at the start of every job (files git ignores, such as build
outputs, are kept, so a build can be reused). One machine lock, held by a run for its
whole life, keeps two runs from measuring at once; control operations on one run take turns.

**Measured decisions.** UFO, not the agent, decides keep or drop, from interleaved samples of
both arms, guardrails, and oracles.

**Redacted views.** Evidence bundles, `report.json`, every view UFO returns (`get_job`, `get_run`,
`status`, `report`, and the read-only MCP tools `inspect_target`, `check_capabilities`, and
`list_techniques`), the start, resume, cancel, and measure results, and the message of every
failure, on the command line and over MCP, go through the same redactor; the raw values stay in
the run's ledger and logs under `$UFO_HOME/private`. The arm paths are not redacted (R4).

**Load targets are checked, not enforced.** UFO resolves each `targets:` entry when the run starts
and refuses public, link-local, and CGNAT addresses; it passes the checked addresses to the
workload as `UFO_TARGET_ADDR`. It does not control where the workload's own code connects.

**Package and CI.** The npm package runs no install scripts and pins its runtime dependencies
exactly; `prepack` rebuilds `dist` from a clean tree. CI installs with `--ignore-scripts`, pins
every action by commit, and checks out without persisting credentials. The identity gate is its
own workflow: on pull requests it runs as `pull_request_target`, so its workflow file and script
come from `main` and the pull request is fetched only as data. A collaborator who can push a
branch with a new workflow can still reach repository secrets; the repository has no other
collaborators.

## What UFO cannot prevent

- **R1. Patches are executed code.** A kept or measured change runs as you, with your files,
  home directory, and network. Approval bounds the command lines UFO runs, not what the patched
  code does when those commands run it, and a process can leave its process group. Only
  containment helps: run UFO in a sandbox, container, or VM, and keep secrets out of the
  approved `env:` list.
- **R1a. Shared object files.** The arms are `--local` clones, which share object files with your
  repository by hard link. Patched code that writes into an arm's object store can damage objects
  your repository uses. Agent write access to the arms is equivalent to R1.
- **R2. A shell defeats every gate.** An agent that can run arbitrary commands as you can write
  `$UFO_HOME`, imitate a terminal, or signal any of your processes. Do not allow an agent to run
  `ufo approve`, `ufo extend-budget`, or general-purpose interpreters on its own. A host that
  runs agent commands in a pseudo-terminal provides a terminal too.
- **R3. The approval does not cover everything the commands use.** It covers `ufo.yaml`, the
  enabled cards, the opt-ins, and the `env:` names, but not the base commit the run starts from
  or the files your approved commands read beyond the script tables UFO protects (a script a
  `package.json` script calls, for example). The review shows each `package.json` script your
  commands name; read what they run before you approve them.
- **R3a. Runners and files UFO does not know.** Script tables of the runners UFO recognizes, and
  their config files, are protected at any depth. A command that runs a repository script
  directly, or through a runner UFO does not recognize, is not protected that way; the review
  shows the command, so check what it runs.
- **R3b. The PATH that finds git, ps, and docker.** Before it runs anything, the `ufo` process
  (the CLI and `ufo mcp`) filters its own `PATH`: it drops empty and relative entries, every
  entry with a `node_modules` segment (`npx` and npm scripts put the project's `.bin`
  directories, and its parents', first), and entries inside the working directory, every
  working tree around it (found by their `.git` entries before git runs, a superproject's
  included), the repository's git directories, and UFO's home. Commands and the worker inherit that `PATH`. A program planted in
  any other directory on your `PATH`, one outside the project, still runs; keep your `PATH` to
  directories only you can write.
- **R4. Redaction is a list of patterns.** The redactor removes known secret formats, your
  home path, user name, and host name from bundles, views, results, and failure messages. A secret in an unknown format can pass through. The
  ledger and logs under `$UFO_HOME/private` are not redacted. The arm paths in run views and in
  start and resume results, the MCP server's included, are absolute local paths and are not
  redacted, because the agent reads arm A to write its diffs. With `UFO_HOME` under your home
  directory they name it and your user name, and an agent passes them to its model provider. Every
  other field of those results is redacted.
- **R5. Evidence can be forged by someone with a shell.** A bundle shows what UFO recorded, but a
  process with capability C could have written it. `ufo reproduce` re-measures on your machine and
  is the real check.
- **R6. An MCP client chooses nothing about where UFO acts.** The MCP server (`ufo mcp`) is
  bound at startup to one repository, by its host's convention (`--host`, and `--repo` for
  Cursor): it pins that repository's real top level, git directory, common directory, and id,
  and checks them before every call (R7). No tool argument names another repository, so a
  session opened on one cannot act on another you approved. It fixes the UFO home, the card directories, the worker it
  launches, the environment a run captures, the Docker runner, and the resolver from its own
  process, as the CLI does, and there is no approval, opt-in, or budget tool. Tool results carry
  repository text (file contents, command lines, command output), which the tools describe as
  data, never instructions; an agent that follows instructions in that text anyway is outside
  what UFO controls.
- **R7. Your host may not protect `.git`.** Some agent hosts let tools edit `.git` silently.
  UFO trusts nothing there, but such an agent can still change your own branches; review the run
  branch before you merge it. UFO checks `.git/config` when a run starts and again right before
  each write to your repository (the run branch, the fetch into it, its removal); an edit that
  lands between a check and the command after it is not caught, and the reads in between
  (`status`, `rev-parse`) run with the config as it is then. Such an agent could also point
  `.git` at another repository's git directory, which gives your work tree that repository's id
  and so its runs. UFO acts on a run only from the work tree that started it (`unsafe_state`
  otherwise), the MCP server refuses at startup a work tree whose git directory is outside it
  unless that git directory names it back (a linked worktree or a submodule), and it refuses
  every call once the repository's git directory, common directory, or id differs from the one
  pinned at startup.

- **R8. Drivers from your own git config.** UFO refuses filter, diff, and merge drivers defined
  in the repository's config, but not those in your global or system config. When the
  repository's attributes name one of them (git-lfs, git-crypt), it runs in the arms, and in your
  repository during the `git status` that checks for uncommitted changes, and may reach the
  network outside the `targets:` check (git-lfs also reads an endpoint from a committed
  `.lfsconfig`).

## Using UFO safely

- Approve in your own terminal, after reading the review.
- Keep `$UFO_HOME` outside every repository, and do not give agents write access to it.
- List only the environment variables your workload needs in `env:`.
- Run untrusted repositories in a sandbox or VM.
- Review the `ufo/run-<run-id>` branch like any other contribution before merging it.
