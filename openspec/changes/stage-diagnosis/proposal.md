## Why

When a stage session fails, nobody knows why. The causes in the records are guesses ("probable, not proven"). The Orchestrator uses its own context to investigate each failure. This change records what happened in each stage, and code or a separate read-only role finds the cause.

Source: human decision, 2026-10-27. This version replaces the earlier stage-diagnosis request. Amended the same day: cause keys, fixtures, stage metrics, burst trigger, marks, success metric.
Depends on: `openspec/changes/stage-sessions` (stage kind, launch channel, retries, result schema; not yet archived) `openspec/changes/spec-review-stage` ("Needs you", draft tickets for spec review) and `openspec/changes/context-pack` (`stage_metrics` table and its writer; not yet archived).

## What Changes

- **Stage trace:** one JSONL file for each stage at `<app data>/traces/<stage_id>.jsonl`. The hub, the Rust shell and the bridge each supply lines for the launch request, the shell ack, the tmux spawn, the bridge connect, the first message, each turn end, a refused result, a reminder, the result, the close and the retry. Each line has a timestamp and the elapsed time.
- **Failure record:** code writes one record when a stage attempt ends without a result (stop, time-out, launch error). The record has the last 200 lines of the pane, the exit status, the last tool error, a worktree check and one category from a fixed list. The pane is captured before the session closes.
- **Code rules:** three categories (missing setup, no connect, time-out with no output) get a fixed action from code. No diagnosis stage starts for them.
- **Complexity score and tier:** code computes a score from the failure record. The score sets the tier: 0 = code only, 1–3 = sonnet × low, 4–6 = sonnet × medium, 7+ = opus × high. The points and the tier limits are settings in `config.yml`. The record stores the score, each fact that adds points, and the tier.
- **Diagnostician role:** a new factory role. Claude. Read-only like the Validator. Bash blocks `git commit`, `push`, `checkout`, `reset`, `clean`, `restore`, `stash`, `rebase`, `merge` and `rm`. These are limits, not a sandbox.
- **Diagnosis stage:** the hub starts one diagnosis stage for each failure at tier 1 or higher. Its result has a cause, evidence, a confidence (`proven` | `probable`) and one action from a fixed list.
- **Actions:** code runs `retry` and `setup-fix-and-retry` (at most once for each failure; `setup-fix-and-retry` only for a proven cause). `gap-ticket` creates a draft ticket. `ticket-change` goes to the Orchestrator. `escalate` goes to "Needs you".
- **Patterns:** once a day, or after 10 new failure records in a room, one diagnosis stage (opus × high) reads the new records together and proposes one gap ticket for each cause that repeats.
- **Cause keys:** each gap ticket has a cause key (category + component + cause). A failure with the key of an open gap ticket is added to that ticket; no new ticket. A key is open, resolved (ticket done) or ignored (the human cancelled the ticket with "ignore this cause"). A plain cancel keeps the key active. Reopening the ticket ends the ignore. An ignored key stays quiet.
- **Fixtures:** a proven diagnosis saves its trace and failure record as a fixture in app data. Its gap ticket needs a minimal synthetic test that reproduces the failure, with no raw pane text, absolute path or fixture value. The ticket reaches `done` only when the Validator's PASS shows the command and an output excerpt for this test and for the full suite.
- **Masking and retention:** known secret patterns are masked before any trace, record or fixture is written. Records are deleted after 30 days; fixtures 30 days after their gap ticket closes. App data is in the Part 5 backup.
- **Diagnosis time-out:** a diagnosis stage has its own time-out. On time-out the failure escalates and the waiting retry does not start.
- **Stage metrics:** every stage attempt, also a PASS, records duration, turns, tokens and repeated tool calls. Outliers go into the next pattern run.
- **Burst trigger:** the pattern run also starts when one category occurs 3 times in one hour in a room.
- **Marks:** in "Needs you" the human marks a diagnosis right or wrong. The pattern run reads the marks.
- **Success metric:** for each tier, the share of diagnoses whose action led to a PASS on the next attempt.
- **Reporting:** the Orchestrator gets one line for each failure (ticket id, cause, evidence, action taken). The ticket card shows "Why it failed" with a link to the trace.
- **Changed stage-sessions behaviour:** a stage in `retrying` relaunches only after its failure record has the action `retry` or `setup-fix-and-retry`. The handoff to the Orchestrator on a final failure is replaced by the one line.

## Capabilities

### New Capabilities

- `stage-traces`: the trace file of a stage, the failure record and its category.
- `stage-diagnosis`: the complexity score and tier, the code rules, the Diagnostician role, diagnosis stages, the actions, cause keys, fixtures, marks, the pattern run, the success metric and the failure report.
- `stage-outliers`: the metrics of every stage attempt and the outlier rule that feeds the pattern run.

### Modified Capabilities

- `work-tickets`: a cancelled gap ticket can be reopened by the human; a cancel can carry `ignore_cause`.

`stage-sessions`, `spec-review-stage` and `context-pack` are not archived yet, so their changed rules (retry hold, gap-ticket PASS check, "Needs you" groups, more metric columns) are written as ADDED requirements here. Archive order: those three first, then this change. The last task turns the copied requirements into MODIFIED deltas of the archived specs.

## Not in this change

- A diagnosis of a diagnosis stage or of a pattern run.
- More than two attempts for one stage. The retry from a diagnosis is the one retry that `stage-sessions` already allows.
- Windows, Linux and Intel support. macOS ARM64 only.

## Impact

- `hub/core/trace.ts` (new), `hub/kinds/failure.ts` (new kind), `hub/kinds/stage.ts` (records, hold, diagnosis stages, actions, pattern run), `hub/kinds/handoff.ts` (diagnosis result routing), `hub/core/launch-queue.ts` (`capture` request, `model` and `effort` on `launch`), `hub/core/first-message.ts`, `hub/core/ledger.ts` (migration).
- `hub/channel/core.ts` and both adapters: first-message and tool-error reports. Rebuild sidecars and run `check-mod.sh`.
- `src-tauri/src/launches.rs` (`capture` request, model and effort on launch), `src-tauri/src/pty.rs` (exit-status file), `src-tauri/src/lib.rs` (`diagnosis:` block of `config.yml` to the hub).
- `factory/diagnostician/` (new role, first message, skills including the new `stage-failure-categories`).
- `ui/`: "Why it failed" on the ticket card, trace view, escalated failures and right/wrong marks in "Needs you".
- `tickets.cause_key`, `tickets.fixture_id`; `stage_metrics` gets duration, turns, total tokens and repeated tool calls.
- `<app data>/fixtures/<failure_id>/` (new).
- High blast radius: the automatic actions and the launch of the new role. The amendment items are low radius (human, 2026-10-27).
