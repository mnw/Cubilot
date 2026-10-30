#!/bin/bash
# The default full test run: `bun test "$@"` under the heavy-process lock, a time limit and a memory limit.
# A run that hangs or grows without end is stopped, and nothing it started stays alive.
#
# With no argument the run is split into CUBILOT_TEST_PARTS parts (default 3). Each part is one bun test process with its
# own list of test files, balanced by the per-file seconds of test-reports/part20-measure/junit.xml (scripts/split-tests.ts).
# The parts run at the same time. Each part has its own CUBILOT_TEST_RUN_ID, TMPDIR and CUBILOT_TEST_TMUX_DIR (the folder
# of its tmux sockets). One summary adds the pass and fail lines of all parts and names the files of each failed part. The
# logs of a failed run stay in the folder the summary names. With arguments, or with CUBILOT_TEST_PARTS=1, the run is one
# bun test process, as before.
#
#   CUBILOT_TEST_PARTS        number of parts for a run with no argument (default 3)
#   CUBILOT_TEST_TIMEOUT_S    seconds from the start of bun test until it is stopped (default 520). It covers the whole run:
#                             all parts are stopped. The Rust pre-build (see below) is not counted.
#   CUBILOT_TEST_MAX_RSS_MB   total RSS of all test process groups in MB (default 2048 times the number of parts). One limit
#                             for the sum. Checked every second: a mitigation, not a strict ceiling. A process that leaves
#                             its group is not counted.
#   CUBILOT_TEST_PEAK         set to 1 to print the peak summed RSS in MB when the run ends (default: not printed)
#   CUBILOT_TEST_ROOT         the folder with tests/ to split (default: the repository)
#   CUBILOT_TEST_REPORT       the JUnit report with the per-file seconds (default test-reports/part20-measure/junit.xml)
#   CUBILOT_HEAVY_LOCK        lock directory (default /tmp/cubilot-heavy.lock). The script takes it itself and it is
#                             not reentrant: do not take the lock before you call the script.
#   CUBILOT_LOCK_RETRY_S      seconds between lock attempts (default 30)
#   CUBILOT_LOCK_WAIT_S       seconds to wait for the lock before exit 3 (default 600)
#
# Before bun test starts, with the lock held, the script compiles the Rust code that tests/unit/role-harness.test.ts
# runs (`cargo test --lib --no-run`). That compile is then outside the measured process group. It uses the
# CARGO_TARGET_DIR of the caller. A failed build exits with the cargo exit code and no bun run.
#
# Exit: the exit code of bun test (of the first failed part in a split run); 1 wrapper error (also a failing ps: the run is stopped, not left unchecked);
# 2 bad setting; 3 lock not obtained; 124 time limit; 125 memory limit;
# 129 HUP; 130 INT; 143 TERM. each bun test runs as the leader of its own process group; only those groups are ever signalled.
set -u

usage_error() { echo "scripts/test.sh: $1" >&2; exit 2; }
positive_int() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; [ "$1" -gt 0 ]; }

