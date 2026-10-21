# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/rlaope/ufo/security/advisories/new). Do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include what you can of the following:

- the affected version (`ufo --version`) or commit
- the host agent (Claude Code, Codex, Cursor, or none) and the operating system
- steps to reproduce, and the impact you expect
- whether the issue is already public anywhere

Remove secrets, tokens, usernames, and home-directory paths from logs before you attach them.

## Supported versions

UFO is pre-release. Fixes land on `main` and in the next release; older releases are not patched.

## Scope

UFO runs commands on your machine and applies patches proposed by an agent, so these reports are in scope:

- running a command outside the set approved with `ufo approve`, or approving or widening opt-ins without an interactive terminal
- any MCP tool or parameter that changes approvals, opt-ins, or protected paths
- a patch that touches a protected path, or shrinks the test set, and is still applied
- writes to your branch, your working tree, `.gitignore`, or `.git/info/exclude`, or any push
- load traffic sent to a target that is not loopback, a Docker network, or listed in the approved `ufo.yaml`
- secrets, connection strings, usernames, or home-directory paths left in an exported evidence bundle
- `ufo setup` or `ufo uninstall` damaging host agent configuration
- content from the target repository (README, comments, logs) being treated as instructions

Out of scope: what patched code does when it runs. A patch is executed code. The approved command set limits what UFO runs, not what the code under test does once built. Review `ufo.yaml` and the run branch before you merge or deploy anything UFO produced.

## Supply chain

These commitments apply to every release:

- The only official sources are the `ufo-agents` package on npm and the `rlaope/ufo` repository on GitHub. The npm package named `ufo` is unrelated, so `npx ufo` runs someone else's code.
- The package has no `preinstall`, `install`, or `postinstall` scripts.
- Runtime dependencies are kept minimal, and the lockfile is committed.
- Before a release, the runtime dependencies are audited, including the copies of other packages that a dependency bundles in its own files (`npm run audit:deps`; see [CONTRIBUTING.md](CONTRIBUTING.md#scripts)).
- Releases are published with npm trusted publishing and provenance, from accounts with two-factor authentication. Release tags are signed.
- UFO collects no telemetry.
