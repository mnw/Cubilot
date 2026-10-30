#!/bin/bash
# A low ticket runs only the tests that its change affects: `scripts/test-affected.sh <base commit>`.
# The selection (scripts/affected-tests.ts) prints the test files. They run through ./scripts/test.sh, so the heavy lock,
# the time limit and the memory limit are the ones of test.sh (same CUBILOT_* settings, same exit codes).
# No test file selected, or a selection step that fails: the full suite runs and the script says so.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1
[ $# -eq 1 ] && [ -n "$1" ] || { echo "usage: scripts/test-affected.sh <base commit>" >&2; exit 2; }

fall_back() {
  echo "test-affected: fell back to the full suite ($1)"
  exec "$ROOT/scripts/test.sh"
}

command -v bun > /dev/null 2>&1 || fall_back "bun is not on PATH"
selection=$(bun "$ROOT/scripts/affected-tests.ts" "$1") || fall_back "the selection step failed"
[ -n "$selection" ] || fall_back "no test file selected"

args=()
while IFS= read -r f; do args+=("./$f"); done <<< "$selection"
echo "test-affected: ${#args[@]} test files:"
printf '%s\n' "$selection"
exec "$ROOT/scripts/test.sh" "${args[@]}"
