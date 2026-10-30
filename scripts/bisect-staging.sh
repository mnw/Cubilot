#!/bin/bash
# Name the merge on staging that broke the suite: git bisect over the first-parent history since a green commit.
#
#   scripts/bisect-staging.sh <last green commit> [failing test file ...]
#
# Each step runs scripts/test.sh (heavy lock, time limit, memory limit) with the failing test files, or the full suite
# when none is given. Exit 0 from the run is good, exit 1 is bad. Any other exit code (lock, limit, wrapper error) is
# not a verdict: the bisect stops. Prints "first bad merge: <sha> ticket <id>". The revert stays an Orchestrator action.
#
#   CUBILOT_BISECT_TEST_CMD   test command per step (default: scripts/test.sh next to this script); tests only
#
# Exit: 0 first bad merge named; 2 usage, dirty tree, bisect or step error. Always back on the start branch or commit,
# with git bisect reset, also when a step fails. The whole body is one function and the script ends with `exit`, so
# bash never reads the file again while the checkout changes it.
set -u

fail() { echo "scripts/bisect-staging.sh: $1" >&2; exit 2; }

main() {
  export LC_ALL=C
  [ "$#" -ge 1 ] || fail "usage: bisect-staging.sh <last green commit> [failing test file ...]"
  local good_ref=$1
  shift
  local here test_cmd
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || fail "cannot find the script folder"
  test_cmd=${CUBILOT_BISECT_TEST_CMD:-$here/test.sh}

  local good
  start_sha="" start_branch=""  # global: the EXIT trap runs after main returns
  good=$(git rev-parse --verify --quiet "$good_ref^{commit}") || fail "not a commit: $good_ref"
  start_sha=$(git rev-parse --verify HEAD) || fail "no HEAD"
  start_branch=$(git symbolic-ref --quiet --short HEAD || true)
  [ -z "$(git status --porcelain --untracked-files=no)" ] || fail "the working tree has changes; commit or clean it first"
  git merge-base --is-ancestor "$good" "$start_sha" || fail "$good_ref is not an ancestor of HEAD"

  restore() {
    git bisect reset > /dev/null 2>&1
    if [ -n "$start_branch" ]; then git checkout -q "$start_branch"; else git checkout -q --detach "$start_sha"; fi
  }
  trap restore EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local out verdict
  out=$(git bisect start --first-parent "$start_sha" "$good" 2>&1) || fail "git bisect start failed: $out"
  while :; do
    case $out in *" is the first "?bad?" commit"*) break ;; esac
    "$test_cmd" "$@"
    verdict=$?
    case $verdict in
      0) out=$(git bisect good 2>&1) || fail "git bisect good failed: $out" ;;
      1) out=$(git bisect bad 2>&1) || fail "git bisect bad failed: $out" ;;
      *) fail "test step exited $verdict at $(git rev-parse --short HEAD); no verdict" ;;
    esac
  done

  local bad subject id
  bad=$(printf '%s\n' "$out" | sed -n 's/^\([0-9a-f]\{40\}\) is the first .bad. commit$/\1/p' | head -n 1)
  [ -n "$bad" ] || fail "cannot read the first bad commit from git bisect"
  subject=$(git log -1 --format=%s "$bad")
  id=unknown
  [[ $subject =~ t_[0-9a-f]{16} ]] && id=${BASH_REMATCH[0]}
  echo "first bad merge: $bad ticket $id"
  echo "subject: $subject"
}

main "$@"
exit $?
