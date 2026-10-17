#!/usr/bin/env bash
# Identity gate: exits 1 when anything this repository publishes matches the identity pattern.
#
# The pattern is a case-insensitive extended regular expression (one per line) taken from
# $IDENTITY_PATTERN, or else from the untracked file <git-common-dir>/info/identity-pattern.
# It is never printed. Matches are reported by surface and by file name, commit SHA, or pull
# request number, never by the matched text.
#
# Surfaces:
#   - file paths and ref names
#   - file contents: tracked files plus untracked files that are not ignored, so the gate also
#     works before the first commit
#   - file contents of every commit reachable from any ref
#   - commit metadata and messages (author, committer, message) and annotated tags
#   - pull request titles and bodies, when UFO_GATE_PRS=1 and gh is installed
#
# Exit status: 0 no match, 1 match, 2 error (no pattern, invalid pattern, git or gh failure).
#
# Compatible with bash 3.2 (the macOS default): no arrays, no mapfile.
set -euo pipefail

die() {
  echo "identity-gate: $*" >&2
  exit 2
}

git rev-parse --show-toplevel >/dev/null 2>&1 || die "not inside a git work tree"
cd "$(git rev-parse --show-toplevel)"

pattern="${IDENTITY_PATTERN:-}"
if [[ -z "$pattern" ]]; then
  stored="$(git rev-parse --git-common-dir)/info/identity-pattern"
  if [[ -f "$stored" ]]; then
    pattern="$(cat "$stored")"
  fi
fi

# Every search reads the pattern from a private temporary file, so it never appears in argv
# (visible to other processes) or in the output.
pattern_file="$(mktemp)"
trap 'rm -f "$pattern_file"' EXIT
# A blank line would match everything.
printf '%s\n' "$pattern" | grep -v '^[[:space:]]*$' >"$pattern_file" || true
[[ -s "$pattern_file" ]] ||
  die "no pattern: set IDENTITY_PATTERN or create <git-common-dir>/info/identity-pattern"

status=0
grep -i -E -f "$pattern_file" </dev/null >/dev/null 2>&1 || status=$?
[[ $status -le 1 ]] || die "the pattern is not a valid extended regular expression"

# Succeeds when the text in $1 matches the pattern.
matches() {
  grep -q -i -E -f "$pattern_file" <<<"$1"
}

# git grep -l with the pattern; no match is not an error.
grep_files() {
  local code=0
  git grep -I -i -E -l -f "$pattern_file" "$@" || code=$?
  [[ $code -le 1 ]] || die "git grep failed with status $code"
}

failed=0
# report <surface> <newline-separated items>
report() {
  failed=1
  echo "identity-gate: match in $1:" >&2
  printf '%s\n' "$2" | sed '/^$/d; s/^/  /' >&2
}

# Paths are printed only when the path itself does not match.
withhold_matching() {
  local line
  while IFS= read -r line; do
    if matches "$line"; then
      echo "(name withheld: it matches the pattern)"
    else
      echo "$line"
    fi
  done
}

# File paths and ref names: reported as a count, since the names are the matched text.
names="$(
  git ls-files --cached --others --exclude-standard
  git for-each-ref --format='%(refname)'
)"
count="$(grep -c -i -E -f "$pattern_file" <<<"$names" || true)"
if [[ $count -gt 0 ]]; then
  report "file paths or ref names" "$count name(s); list them with git ls-files and git for-each-ref"
fi

hits="$(grep_files --untracked | withhold_matching)"
if [[ -n "$hits" ]]; then
  report "file contents (tracked and untracked, not ignored)" "$hits"
fi

revs="$(git rev-list --all)"
if [[ -n "$revs" ]]; then
  # One argument per SHA; the output is <sha>:<path>, reduced to the SHA.
  # shellcheck disable=SC2086
  hits="$(grep_files $revs | cut -d: -f1 | sort -u)"
  if [[ -n "$hits" ]]; then
    report "file contents of commits" "$hits"
  fi

  hits=""
  for sha in $revs; do
    if matches "$(git show -s --format='%an%n%ae%n%cn%n%ce%n%B' "$sha")"; then
      hits+="$sha"$'\n'
    fi
  done
  if [[ -n "$hits" ]]; then
    report "commit metadata or messages" "$hits"
  fi
fi

hits=""
while read -r object type; do
  if [[ "$type" == "tag" ]] && matches "$(git cat-file tag "$object")"; then
    hits+="$object"$'\n'
  fi
done < <(git for-each-ref refs/tags --format='%(objectname) %(objecttype)')
if [[ -n "$hits" ]]; then
  report "annotated tags (tag object SHAs)" "$hits"
fi

surfaces="paths, file contents, commit contents, commit and tag metadata"
if [[ "${UFO_GATE_PRS:-}" == "1" ]]; then
  if command -v gh >/dev/null 2>&1; then
    numbers="$(gh pr list --state all --limit 1000 --json number --jq '.[].number')" ||
      die "gh pr list failed"
    hits=""
    for number in $numbers; do
      text="$(gh pr view "$number" --json title,body --jq '.title + "\n" + .body')" ||
        die "gh pr view failed"
      if matches "$text"; then
        hits+="#$number"$'\n'
      fi
    done
    if [[ -n "$hits" ]]; then
      report "pull request titles or bodies" "$hits"
    fi
    surfaces+=", pull requests"
  else
    echo "identity-gate: UFO_GATE_PRS=1 but gh is not installed; pull requests not scanned" >&2
  fi
fi

if [[ $failed -ne 0 ]]; then
  echo "identity-gate: failed. Remove the matches above before publishing." >&2
  exit 1
fi
echo "identity-gate: passed ($surfaces)."
