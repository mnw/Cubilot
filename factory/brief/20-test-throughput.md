# Part 20: test throughput

Status: decision of the human, 2026-10-30. Build it first after Part 6 ships.

## Why

The tester is the bottleneck. Every tested ticket runs the full suite (`./scripts/test.sh`: 196 test files, 81 of them integration, about 6 minutes), and only one suite runs at a time under the heavy lock (`/tmp/cubilot-heavy.lock`). After each merge the Orchestrator runs the suite again on staging. Night of 2026-10-29: tester slots ran about 15 hours, workers and validators about 1 hour each (night report, section 4). Ten tickets in review mean about one hour of suite time before any review.

## Decisions of the human

- High tickets keep their own full suite (t_739f stays). Low tickets move to the affected tests.
- The full suite still runs on staging, once per batch of merges.

## Steps

### 1. Measure (low)

- Time per test file in one full run, split into unit, integration and contract (bun test report output).
- The peak memory of a full run (`CUBILOT_TEST_PEAK=1`).
- Result: a table of the 20 slowest files with their time, and the peak in MB, written into this part. Steps 5 and 6 use it.

#### Result (measured 2026-10-30)

- Run: `CUBILOT_TEST_PEAK=1 ./scripts/test.sh --reporter=junit --reporter-outfile=test-reports/part20-measure/junit.xml` at staging commit `b07f8e0a4336e42fb757b394d025347c5db0bc89` (the commit of the branch base; staging has since moved on).
- Exit 0. 2627 pass, 0 fail, 199 files. Total run 383.6 s (bun test), plus 29 s Rust pre-build. Peak RSS 724 MB (limit 2048 MB).
- Report and full log: `test-reports/part20-measure/junit.xml` and `run.log`.
- File seconds are the sum of the test case times of the file. Setup and hook time is not in them. The sum over all files is 366.5 s. The rest of the 383.6 s (17.1 s, 4.5 percent) is setup, hooks and teardown.

| Group | Files | Seconds |
|-------|-------|---------|
| unit | 111 | 107.0 |
| integration | 84 | 259.5 |
| contract | 3 | 0.0 |
| helpers (`tests/helpers/smoke.test.ts`) | 1 | 0.0 |
| Sum of test cases | 199 | 366.5 |
| Total run (bun test) | 199 | 383.6 |

The 20 slowest files:

| # | File | Group | Seconds |
|---|------|-------|---------|
| 1 | `tests/unit/test-script.test.ts` | unit | 37.6 |
| 2 | `tests/integration/ticket-blockers-merge.test.ts` | integration | 29.9 |
| 3 | `tests/integration/lead-briefing-stage-peers.test.ts` | integration | 22.8 |
| 4 | `tests/integration/one-live-stage.test.ts` | integration | 21.2 |
| 5 | `tests/integration/agent-stream-takeover.test.ts` | integration | 17.9 |
| 6 | `tests/integration/context-pack-launch.test.ts` | integration | 15.7 |
| 7 | `tests/unit/stage-prep.test.ts` | unit | 13.0 |
| 8 | `tests/integration/role-models-hub.test.ts` | integration | 12.9 |
| 9 | `tests/integration/agent-skills-hub.test.ts` | integration | 11.4 |
| 10 | `tests/unit/context-pack.test.ts` | unit | 10.9 |
| 11 | `tests/integration/stage-cancelled.test.ts` | integration | 7.5 |
| 12 | `tests/integration/checkpoint.test.ts` | integration | 7.3 |
| 13 | `tests/integration/writing-chain-ste-gate.test.ts` | integration | 7.2 |
| 14 | `tests/integration/high-ticket-two-validators.test.ts` | integration | 6.5 |
| 15 | `tests/unit/worktrees.test.ts` | unit | 6.5 |
| 16 | `tests/unit/context-pack-launch.test.ts` | unit | 6.3 |
| 17 | `tests/integration/writing-chain-e2e.test.ts` | integration | 6.1 |
| 18 | `tests/integration/agent-reload.test.ts` | integration | 5.8 |
| 19 | `tests/integration/stage-draft-done-cancel.test.ts` | integration | 5.3 |
| 20 | `tests/integration/roster-context.test.ts` | integration | 5.0 |

### 2. Affected tests for low tickets (low)

- New script `scripts/test-affected.sh <base commit>`: the files that the ticket changed since its base, the test files that import them (directly or through one level of re-export), plus all of `tests/contract/`. It runs them under the same lock, time limit and memory limit as `test.sh`, and prints the list of test files it ran.
- An empty or failed selection falls back to the full suite.
- `factory/tester/tester.md`: a low ticket runs `test-affected.sh` with the ticket's base commit; a high ticket runs `./scripts/test.sh` as today. The result says which one ran (`full_suite: true | false`, `tests_run: [...]`).

### 3. Full suite per batch on staging, with a bisect (low)

- The Orchestrator runs the staging suite once after a batch of merges (already the practice).
- New script `scripts/bisect-staging.sh <last green commit>`: when the staging suite fails, it runs `git bisect` over the merge commits since the last green staging commit, with the failing test files first, and names the first bad merge.
- `factory/orchestrator/orchestrator.md`: on a red staging suite, run the bisect, revert the bad merge on staging (signed), and send its ticket back to the Worker with the failing test. Record the last green staging commit in the merge note.

### 4. Skip a duplicate staging run (low)

- When the merged staging commit has the same tree as the commit the Tester tested (`git rev-parse <commit>^{tree}` equal), the Tester result is the staging evidence. The Orchestrator does not run the staging suite for that merge, and the merge note says "tree equal to <tested commit>".

### 5. Faster slow tests (tickets from step 1)

- One ticket for each slow file or group of files, from the step 1 table: fixed waits replaced by events, a server started once per file instead of once per test, timeouts shortened in tests.

### 6. Two suites at once (decide after step 1)

- Only if two memory peaks together stay well under the machine's memory (36 GB).
- Each run gets its own temp folder, ports and tmux socket, from a run id in the environment.
- The heavy lock becomes two slots. The tester limit stays at 2.

## Tests

1. A low ticket that changes one hub file runs only the tests that import it and the contract tests; the result has `full_suite: false` and the list.
2. A high ticket runs the full suite; the hub refuses a high result with `full_suite: false` (t_739f).
3. A selection that finds no test file runs the full suite.
4. A staging suite that fails after three merges: the bisect names the merge that added the failing test.
5. A merge whose tree equals the tested commit gets no staging suite, and the merge note says so.

## Measure

After one week, compare with the night of 2026-10-29: tester hours, suite runs per merged ticket, time from Worker hand-in to merge, and staging suite failures that the affected tests missed. If the affected tests miss more than one real failure a week, widen the selection.
