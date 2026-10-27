#!/bin/bash
# Make a stage worktree ready for tests: bun on PATH, node_modules, sidecar and bundles, tmux.
# Run it from the worktree root. It writes .stage-prep.env; a tester sources it (`. ./.stage-prep.env && ...`),
# because shell state does not persist between Bash calls.
#
# A step is fresh only when .stage-prep/<step>.ok exists, no input is newer than the stamp, and every output check
# passes. The stamp is written only after the step and its checks exit 0. Steps build-sidecars and build-tmux run
# under the heavy lock (as scripts/test.sh); freshness is checked again once the lock is held.
#
#   CUBILOT_HEAVY_LOCK         lock directory (default /tmp/cubilot-heavy.lock)
#   CUBILOT_LOCK_WAIT_S        seconds to wait for the lock before exit 3 (default 240)
#   CUBILOT_LOCK_RETRY_S       seconds between lock attempts (default 2)
#   STAGE_PREP_BUN_CANDIDATES  test only: colon-separated dirs that replace the bun search list
#
# Exit: 0 success; 3 lock timeout; 4 bun not found; 1 a step failed (the step name is on stderr).
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
STAMPS=.stage-prep
LOCK=${CUBILOT_HEAVY_LOCK:-/tmp/cubilot-heavy.lock}
LOCK_WAIT_S=${CUBILOT_LOCK_WAIT_S:-240}
LOCK_RETRY_S=${CUBILOT_LOCK_RETRY_S:-2}
OWNER_NAME=${CHATBRIDGE_AGENT:-$(id -un)}
LOCK_HELD=0

# Step 0: find bun and put its dir first in PATH before any child script runs.
BUN=""
if [ -n "${STAGE_PREP_BUN_CANDIDATES+x}" ]; then
  IFS=: read -r -a dirs <<< "$STAGE_PREP_BUN_CANDIDATES"
  for d in "${dirs[@]+"${dirs[@]}"}"; do
    if [ -n "$d" ] && [ -x "$d/bun" ]; then BUN="$d/bun"; break; fi
  done
else
  BUN=$(command -v bun 2> /dev/null || true)
  for c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun; do
    [ -n "$BUN" ] && break
    [ -x "$c" ] && BUN=$c
  done
fi
if [ -z "$BUN" ]; then echo "stage-prep: bun not found" >&2; exit 4; fi
BUN_DIR=$(dirname "$BUN")
export PATH="$BUN_DIR:$PATH"

if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
TRIPLE=$(rustc -Vv 2> /dev/null | awk '/host:/{print $2}')
TRIPLE=${TRIPLE:-aarch64-apple-darwin}
SIDECAR="src-tauri/binaries/cubilot-bin-$TRIPLE"

release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  if [ "$(awk '{ print $2 }' "$LOCK/owner" 2> /dev/null)" = "$$" ]; then rm -r "$LOCK" 2> /dev/null; fi
  LOCK_HELD=0
}
trap release_lock EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

take_lock() {
  local start now
  start=$(date +%s)
  while ! mkdir "$LOCK" 2> /dev/null; do
    now=$(date +%s)
    if [ $((now - start)) -ge "$LOCK_WAIT_S" ]; then
      echo "stage-prep: the heavy lock $LOCK is held; owner: $(cat "$LOCK/owner" 2> /dev/null || echo unknown)" >&2
      exit 3
    fi
    sleep "$LOCK_RETRY_S"
  done
  LOCK_HELD=1
  echo "$OWNER_NAME $$ $(date +%s)" > "$LOCK/owner"
}

# Output checks, one per step.
check_install() { [ -x node_modules/.bin/tsc ]; }
check_sidecars() {
  [ -x "$SIDECAR" ] && codesign -v "$SIDECAR" 2> /dev/null \
    && [ -s src-tauri/resources/pi-extension.js ] && [ -s src-tauri/resources/chatbridge-mod.js ]
}
check_tmux() {
  [ -x src-tauri/resources/tmux ] && codesign -v src-tauri/resources/tmux 2> /dev/null \
    && src-tauri/resources/tmux -V > /dev/null 2>&1
}

# Fresh: stamp exists, no existing input is newer, output checks pass. Inputs are files or dirs.
is_fresh() {
  local step=$1 stamp="$STAMPS/$1.ok" i
  [ -f "$stamp" ] || return 1
  local inputs=()
  for i in "${INPUTS[@]}"; do [ -e "$i" ] && inputs+=("$i"); done
  if [ -n "$(find "${inputs[@]}" -type f -newer "$stamp" -print -quit 2> /dev/null)" ]; then return 1; fi
  "check_$step"
}

# run_step <name> <command...>
run_step() {
  local name=$1 code
  shift
  echo "stage-prep: step $name" >&2
  rm -f "$STAMPS/$name.ok"
  "$@"
  code=$?
  if [ "$code" -ne 0 ]; then echo "stage-prep: step $name failed (exit $code)" >&2; exit 1; fi
  if ! "check_$name"; then echo "stage-prep: step $name failed (output check)" >&2; exit 1; fi
  touch "$STAMPS/$name.ok"
}

mkdir -p "$STAMPS"

INPUTS_install=(package.json bun.lock)
INPUTS_sidecars=(hub package.json bun.lock scripts/build-sidecars.sh)
INPUTS_tmux=(scripts/build-tmux.sh)

fresh() { INPUTS=("${@:2}"); is_fresh "$1"; }

fresh install "${INPUTS_install[@]}" || run_step install bun install --frozen-lockfile

if ! { fresh sidecars "${INPUTS_sidecars[@]}" && fresh tmux "${INPUTS_tmux[@]}"; }; then
  take_lock
  # Another holder may have built a step while this run waited.
  fresh sidecars "${INPUTS_sidecars[@]}" || run_step sidecars ./scripts/build-sidecars.sh
  fresh tmux "${INPUTS_tmux[@]}" || run_step tmux ./scripts/build-tmux.sh
  release_lock
fi

{
  printf 'export PATH=%q:%q:/opt/homebrew/bin:"$PATH"\n' "$ROOT/src-tauri/resources" "$BUN_DIR"
} > .stage-prep.env
exit 0
