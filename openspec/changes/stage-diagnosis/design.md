## Context

See `proposal.md` for the reason. Current state, from `openspec/changes/stage-sessions` and the code:

- `hub/kinds/stage.ts` holds the stage machine (`queued → launching → running → passed | retrying → … → failed`, `MAX_ATTEMPT = 2`). `stopStage` queues a `close` and moves the stage at once. `endLaunchAttempt` handles a launch with no ack or an error ack. `reportFinalFailure` calls `onFinalFailure`, which sends a handoff to the Orchestrator. `startWaiting` relaunches a `retrying` stage when a slot of its role is free.
- `hub/core/launch-queue.ts` carries `launch` and `close` requests to `src-tauri/src/launches.rs`. Only `hub/kinds/stage.ts` may import it.
- The bridge core (`hub/channel/core.ts`) has `onRunStart`, `onRunEnd` (posts `turn-end`) and `onToolResult(tool, ok)` (chatbridge tools only, no error text).
- `factory.rs` already takes a `LaunchChoice` (model, effort) for one launch. A hub launch request has no model or effort today.
- `config.yml` lives in `<app data>/`. Rust parses it and passes hub settings as env (the summariser does this).
- tmux sessions use `remain-on-exit off`. A dead pane is gone at once.
- `openspec/changes/context-pack` adds `stage_metrics (stage_id, attempt, role, …)`, written after `stage.passed` or `stage.failed` from the Claude transcript JSONL of the worktree cwd. Pi has `source = 'none'` until its file format is checked.
- `pty_capture_turn` is the single primitive for a deterministic single-turn capture. This change does not capture a turn: it reads the scrollback once and sends no input.

## Goals / Non-Goals

**Goals:** a trace and a failure record for each stage failure; a cause from code when code can know it; else a cause from the cheapest model that the score allows; one fixed action for each failure.

**Non-Goals:** a third attempt; diagnosis of diagnosis; a free-form action; any write by the Diagnostician; trace retention.

## Decisions

1. **The hub is the only writer of the trace.** `hub/core/trace.ts`, `appendTrace(stageId, attempt, source, step, fields)`. The shell supplies its lines in the ack body (`received_at`, `spawned_at`, `tmux_error`). The bridge supplies `first_message` and `tool_error` on `POST /stages/<id>/trace`, and its turn end on the existing `turn-end` route. The hub writes `bridge_connect` when the stage session opens its agent stream.
   - Why: three processes that append to one file can mix lines, and each needs the path and the redaction. One writer keeps one order and one redaction point.
   - Alternative: each process appends with `O_APPEND`. Rejected: interleaving and three copies of `redactPrivate`.
   - Steps: `launch_request`, `shell_ack`, `tmux_spawn`, `bridge_connect`, `first_message`, `turn_end`, `result_refused`, `reminder`, `result`, `capture`, `close`, `retry`, `fail`, `tool_error`. `elapsed_ms` counts from the first line of the file. A line is cut at 4 KiB. The folder has mode `0700`, the files `0600`. A write error is logged and never thrown.

2. **Failure records are a kind: `failure`.** `hub/kinds/failure.ts`, table `failure (id, stage_id, attempt, room, ticket_id, request_id, role, category, score, tier, facts_json, record_path, action, action_note, cause, component, cause_key, gap_ticket_id, fixture_path, mark, mark_note, status, created_seq, updated_seq, version)`. Status: `recorded → acted → dismissed` (`dismissed` only after `escalate`, human only). Events `failure.recorded`, `failure.acted`, `failure.dismissed`, `failure.marked` (human only, any status after `acted`, no status change), each one event and one row update. The full record (pane text, tool error, worktree check) is a JSON file next to the trace: `<app data>/traces/<stage_id>.failure-<attempt>.json`. The ledger row holds what code and the UI query.
   - Why a kind: a hub restart must not forget a failure that waits for its action. A memory map loses it.
   - Unique index on `(stage_id, attempt)`: one record for each attempt.

