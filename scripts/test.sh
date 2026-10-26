#!/bin/bash
# The default full test run: `bun test "$@"` under the heavy-process lock, a time limit and a memory limit.
# A run that hangs or grows without end is stopped, and nothing it started stays alive.
#
#   CUBILOT_TEST_TIMEOUT_S    seconds from the start of bun test until it is stopped (default 300)
#   CUBILOT_TEST_MAX_RSS_MB   total RSS of the test process group in MB (default 2048). Checked every second:
#                             a mitigation, not a strict ceiling. A process that leaves the group is not counted.
#   CUBILOT_HEAVY_LOCK        lock directory (default /tmp/cubilot-heavy.lock). The script takes it itself and it is
#                             not reentrant: do not take the lock before you call the script.
#   CUBILOT_LOCK_RETRY_S      seconds between lock attempts (default 30)
#   CUBILOT_LOCK_WAIT_S       seconds to wait for the lock before exit 3 (default 600)
#
# Exit: the exit code of bun test; 1 wrapper error (also a failing ps: the run is stopped, not left unchecked);
# 2 bad setting; 3 lock not obtained; 124 time limit; 125 memory limit;
# 130 INT; 143 TERM. bun test runs as the leader of its own process group; only that group is ever signalled.
set -u

usage_error() { echo "scripts/test.sh: $1" >&2; exit 2; }
positive_int() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; [ "$1" -gt 0 ]; }

TIMEOUT_S=${CUBILOT_TEST_TIMEOUT_S:-300}
MAX_RSS_MB=${CUBILOT_TEST_MAX_RSS_MB:-2048}
LOCK=${CUBILOT_HEAVY_LOCK:-/tmp/cubilot-heavy.lock}
LOCK_RETRY_S=${CUBILOT_LOCK_RETRY_S:-30}
LOCK_WAIT_S=${CUBILOT_LOCK_WAIT_S:-600}
for v in TIMEOUT_S MAX_RSS_MB LOCK_RETRY_S LOCK_WAIT_S; do
  positive_int "${!v}" || usage_error "CUBILOT setting for $v must be a positive integer, got '${!v}'"
done
command -v bun > /dev/null 2>&1 || usage_error "bun is not on PATH"

OWNER_NAME=${CHATBRIDGE_AGENT:-$(id -un)}
LOCK_HELD=0
CHILD=""
PGID=""
NAP_PID=""

# A sleep that a trap can interrupt at once.
nap() { sleep "$1" & NAP_PID=$!; wait "$NAP_PID" 2> /dev/null; NAP_PID=""; }

# Liveness of what this script started, asked with signal 0: no ps, so a failing ps cannot make a living group look gone.
# The target is the process group of the child (the child leads it), or the child pid when it has no group of its own.
target_alive() { kill -0 -- "$1" 2> /dev/null; }
# The RSS sum of the group. A failing or empty ps is an error (status 1), never "0 KB".
group_rss_kb() {
  local out
  out=$(ps -axo pgid=,rss= 2> /dev/null) || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | awk -v g="$PGID" '$1 == g { s += $2 } END { print s + 0 }'
}

release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  # Only the lock this process took: the owner line names this pid.
  if [ "$(awk '{ print $2 }' "$LOCK/owner" 2> /dev/null)" = "$$" ]; then rm -r "$LOCK" 2> /dev/null; fi
  LOCK_HELD=0
}

# TERM, wait up to 5 s, KILL, wait up to 2 s. Every wait is bounded, and only the child this script started (its group,
# or the pid when it has no group) is signalled. The bash `wait` runs only when the child is gone, so it cannot block.
kill_group() {
  [ -n "$CHILD" ] || return 0
  local target i
  if [ -n "$PGID" ]; then target="-$PGID"; else target="$CHILD"; fi
  if target_alive "$target"; then
    kill -TERM -- "$target" 2> /dev/null
    i=0
    while [ "$i" -lt 50 ] && target_alive "$target"; do sleep 0.1; i=$((i + 1)); done
    if target_alive "$target"; then
      kill -KILL -- "$target" 2> /dev/null
      i=0
      while [ "$i" -lt 20 ] && target_alive "$target"; do sleep 0.1; i=$((i + 1)); done
      if target_alive "$target"; then echo "scripts/test.sh: could not stop $target" >&2; fi
    fi
  fi
  target_alive "$CHILD" || wait "$CHILD" 2> /dev/null
  return 0
}

stop_run() {
  if [ -n "$PGID" ]; then echo "scripts/test.sh: $1; stopping process group $PGID" >&2; else echo "scripts/test.sh: $1; stopping test process $CHILD" >&2; fi
  kill_group
  exit "$2"
}

# Any exit path, also a wrapper error: nothing of the run stays alive, and the lock goes.
on_exit() { kill_group; release_lock; }
on_signal() {
  [ -n "$NAP_PID" ] && kill "$NAP_PID" 2> /dev/null
  if [ -n "$CHILD" ]; then stop_run "received $1" "$2"; fi
  exit "$2"
}
trap on_exit EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

waited=0
while ! mkdir "$LOCK" 2> /dev/null; do
  if [ "$waited" -ge "$LOCK_WAIT_S" ]; then
    echo "scripts/test.sh: the heavy lock $LOCK is held; owner: $(cat "$LOCK/owner" 2> /dev/null || echo unknown)" >&2
    exit 3
  fi
  nap "$LOCK_RETRY_S"
  waited=$((waited + LOCK_RETRY_S))
done
LOCK_HELD=1
echo "$OWNER_NAME $$ $(date +%s)" > "$LOCK/owner"

set -m # job control: the background job leads a new process group
bun test "$@" &
CHILD=$!
set +m
# The child leads a group of its own, numbered with its pid. Signal 0 to that group tells it exists: no ps needed, and
# a group that does not exist (no job control) is never guessed. Then only the child pid is signalled.
if target_alive "-$CHILD"; then PGID=$CHILD; else PGID=""; fi
if [ -z "$PGID" ] && target_alive "$CHILD"; then stop_run "bun test has no process group of its own" 1; fi

START=$(date +%s)
while kill -0 "$CHILD" 2> /dev/null; do
  if [ $(($(date +%s) - START)) -ge "$TIMEOUT_S" ]; then stop_run "time limit of ${TIMEOUT_S}s reached" 124; fi
  rss_kb=$(group_rss_kb) || stop_run "the process query (ps) failed or gave nothing, so the memory limit cannot be checked" 1
  if [ "$rss_kb" -gt $((MAX_RSS_MB * 1024)) ]; then stop_run "memory limit reached ($((rss_kb / 1024)) MB, limit ${MAX_RSS_MB} MB)" 125; fi
  nap 1
done
wait "$CHILD"
code=$?
exit "$code"