TIMEOUT_S=${CUBILOT_TEST_TIMEOUT_S:-520}
PARTS=${CUBILOT_TEST_PARTS:-3}
LOCK=${CUBILOT_HEAVY_LOCK:-/tmp/cubilot-heavy.lock}
LOCK_RETRY_S=${CUBILOT_LOCK_RETRY_S:-30}
LOCK_WAIT_S=${CUBILOT_LOCK_WAIT_S:-600}
# The number of bun test processes: a split run only for a run with no argument.
[ $# -eq 0 ] || PARTS_USED=1
for v in PARTS TIMEOUT_S LOCK_RETRY_S LOCK_WAIT_S; do
  positive_int "${!v}" || usage_error "CUBILOT setting for $v must be a positive integer, got '${!v}'"
done
if [ -n "${CUBILOT_TEST_MAX_RSS_MB+x}" ]; then
  MAX_RSS_MB=$CUBILOT_TEST_MAX_RSS_MB
else
  MAX_RSS_MB=$((2048 * ${PARTS_USED:-$PARTS}))
fi
positive_int "$MAX_RSS_MB" || usage_error "CUBILOT setting for MAX_RSS_MB must be a positive integer, got '$MAX_RSS_MB'"
command -v bun > /dev/null 2>&1 || usage_error "bun is not on PATH"

OWNER_NAME=${CHATBRIDGE_AGENT:-$(id -un)}
LOCK_HELD=0
CHILDREN=""   # pids of the jobs this script started (space separated)
TARGETS=""    # their kill targets: "-<pgid>" for a job that leads a group of its own, else the pid
PGIDS=""      # the group numbers (for the RSS query)
RUNDIR=""     # folder of a split run: logs, part lists, temp folders
NAP_PID=""

# A sleep that a trap can interrupt at once.
nap() { sleep "$1" & NAP_PID=$!; wait "$NAP_PID" 2> /dev/null; NAP_PID=""; }

# Liveness of what this script started, asked with signal 0: no ps, so a failing ps cannot make a living group look gone.
# The target is the process group of the job (the job leads it), or the job pid when it has no group of its own.
target_alive() { kill -0 -- "$1" 2> /dev/null; }
any_alive() { local t; for t in $TARGETS; do target_alive "$t" && return 0; done; return 1; }
# The RSS sum of all the groups. A failing or empty ps is an error (status 1), never "0 KB".
group_rss_kb() {
  local out
  out=$(ps -axo pgid=,rss= 2> /dev/null) || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | awk -v g=" $PGIDS " 'index(g, " " $1 " ") { s += $2 } END { print s + 0 }'
}
# Start a job as the leader of a process group of its own. Sets JOB_PID and adds it to the lists.
start_job() {
  set -m
  "$@" &
  JOB_PID=$!
  set +m
  CHILDREN="$CHILDREN $JOB_PID"
  if target_alive "-$JOB_PID"; then
    TARGETS="$TARGETS -$JOB_PID"
    PGIDS="$PGIDS $JOB_PID"
  else
    TARGETS="$TARGETS $JOB_PID"
  fi
}
reset_jobs() { CHILDREN=""; TARGETS=""; PGIDS=""; }

# The owner line is "<name> <pid> <epoch>". A name may hold spaces (AGENT_NAME_RE), so the pid is the second field from
# the END. Prints nothing when the file is missing, unreadable or has fewer than three fields.
owner_pid() { awk 'NR == 1 && NF >= 3 { print $(NF - 1) }' "$1/owner" 2> /dev/null; }
owner_name() { sed -n '1s/ [^ ]* [^ ]*$//p' "$1/owner" 2> /dev/null; }
# Dead = kill -0 fails for a reason other than a permission error (a live process of another user is alive).
pid_dead() {
  local out
  out=$(kill -0 "$1" 2>&1) && return 1
  case "$out" in *[Nn]"ot permitted"*) return 1 ;; esac
  return 0
}

release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  # Only the lock this process took: the owner line names this pid.
  if [ "$(owner_pid "$LOCK")" = "$$" ]; then rm -r "$LOCK" 2> /dev/null; fi
  LOCK_HELD=0
}

# Remove the lock when its owner process is dead. The check and the removal run under an flock(2) mutex on the file
# $LOCK.takeover (fd 9, taken with perl): the owner is read again under it, so a run that lost the race sees the new live
# owner and removes nothing. The kernel drops the flock when the holder dies, so a crashed run cannot leave the mutex
# held. An empty directory $LOCK.takeover from an older version is removed first. A removal is followed at once by a
# normal mkdir attempt. Returns 0 only when it removed a stale lock. No perl or no mutex: returns 1 (wait as before).
takeover_stale() {
  local pid name rc=1
  rmdir "$LOCK.takeover" 2> /dev/null
  command -v perl > /dev/null 2>&1 || return 1
  : >> "$LOCK.takeover" 2> /dev/null || return 1
  exec 9>> "$LOCK.takeover"
  if perl -e 'open(F, ">&=9") or exit 2; flock(F, 6) or exit 1' 2> /dev/null; then
    pid=$(owner_pid "$LOCK")
    if positive_int "$pid" && pid_dead "$pid"; then
      name=$(owner_name "$LOCK")
      if rm -r "$LOCK" 2> /dev/null; then
        echo "stale heavy lock from $name $pid taken over" >&2
        rc=0
      fi
    fi
  fi
  exec 9>&-
  return $rc
}

# TERM, wait up to 5 s, KILL, wait up to 2 s. Every wait is bounded, and only the jobs this script started (their groups,
# or the pids when they have no group) are signalled. The bash `wait` runs only when a job is gone, so it cannot block.
kill_group() {
  [ -n "$CHILDREN" ] || return 0
  local t c i
  for t in $TARGETS; do target_alive "$t" && kill -TERM -- "$t" 2> /dev/null; done
  i=0
  while [ "$i" -lt 50 ] && any_alive; do sleep 0.1; i=$((i + 1)); done
  if any_alive; then
    for t in $TARGETS; do target_alive "$t" && kill -KILL -- "$t" 2> /dev/null; done
    i=0
    while [ "$i" -lt 20 ] && any_alive; do sleep 0.1; i=$((i + 1)); done
    for t in $TARGETS; do target_alive "$t" && echo "scripts/test.sh: could not stop $t" >&2; done
  fi
  for c in $CHILDREN; do target_alive "$c" || wait "$c" 2> /dev/null; done
  return 0
}