3. **The pane is captured before the close.** A new launch-queue request `capture { session, lines: 200 }`. The shell runs `tmux -S <tmux.sock> capture-pane -p -J -S -200 -t <session>` and also reports `has_session`, `tmux_ok` (`tmux -V` runs) and `bridge_staged` (the staged mod or extension of the harness exists). `stopStage` queues `capture`, then `close`. The shell handles requests in order, so the capture runs first. The hub writes the record at the capture ack, or after 15 s with the note `capture timed out`.
   - It sends no input and changes no window size, so it is not a turn capture and does not compete with `pty_capture_turn`.
   - A launch that never started a session gets no capture (note `no session`).

4. **Exit status from a file.** For a hub launch, the session command ends with `; echo $? > <app data>/sessions/<session>/exit`, inside the `$SHELL -ic` argv element. The hub reads the file for the record. A `close` from the hub kills tmux first, so a closed session writes no file. That is the purpose: a file means the process ended by itself.
   - Alternative: `remain-on-exit on` and `#{pane_dead_status}`. Rejected: CLAUDE.md requires `remain-on-exit off`.
   - Limit: a crashed session has no pane to capture (the pane is gone). The record then has the exit status, the last tool error and the trace only.

5. **Last tool error.** The bridge reports a failed tool with the tool name and the first 2 KiB of the error text: chatbridge tools in both adapters (the text is the thrown error). For other tools: Claude through the mod's `tool.call` result when it shows an error, Pi through its tool result event. Whether both harnesses expose the error of a non-chatbridge tool is untested; task 3.3 checks it and records the gap. The policy (what to send, the cap) is in `core.ts`; the adapters pass the text only.

6. **Category rules.** A pure function `categorize(record, traceLines)` in `hub/core/failure-rules.ts`. First match:
   1. `missing setup`: no project folder; worktree create error; `package.json` without `node_modules`; `bridge_staged` false; `tmux_ok` false.
   2. `no connect`: `shell_ack` spawned and no `bridge_connect` in the attempt.
   3. `no first message`: `bridge_connect` and no `first_message`.
   4. `crash`: an exit file exists, or the session left the room, and no stop by the hub came first.
   5. `time-out`: the stop reason is the time-out.
   6. `refused result`: a `result_refused` line and no `result` line in the attempt.
   7. `no result`: two or more `turn_end` lines and no `result`.
   8. `unknown`.
   A launch error ack or a missing ack that matches no rule is `unknown`: the cause is not known to code.

7. **Score.** A pure function `score(record, ledger facts, settings)` in the same file. Components: each fact names its component (`hub`: launch refused, ack time-out, result refused; `shell`: error ack, tmux error, capture error; `bridge`: no connect, bridge tool error; `agent`: no result, non-chatbridge tool error, exit status not 0; `git/worktree`: worktree check failed). Error lines: distinct lines of the pane and of the trace error fields that match `/error|fail|exception|denied|refused|not found|ENOENT|panic|traceback/i`, after the removal of digits (so timestamps do not make lines distinct). Trace gap: a step of the expected order (`launch_request`, `shell_ack`, `tmux_spawn`, `bridge_connect`, `first_message`, `turn_end`) is missing while a later one is present in the same attempt. Repeat: another stage of the same ticket, or of the same request when there is no ticket, has a failure row. The facts list holds `{component?, points, text}`.

8. **Settings.** `config.yml`:
   ```yaml
   diagnosis:
     points: { component: 1, attempt: 1, error_lines_per_point: 3, error_lines_max: 3, trace_gap: 2, repeat: 2, unknown: 2 }
     tiers: { low_max: 3, medium_max: 6 }
     pattern: { records: 10, hours: 24, burst_count: 3, burst_minutes: 60 }
     outliers: { factor: 3, min_samples: 10, window: 50, repeat_min: 3 }
     timeout_min: 15            # diagnosis stages and pattern runs
     retention: { records_days: 30, fixtures_days: 30 }
   ```
   Rust passes the block as JSON in `CUBILOT_DIAGNOSIS`. The hub checks each value (integer, 0 to 20; `low_max < medium_max`) and uses the default for a bad value with one log line. Model and effort for each tier are fixed in code (not asked to be settings). The pattern and outlier limits are settings too: they are limits in the sense of the brief.

