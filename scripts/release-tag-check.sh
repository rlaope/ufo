#!/usr/bin/env bash
# Release tag check: the tag is an annotated tag on origin/main whose signature GitHub verifies,
# made by the expected tagger, and pointing at exactly the commit this run releases. The release
# workflow runs it with `gh` reading the tag through GitHub's API. See docs/release.md.
#
# Usage: bash scripts/release-tag-check.sh <tag>    (for example v0.1.0)
# Environment: GITHUB_REPOSITORY (owner/name), GITHUB_SHA (the commit being released),
# RELEASE_TAGGER_EMAIL (the only tagger accepted), and GH_TOKEN for gh.
# Exit status: 0 ok, 1 the tag is refused, 2 usage.
set -euo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

[[ $# -eq 1 && -n "$1" ]] || {
  echo "usage: release-tag-check.sh <tag>" >&2
  exit 2
}
tag="$1"
for name in GITHUB_REPOSITORY GITHUB_SHA RELEASE_TAGGER_EMAIL; do
  [[ -n "${!name:-}" ]] || {
    echo "release-tag-check: $name is not set" >&2
    exit 2
  }
done

git merge-base --is-ancestor "$GITHUB_SHA" origin/main || fail "$tag is not on main"

ref="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha')"
[[ "${ref%% *}" == "tag" ]] || fail "$tag is not an annotated tag"

fields="$(gh api "repos/$GITHUB_REPOSITORY/git/tags/${ref#* }" \
  --jq '[.object.type, .object.sha, (.tagger.email // ""), (.verification.verified | tostring)] | join("\u001f")')"
# A unit separator, not whitespace, so an empty field (no tagger email) is kept as one.
IFS=$'\x1f' read -r type target email verified <<<"$fields"

[[ "$type" == "commit" && "$target" == "$GITHUB_SHA" ]] ||
  fail "$tag points at $type $target, not the commit this run releases ($GITHUB_SHA)"
[[ "$email" == "$RELEASE_TAGGER_EMAIL" ]] ||
  fail "$tag was tagged by '$email', not $RELEASE_TAGGER_EMAIL"
[[ "$verified" == "true" ]] ||
  fail "GitHub does not verify the signature of $tag (git tag -s, with a signing key added to GitHub)"