stop_run() {
  case "$PGIDS" in
    "") echo "scripts/test.sh: $1; stopping test process$CHILDREN" >&2 ;;
    " "*" "*) echo "scripts/test.sh: $1; stopping process groups$PGIDS" >&2 ;;
    *) echo "scripts/test.sh: $1; stopping process group$PGIDS" >&2 ;;
  esac
  kill_group
  exit "$2"
}

# Any exit path, also a wrapper error: nothing of the run stays alive, and the lock goes.
on_exit() { kill_group; release_lock; clean_rundir; return 0; }
# A run folder is removed unless a failed split run keeps its logs.
clean_rundir() {
  [ -n "$RUNDIR" ] || return 0
  if [ -f "$RUNDIR/tmux-dirs" ]; then while IFS= read -r d; do rm -rf "$d" 2> /dev/null; done < "$RUNDIR/tmux-dirs"; fi
  [ "${KEEP_RUNDIR:-0}" = 1 ] || rm -rf "$RUNDIR" 2> /dev/null
  return 0
}
on_signal() {
  [ -n "$NAP_PID" ] && kill "$NAP_PID" 2> /dev/null
  if [ -n "$CHILDREN" ]; then stop_run "received $1" "$2"; fi
  exit "$2"
}
trap on_exit EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

waited=0
while ! mkdir "$LOCK" 2> /dev/null; do
  takeover_stale && continue
  if [ "$waited" -ge "$LOCK_WAIT_S" ]; then
    echo "scripts/test.sh: the heavy lock $LOCK is held; owner: $(cat "$LOCK/owner" 2> /dev/null || echo unknown)" >&2
    exit 3
  fi
  nap "$LOCK_RETRY_S"
  waited=$((waited + LOCK_RETRY_S))
done
LOCK_HELD=1
echo "$OWNER_NAME $$ $(date +%s)" > "$LOCK/owner"

echo "memory limit ${MAX_RSS_MB} MB"

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD_START=$(date +%s)
# The pre-build leads a process group of its own, so a signal to this script stops cargo and its children.
start_job cargo test --manifest-path "$ROOT/src-tauri/Cargo.toml" --lib --no-run
wait "$JOB_PID"
build_code=$?
kill_group
reset_jobs
if [ "$build_code" -ne 0 ]; then
  echo "scripts/test.sh: the Rust pre-build failed (exit $build_code); bun test not started" >&2
  exit "$build_code"
fi
echo "rust pre-build: $(($(date +%s) - BUILD_START)) s"

# Watch the started jobs until all have ended: the time limit for the whole run, the memory limit for the summed RSS.
# An RSS sum is the peak of the run when CUBILOT_TEST_PEAK=1.
PEAK_KB=0
watch_jobs() {
  local start rss_kb
  start=$(date +%s)
  while any_alive_pid; do
    if [ $(($(date +%s) - start)) -ge "$TIMEOUT_S" ]; then stop_run "time limit of ${TIMEOUT_S}s reached" 124; fi
    rss_kb=$(group_rss_kb) || stop_run "the process query (ps) failed or gave nothing, so the memory limit cannot be checked" 1
    [ "$rss_kb" -gt "$PEAK_KB" ] && PEAK_KB=$rss_kb
    if [ "$rss_kb" -gt $((MAX_RSS_MB * 1024)) ]; then stop_run "memory limit reached ($((rss_kb / 1024)) MB, limit ${MAX_RSS_MB} MB)" 125; fi
    nap 1
  done
}
any_alive_pid() { local c; for c in $CHILDREN; do kill -0 "$c" 2> /dev/null && return 0; done; return 1; }
print_peak() { [ "${CUBILOT_TEST_PEAK:-}" = 1 ] && echo "peak RSS $((PEAK_KB / 1024)) MB"; return 0; }

if [ -n "${PARTS_USED:-}" ] || [ "$PARTS" -eq 1 ]; then
  # One bun test process, with the arguments of the caller (or none for CUBILOT_TEST_PARTS=1).
  start_job bun test "$@"
  # The job leads a group of its own, numbered with its pid. A group that does not exist (no job control) is never
  # guessed. Then only the job pid is signalled.
  if [ -z "$PGIDS" ] && target_alive "$JOB_PID"; then stop_run "bun test has no process group of its own" 1; fi
  watch_jobs
  wait "$JOB_PID"
  code=$?
  print_peak
  exit "$code"
