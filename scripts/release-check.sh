#!/usr/bin/env bash
# Release check: the tag names package.json's version, and CHANGELOG.md has a section for it.
# Prints that section, without its heading, to stdout: the release workflow uses it as the
# GitHub release notes. See docs/release.md.
#
# Usage: bash scripts/release-check.sh <tag>    (for example v0.1.0)
# Exit status: 0 ok, 1 the tag and the version differ or CHANGELOG.md has no section, 2 usage.
set -euo pipefail

fail() {
  echo "release-check: $1" >&2
  exit 1
}

[[ $# -eq 1 && -n "$1" ]] || {
  echo "usage: release-check.sh <tag>" >&2
  exit 2
}
tag="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"

version="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
[[ "$tag" == "v$version" ]] || fail "tag $tag does not match package.json version $version"

# The section runs from its heading (## [0.1.0] - 2026-10-23, or ## 0.1.0) to the next ## heading.
notes="$(
  awk -v version="$version" '
    /^## / {
      if (found) exit
      heading = $2
      gsub(/[][]/, "", heading)
      found = (heading == version)
      next
    }
    found { print }
  ' "$root/CHANGELOG.md" | sed '/./,$!d'
)"
[[ -n "$notes" ]] || fail "CHANGELOG.md has no section for $version"
printf '%s\n' "$notes"