9. **Order of handling a failure.** After `failure.recorded`:
   - code rule matches → `failure.acted` with the rule's action;
   - else tier 0 → `failure.acted` with `retry`;
   - else → create the diagnosis stage.
   Then the action runs (decision 12). The stage stays `retrying` until then: `startWaiting` relaunches a `retrying` stage only when the failure of its current attempt is `acted` with `retry` or `setup-fix-and-retry` and the fix (if any) succeeded. A `failed` stage (attempt 2) gets `escalate` for these two actions, with the note `no attempt left`.
   - Recovery at hub start: a `retrying` stage with no failure row gets a record with the pane note `lost at restart`; a `recorded` failure with a passed diagnosis stage gets its action from the stored result; one with a failed diagnosis stage gets `escalate`.

10. **Diagnosis stages use the stage table.** `review = 'diagnosis'` (a failure) or `review = 'patterns'` (a pattern run), `role = 'diagnostician'`. New nullable columns `stage.failure_id` and `stage.room`. `STAGE_ROOM_SQL` reads `s.room` first. A unique partial index on `stage(failure_id) WHERE review = 'diagnosis'` makes one diagnosis for each failure. `pattern_scope (stage_id, failure_id)` lists the records of a pattern run, written in the `stage.queued` transaction (as `stage_scope` for spec stages).
    - The diagnosis stage starts through `enqueueLaunch` like every stage, so "only the stage logic queues launches" stays true.
    - `MAX_ATTEMPT` is 1 for these stages: a stop moves them to `failed`. No failure record is written for them.
    - Time-out: `diagnosis.timeout_min` (default 15) replaces the room's `stage_timeout_min` for these stages. A time-out moves the diagnosis stage to `failed`; its failure gets `escalate` (`action_note = 'diagnosis timed out'`), and a stage that waits in `retrying` for it moves to `failed`. The waiting retry never starts. Review decision (human, 2026-10-27).
    - Worktree: read-only (`READ_ONLY_ROLES` gets `diagnostician`), detached at the commit in the failed stage's worktree check, else at the ticket branch head, else HEAD. A pattern run uses HEAD.
    - Role limit: `role_limits.diagnostician`, default 1.
    - `diagnostician` is not in `STAGE_ROLES` (ticket roles). A separate list `HUB_ROLES` holds it for the launch, the limits and the slot names (`diagnostician-<n>`).

11. **Launch carries the tier.** The `launch` request gets optional `model` and `effort`. `launches.rs` passes them as the `LaunchChoice` of the launch. Tier 1: `sonnet`/`low`; tier 2: `sonnet`/`medium`; tier 3 and pattern runs: `opus`/`high`. Other stages send neither field and behave as today.

12. **Results and actions.** The result is a handoff to the room lead with `context.review = "diagnosis"` (or `"patterns"`), checked by `checkResult` as in `stage-sessions` 5.1. The hub records the handoff with UI-only scope (it is not delivered to the lead) and accepts it at once with actor `system`, so it never shows as pending. Then, in separate transactions (no new cross-kind transaction):
    - `stage.passed` for the diagnosis stage;
    - `failure.acted` with the action taken;
    - the effect: relaunch (`retry`); fix then relaunch (`setup-fix-and-retry`); `ticket.created` as `draft` by `system` with `request_id = r-diag-<failure_id>` (`gap-ticket`; created first and looked up by request id on restart, so it is created once); the cause-key rule of decision 16 decides first whether a ticket is created; handoff to the lead (`ticket-change`); "Needs you" row (`escalate`). Non-retry actions move a `retrying` stage to `failed`.
    - Fix list: `recreate-worktree` (remove and add the stage worktree again); `install-deps` (`bun install --frozen-lockfile` in the worktree when `bun.lock` exists, under `/tmp/cubilot-heavy.lock`, time limit 300 s). A failed fix makes the action `escalate`.

