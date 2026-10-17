#!/usr/bin/env bash
# Installs a pre-push hook that runs scripts/identity-gate.sh. Safe to run again; refuses to
# replace a pre-push hook it did not write.
set -euo pipefail

die() {
  echo "install-hooks: $*" >&2
  exit 1
}

git rev-parse --show-toplevel >/dev/null 2>&1 || die "not inside a git work tree"
cd "$(git rev-parse --show-toplevel)"

if hooks_path="$(git config --get core.hooksPath)"; then
  die "core.hooksPath is set to $hooks_path, so git ignores .git/hooks." \
    "Add 'bash scripts/identity-gate.sh' to the pre-push hook there instead."
fi

hook="$(git rev-parse --git-common-dir)/hooks/pre-push"
# The hook resolves the repository root when it runs, not now.
# shellcheck disable=SC2016
wanted='#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh: runs the identity gate before every push.
exec bash "$(git rev-parse --show-toplevel)/scripts/identity-gate.sh"'

if [[ -e "$hook" ]]; then
  if [[ "$(cat "$hook")" == "$wanted" ]]; then
    echo "install-hooks: pre-push hook already installed."
    exit 0
  fi
  die "a different pre-push hook already exists; merge it by hand or remove it, then rerun."
fi

mkdir -p "$(dirname "$hook")"
printf '%s\n' "$wanted" >"$hook"
chmod +x "$hook"
echo "install-hooks: installed the pre-push hook."
