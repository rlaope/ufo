# Releasing UFO

A release is a signed version tag on `main`. Pushing it runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which checks the tag, publishes `ufo-agents` to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) and provenance, and creates the GitHub release. No npm token is stored anywhere.

## One-time setup

These steps are done once, by a maintainer of the `ufo-agents` package on npmjs.com and of `rlaope/ufo` on GitHub.

1. **Trusted publisher.** On [npmjs.com](https://www.npmjs.com/package/ufo-agents), open the package `ufo-agents` → **Settings** → **Trusted publishing**, choose **GitHub Actions**, and enter:

   | Field | Value |
   |---|---|
   | Organization or user | `rlaope` |
   | Repository | `ufo` |
   | Workflow filename | `release.yml` (the file name only, not `.github/workflows/release.yml`) |
   | Environment name | `npm-release` (the publish job's GitHub environment, step 2) |

   Every field is case-sensitive. npm expects a new trusted publisher configuration to complete its first publish within 2 days; if it does not, add it again before you tag. Without the environment name, npm would accept an OIDC token from any job of any `release.yml` in the repository, including one on a pushed branch that skips the checks.
2. **GitHub environment.** In `rlaope/ufo` → **Settings** → **Environments**, create `npm-release`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add only the tag rule `v*`, so no branch can deploy to it. Optionally add `rlaope` as a **required reviewer**, so each publish waits for an approval on the run's page.
3. **Tag ruleset.** In **Settings** → **Rules** → **Rulesets**, add a tag ruleset targeting `v*` with **Restrict creations**, **Restrict updates**, and **Restrict deletions**, and only the **Repository admin** role in its bypass list. Then only the admin (or a token of the admin's) can push, move, or delete a release tag. The checks the workflow runs live in the tagged commit's own `release.yml`, so this ruleset and the environment, which are set outside the repository, are what keep a changed workflow from publishing.
4. **Disallow tokens.** On npmjs.com, after the first release through the workflow succeeds, set **Settings** → **Publishing access** to "Require two-factor authentication and disallow tokens". Trusted publishing still works, since it does not use a token. Revoke any npm automation or publish tokens you created for this package.
5. **Tag signing.** The workflow refuses a tag that GitHub does not show as verified, or whose tagger email is not the `RELEASE_TAGGER_EMAIL` at the top of `release.yml`. Configure git to sign tags (`git config --global gpg.format ssh` and `user.signingkey`, or a GPG key), and add the same key to your GitHub account as a **signing** key.
6. **Repository secret.** `IDENTITY_PATTERN` must be set (it already is for the identity-gate workflow). The release fails without it.

## Release checklist

1. On a branch from `main`, set the version: `npm version <x.y.z> --no-git-tag-version`. It updates `package.json` and `package-lock.json`.
2. Add a `## [x.y.z] - YYYY-MM-DD` section to [CHANGELOG.md](../CHANGELOG.md). The workflow publishes that section as the GitHub release notes and refuses a version without one.
3. Run the local gates and the release audit:

   ```sh
   npm run lint && npm run typecheck && npm run build && npm test && bash scripts/identity-gate.sh
   npm run audit:deps
   bash scripts/release-check.sh vx.y.z
   ```

4. Merge the release commit to `main` through a pull request.
5. Tag the merged commit on `main` and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -s vx.y.z -m "vx.y.z"
   git push origin vx.y.z
   ```

A version with a prerelease part (`0.2.0-rc.1`) is published under the npm dist-tag `next`, not `latest`, and its GitHub release is marked as a prerelease.

## What the workflow checks

The `check` job runs on the tagged commit, with read-only access and no OIDC token:

- the tag is `v` plus the `package.json` version, and `CHANGELOG.md` has a section for it (`scripts/release-check.sh`)
- the tag is annotated, signed with a signature GitHub verifies, by the tagger `RELEASE_TAGGER_EMAIL` names, points at exactly the commit the run releases (`$GITHUB_SHA`), and is on `main` (`scripts/release-tag-check.sh`)
- `npm ci --ignore-scripts`, lint, typecheck, the full test suite, and the build
- the identity gate over the repository: paths, file contents, every commit's contents and metadata, tags, and pull requests
- `npm run audit:deps`: the runtime dependencies and the copies they bundle
- `npm pack`, then the identity gate over the extracted tarball (`scripts/identity-gate.sh --dir`), since the tarball holds the build rather than the repository's files

The `publish` job runs in the `npm-release` environment, downloads that tarball, and publishes it with `npm publish --provenance --access public`. It is the only job with `id-token: write`, and it runs none of the repository's code. Its npm is upgraded to a pinned 11.x, because trusted publishing needs npm 11.5.1 or later and Node 22 bundles npm 10. The `github-release` job, the only one that can write to the repository, then creates the release from the `CHANGELOG.md` section.

If a job fails, nothing after it runs. A failure before `publish` leaves npm untouched: fix the cause, delete the tag (`git push origin :refs/tags/vx.y.z` and `git tag -d vx.y.z`), and tag again. If `publish` succeeded and only `github-release` failed, re-run that job from the Actions page.

## Verifying a release

- `npm view ufo-agents@x.y.z dist.attestations --json` shows a `provenance` entry with the predicate type `https://slsa.dev/provenance/v1`. The package page on npmjs.com shows the provenance, linking the workflow run and the commit.
- In a project that installed it, `npm audit signatures` reports the package as having a verified attestation ([npm's provenance docs](https://docs.npmjs.com/generating-provenance-statements)).
- The GitHub release for the tag exists and its notes match `CHANGELOG.md`.

## Rolling back

npm versions are permanent in practice: a published `name@version` can never be published again, even after an unpublish ([npm unpublish policy](https://docs.npmjs.com/policies/unpublish)).

- **Prefer a fix release.** Publish `x.y.(z+1)` with the fix. If the broken version is `latest`, point `latest` back at the last good version until then: `npm dist-tag add ufo-agents@<good> latest`.
- **Deprecate** the broken version so installs warn: `npm deprecate ufo-agents@x.y.z "<reason>; use <good>"`. It stays installable.
- **Unpublish** only within 72 hours of publishing, and only when no other public package depends on it: `npm unpublish ufo-agents@x.y.z`. After 72 hours npm allows it only for a package with no dependents, fewer than 300 downloads in the past week, and a single maintainer. Unpublishing every version blocks new publishes for 24 hours.

Deprecate, dist-tag, and unpublish are run by a maintainer from a terminal with two-factor authentication, not by the workflow.