13. **Report line.** At `failure.acted` the hub sends the room lead one message from `system`: `Ticket <ticket_id | request <request_id> | no ticket>: stage <id> (<role>) failed: <cause or category>. Evidence: <one item, 160 chars>. Action: <action taken>.` For `ticket-change` this text is the task of the handoff instead. This replaces `onFinalFailure`, so a final failure gives one line, not a line and a handoff. A failure with an ignored key sends no line (decision 16).

14. **Pattern run.** Triggers for each room: new records ≥ `records`; or `burst_count` new records of one category within `burst_minutes` (checked at each `failure.recorded`, so a burst starts the run at once); or ≥ 1 new record and `hours` since the last pattern run started (or since the oldest new record when there was none; checked by the 30 s sweep). One pattern run at a time for each room; a trigger during a run waits for its end. Scope: the new failure records and the new outlier attempts (decision 17), in `pattern_scope (stage_id, item_kind 'failure'|'outlier', item_id)`, where an outlier `item_id` is `<stage_id>#<attempt>`. The first message holds each record with its mark (decision 19). Result: `proposals: [{cause, component, cause_slug, items, title, acceptance_criteria}]`, each with two or more `items` from its own scope. Each proposal goes through the cause-key rule (decision 16). A failed pattern run marks nothing; the next trigger starts a new one.

15. **UI.** The ticket card shows "Why it failed" from the newest acted failure of the ticket, with a "trace" link that opens `GET /traces/<stage_id>` in a dialog (`<pre>`, vanilla JS, no framework). "Needs you" lists `escalate` failures with a Dismiss button (human only, `POST /failures/<id>/dismiss`).

16. **Cause keys.** The key is `<category>/<component>/<cause_slug>`. The Diagnostician sets `component` (fixed list) and `cause_slug` (`^[a-z0-9-]{1,60}$`); the first message lists the room's known keys with their state, so it can reuse one. A pattern proposal has no single category: it uses the category of most of its items (ties: the first in the category list). `tickets.cause_key` (nullable) stores the key on the gap ticket. The state of a key is derived from the newest ticket of the room with that key: open (not `done` or `cancelled`), resolved (`done`), ignored (`cancelled` with `tickets.cause_ignored = 1`), or active-again (`cancelled` without it). Cancel does not mean ignore: the human sets `ignore_cause: true` on the cancel (human only; one `ticket.cancelled` event that carries it, one row update). A human reopen (`cancelled → draft`, `ticket.reopened`, gap tickets only) clears `cause_ignored`. Review decision (human, 2026-10-27).
    - Open: `failure.gap_ticket_id` is set to that ticket; no new ticket. The ticket card lists its failures (`SELECT … FROM failure WHERE gap_ticket_id = ?`).
    - Resolved or active-again: a new draft gap ticket whose text names the earlier ticket.
    - Ignored: no ticket, no "Needs you", no line to the lead; `action_note = 'ignored key'`. Retries still follow decisions 9 and 12.
    - Why derived: a separate `cause_key` kind would add a state machine for data the ticket already holds.
    - The reopen is an exception to "`cancelled` is terminal" in `work-tickets`; the delta is in `specs/work-tickets/spec.md` of this change.

17. **Stage metrics and outliers.** This change adds columns to the `stage_metrics` table of `context-pack`: `duration_ms`, `turns`, `tokens_total`, `repeated_tool_calls`, `outliers_json`. Same writer, same time (after `stage.passed`, `stage.retrying` or `stage.failed`), same rule: a failure logs one line and changes nothing. `duration_ms` and `turns` come from the trace (first `launch_request` of the attempt to its end; count of `turn_end` lines), so they exist for both harnesses. `tokens_total` sums all usage fields of the transcript; `repeated_tool_calls` counts `tool_use` blocks whose `(name, JSON input)` occurred earlier in the attempt. Pi: NULL until its file format is checked.
    - Outlier rule: for duration, turns and tokens, value > `factor` × median of the same role and room over the last `window` attempts with a value, when there are at least `min_samples`; for repeated tool calls, value ≥ `repeat_min`. Computed when the row is written; the result goes into `outliers_json`. A new outlier is one that no passed pattern run included.
    - Diagnosis stages and pattern runs get metrics too ("every stage"), but are left out of the outlier scope, so a pattern run never reads itself.