fi

# A split run: one bun test process for each part, all at the same time.
TEST_ROOT=${CUBILOT_TEST_ROOT:-$ROOT}
REPORT=${CUBILOT_TEST_REPORT:-$ROOT/test-reports/part20-measure/junit.xml}
RUNDIR=$(mktemp -d "${TMPDIR:-/tmp}/cubilot-test-run.XXXXXX") || { echo "scripts/test.sh: no run folder" >&2; exit 1; }
RUN_ID="$$-$(date +%s)"
bun "$ROOT/scripts/split-tests.ts" "$TEST_ROOT" "$REPORT" "$PARTS" > "$RUNDIR/split.txt" || { echo "scripts/test.sh: the split of the test files failed" >&2; exit 1; }
[ -s "$RUNDIR/split.txt" ] || { echo "scripts/test.sh: no test file found under $TEST_ROOT/tests" >&2; exit 1; }
echo "parts $PARTS"
RUN_START=$(date +%s)
PART_NOS=""
PART_PIDS=""
k=1
while [ "$k" -le "$PARTS" ]; do
  awk -F'\t' -v k="$k" '$1 == k { print "./" $2 }' "$RUNDIR/split.txt" > "$RUNDIR/p$k.files"
  if [ -s "$RUNDIR/p$k.files" ]; then
    files=()
    while IFS= read -r f; do files+=("$f"); done < "$RUNDIR/p$k.files"
    mkdir -p "$RUNDIR/p$k.tmp"
    # Own run id, temp folder and tmux socket folder for each part. The tmux folder is short: a socket path is limited.
    TMUX_DIR=$(mktemp -d /tmp/cubilot-run.XXXXXX) || { echo "scripts/test.sh: no tmux folder" >&2; exit 1; }
    echo "$TMUX_DIR" >> "$RUNDIR/tmux-dirs"
    start_job env CUBILOT_TEST_RUN_ID="$RUN_ID-p$k" TMPDIR="$RUNDIR/p$k.tmp" CUBILOT_TEST_TMUX_DIR="$TMUX_DIR" \
      bash -c 'cd "$1" || exit 1; log=$2; shift 2; exec bun test "$@" > "$log" 2>&1' _ "$TEST_ROOT" "$RUNDIR/p$k.log" "${files[@]}"
    PART_NOS="$PART_NOS $k"
    PART_PIDS="$PART_PIDS $JOB_PID"
  fi
  k=$((k + 1))
done
for pid in $CHILDREN; do
  if ! target_alive "-$pid" && target_alive "$pid"; then stop_run "a bun test part has no process group of its own" 1; fi
done

watch_jobs

# One summary: the sums of all parts, and the files of each failed part.
code=0
total_pass=0
total_fail=0
total_tests=0
total_files=0
failed_parts=""
set -- $PART_PIDS
for k in $PART_NOS; do
  wait "$1"
  part_code=$?
  shift
  log="$RUNDIR/p$k.log"
  total_pass=$((total_pass + $(awk '/^ *[0-9]+ pass$/ { s += $1 } END { print s + 0 }' "$log")))
  total_fail=$((total_fail + $(awk '/^ *[0-9]+ fail$/ { s += $1 } END { print s + 0 }' "$log")))
  total_tests=$((total_tests + $(sed -nE 's/^Ran ([0-9]+) tests? across .*/\1/p' "$log" | awk '{ s += $1 } END { print s + 0 }')))
  total_files=$((total_files + $(sed -nE 's/^Ran [0-9]+ tests? across ([0-9]+) files?.*/\1/p' "$log" | awk '{ s += $1 } END { print s + 0 }')))
  if [ "$part_code" -ne 0 ]; then
    [ "$code" -eq 0 ] && code=$part_code
    failed_parts="$failed_parts $k:$part_code"
  fi
done
echo " $total_pass pass"
echo " $total_fail fail"
echo "Ran $total_tests tests across $total_files files in $PARTS parts. [$(($(date +%s) - RUN_START))s]"
for kc in $failed_parts; do
  k=${kc%%:*}
  echo "part $k failed with exit ${kc#*:}; test files of part $k:"
  sed 's/^/  /' "$RUNDIR/p$k.files"
  grep -h '^(fail)' "$RUNDIR/p$k.log" | sed 's/^/  /'
done
if [ -n "$failed_parts" ]; then
  KEEP_RUNDIR=1
  echo "logs of the parts: $RUNDIR"
fi
print_peak
exit "$code"
