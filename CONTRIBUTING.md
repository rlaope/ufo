# Contributing to UFO

Thanks for helping make things faster. Please open an issue before a large change so we can agree on the approach first.

## Development setup

Requirements: Node.js 22.12 or later (the test runner needs it; the published package runs on any Node.js 22), npm, and git.

```sh
git clone https://github.com/rlaope/ufo.git
cd ufo
npm ci
npm test
```

Run the CLI from a build:

```sh
npm run build
node dist/cli/index.js --help
```

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Compiles `src/` to `dist/` |
| `npm run typecheck` | Type-checks `src/`, `test/`, and config files |
| `npm run lint` | Lints and checks formatting with Biome |
| `npm run format` | Formats files with Biome |
| `npm test` | Runs all tests with Vitest |
| `npm run test:unit` | Runs `test/unit` |
| `npm run test:integration` | Runs `test/integration` |
| `npm run audit:deps` | Audits the runtime dependencies: `npm audit --omit=dev`, then `scripts/audit-bundled.mjs`, which finds the packages a runtime dependency bundles inside its own files (the MCP SDK's server ships ajv and fast-uri in its `dist/`, which `npm audit` cannot see) and looks each one up in [OSV](https://osv.dev). Needs network access. |

CI runs lint, typecheck, test, and build on every pull request. Run them locally before you push.

Releases follow [docs/release.md](docs/release.md): a signed version tag on `main` runs the release workflow, which publishes to npm with trusted publishing. Before a release, run `npm run audit:deps`. It fails on any advisory. For each one, update the dependency that carries it, or review it and add its id to `ACCEPTED` in `scripts/audit-bundled.mjs` with why it does not reach UFO. The bundled-copy check reads the dependencies' source maps, so a bundle without them is not seen: check the files of a new runtime dependency by hand.

## Project layout

- `src/domain/`: versioned Zod schemas shared by everything else (objective, metric, technique card, change, decision, evidence bundle, policy, `ufo.yaml`)
- `src/cli/`: the `ufo` command
- `test/unit/`, `test/integration/`: Vitest suites
- `scripts/`: repository maintenance scripts

## Domain packs

A domain pack teaches UFO one stack: a detector, a workload, a profiler, oracles, a reset hook, and technique cards. The pack interface will be documented in `docs/packs.md`. Until then, propose a pack with the "Domain pack proposal" issue template.

## Guidelines

- Write code, comments, docs, issues, commits, and pull requests in English.
- Keep changes small and focused. One pull request should do one thing.
- Add or update tests with every behavior change. Do not commit skipped or focused tests (`.skip`, `.only`).
- Do not add `preinstall`, `install`, or `postinstall` scripts, and keep new runtime dependencies to a minimum.
- Never commit secrets, real hostnames, usernames, or home-directory paths, including in test fixtures. Build paths at runtime (for example from `os.homedir()`).
- Report security issues privately; see [SECURITY.md](SECURITY.md).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(domain): add the evidence bundle schema
fix(cli): exit 2 on unknown arguments
docs: explain the measurement policy
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`. No Developer Certificate of Origin sign-off is required.

The `identity-gate` CI job uses a repository secret, so it is skipped on pull requests from forks.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