18. **Fixtures.** At a `proven` result, the hub copies the trace and the record file to `<app data>/fixtures/<failure_id>/trace.jsonl` and `failure.json` (already redacted, mode `0600`), and stores the path in `failure.fixture_path`. A fixture is saved only when the failure is linked to a gap ticket (so every fixture has a ticket that ends its retention, decision 21). The gap ticket gets `tickets.fixture_id = <failure_id>` and one acceptance criterion: "A minimal synthetic test reproduces the failure of fixture `<failure_id>`: it fails before the fix and passes after it." When a failure is added to an open gap ticket (decision 16), its fixture is kept but the ticket's `fixture_id` does not change.
    - The fixture never enters the repository. The Worker's first message holds it (64 KiB cap), so the Worker needs no read outside its worktree. The test is synthetic: no raw pane text, no absolute path, no value from the fixture (ids, timestamps, tokens, file contents). It reproduces the mechanism, not the log. Review decision (human, 2026-10-27).
    - The Validator checks this: no line of the fixture's pane or trace and no absolute path in the diff. The role file gets the check; the Validator can grep the diff against the fixture text in its first message.
    - Done gate: `checkResult` refuses a Validator `PASS` on a ticket with `fixture_id` unless `context.fixture_test = {path, command, before: "FAIL", after: "PASS", output_excerpt}` and `context.suite = {command, result: "PASS", output_excerpt}`; each excerpt is non-empty and at most 2 KiB. The final PASS path of `stage-sessions` (decision 3) is the only way such a ticket reaches `done` by `system`; a `high` ticket still goes to the lead for the human's Allow. The hub cannot run the test itself; the Validator's evidence is the check, as for every other verdict.
    - The hub writes nothing into the project folder.

19. **Marks.** "Needs you" gets a group "Check a diagnosis": acted failures of the room with a passed diagnosis stage, no mark and no ignored key. `POST /failures/<id>/mark {mark: "right"|"wrong", note?}`, human only (403 for others), writes `failure.marked`. A later mark replaces the earlier one. The pattern run's first message shows the mark and the note of each record.

20. **Success metric.** `GET /rooms/<room>/diagnosis-metrics` (token), derived by SQL, nothing stored: for each tier (0 to 3), `started` = acted failures whose action was `retry` or `setup-fix-and-retry` and whose stage reached a next attempt; `passed` = those whose next attempt ended `passed`; `share = passed / started` (null when 0); plus the count of each other action. Shown with the other numbers of the room; no UI in this change beyond the route.
    - Why "started" as the base: `escalate`, `gap-ticket` and `ticket-change` have no next attempt, so they cannot lead to a PASS. Counting them would punish a correct escalation.

21. **Masking and retention.** No opt-in (review decision, human, 2026-10-27).
    - `maskSecrets(text)` in `hub/core/redaction.ts`, called by `appendTrace`, the record writer and the fixture copy, after `redactPrivateText`. Patterns (each match becomes `[masked:<kind>]`): `sk-ant-[A-Za-z0-9_-]{10,}` (anthropic), `sk-(proj-)?[A-Za-z0-9_-]{20,}` (openai), `gh[pousr]_[A-Za-z0-9]{36,}` and `github_pat_[A-Za-z0-9_]{20,}` (github), `(AKIA|ASIA)[0-9A-Z]{16}` (aws), `xox[abprs]-[A-Za-z0-9-]{10,}` (slack), `AIza[0-9A-Za-z_-]{35}` (google), `eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+` (jwt), `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` (private-key), `Bearer\s+[A-Za-z0-9._~+/=-]{16,}` (bearer), `(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+` (assignment; the name stays), and the exact hub token (hub-token). A known list, not a guarantee: an unknown format passes.
    - Retention: the sweep checks once an hour. Trace and record files older than `records_days` (by mtime) are deleted; the ledger row stays with `record_path` note `deleted after retention`. A fixture is deleted `fixtures_days` after its gap ticket became `done` or `cancelled` (time of that event); a reopen stops the clock. Deletion errors are logged and retried at the next check.
    - Backups: `<app data>` is in the Part 5 restic backup (hourly, kept 48 hourly, 14 daily, 8 weekly). The traces and fixtures folders are not excluded, so a deleted file stays in older snapshots for up to about 8 weeks, encrypted. Masking happens before the write, so backups hold only masked text.

## Risks / Trade-offs

- [Failure records keep pane text on disk without an opt-in. A secret in an unknown format is not masked.] → Masking of known patterns, `<private>` redaction, mode `0600`, 30-day retention (decision 21). Accepted risk in CLAUDE.md (task 11.1), including the backup copies.
- [A crashed session has no pane.] → The exit status, the tool error and the trace remain. `remain-on-exit` stays off by rule.
- [The tool error of a non-chatbridge tool may not reach the bridge.] → Task 3.3 measures it on both harnesses. Without it, the field is `null` with the note `not exposed by harness`.
- [The Diagnostician has Bash. Bash can still write: `sh -c`, `find -delete`, `git -C`, redirects, other tools.] → Read-only worktree plus a blocked list: `git commit`, `push`, `checkout`, `reset`, `clean`, `restore`, `stash`, `rebase`, `merge`, and `rm` (`Bash(git commit:*)` … `Bash(rm:*)`). This is not a sandbox; the role file and `docs/rules/kinds.md` say so.
- [A stage now waits for a diagnosis before its retry, so a retry comes later.] → Tier 0 and the code rules act at once. Only tier 1+ waits.
- [The skill `evidence-collector` does not exist under that name.] → The factory has `agency-testing-evidence-collector` (tester). This change uses it.
- [The Worker could still paste fixture text into the test.] → The fixture never enters the repo by design; the Validator checks the diff against the fixture text and for absolute paths. A check by people, not by code.
- [The Validator's `fixture_test` and `suite` fields are claims, not a hub run.] → They carry the command and an output excerpt, so the claim can be checked; same trust level as every verdict.
- [A diagnosis time-out leaves the stage `failed` with no retry, even when a retry would have worked.] → The failure escalates, so the human sees it. Accepted (review decision).
- [The score weights are guesses.] → They are settings. The record keeps each fact, so the weights can be checked against outcomes later.

## Migration Plan

- Snapshot first (`stage-sessions` decision 13).
- Next schema version: `CREATE TABLE failure (...)`, `CREATE TABLE pattern_scope (...)`, `ALTER TABLE stage ADD COLUMN failure_id TEXT`, `ADD COLUMN room TEXT`, the unique partial index, `ALTER TABLE tickets ADD COLUMN cause_key TEXT`, `ADD COLUMN fixture_id TEXT`, `ADD COLUMN cause_ignored INTEGER NOT NULL DEFAULT 0`, and the five `stage_metrics` columns of decision 17 (after the `context-pack` migration creates the table). Each step guarded, so a second run changes nothing. Existing `role_limits` rows get `diagnostician: 1` when read (default fill, no rewrite).
- Archive order (review decision, human, 2026-10-27): `stage-sessions`, `spec-review-stage` and `context-pack` are archived before this change. Before this change is archived, the requirements it copied from them (retry hold, final-failure report, result checks, "Needs you" groups, `stage_metrics` columns) become MODIFIED deltas of the archived specs (last task).
- Rollback: restore the snapshot. The new columns are nullable, so an older hub ignores them.
