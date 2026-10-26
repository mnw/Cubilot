## 1. Data

- [ ] 1.1 Snapshot before migration: copy `ledger.db` to `<app data>/snapshots/` (mode `0600`) before `migrate()` runs; stop the migration if the copy fails → verify: unit test with a ledger that needs a migration: snapshot exists before the schema changes; a forced copy failure leaves the schema unchanged
- [ ] 1.2 `migrate()`: add `tickets.role TEXT`, `room_settings.role_limits TEXT`, `room_settings.stage_timeout_min INTEGER`; create table `stage` with `ticket_id` nullable and columns `request_id`, `review`, `verdict`; check: `ticket_id` set when `review IS NULL`, `request_id` set when `review = 'spec'`; each guarded so a second run changes nothing → verify: `migrate()` twice on a fresh ledger and on a current one gives no error and the same schema; an insert with `review = 'spec'` and no `request_id` is refused; a spec row with NULL `ticket_id` is accepted
- [ ] 1.3 Ticket `role` in `create_ticket`, `edit_ticket`, `TicketSnapshot` and read routes; allowed values are the six roles; edit rule as `request_id` in `ticket-grouping` → verify: create with `tester` stores it; `chef` gets 400 and persists nothing; an agent that is not the creator or lead cannot change it

## 2. Stage kind

- [ ] 2.1 Create `hub/kinds/stage.ts` implementing `KindModule`; add it to `KINDS` in `hub/hub.ts` → verify: `bun x tsc --noEmit` passes; the kind routes are mounted
- [ ] 2.2 Transition function: each of `queued`, `launching`, `running`, `passed`, `failed`, `retrying` writes one event and one row update in `applyWithSideEffect` → verify: integration test: one event per transition; a failing side effect leaves no event and no row change
- [ ] 2.3 `evaluateStages(ticket)` implements the ready conditions (not `draft`, `done` or `cancelled`; no open blocker; no live stage for the ticket and role; and either the role is `ticket.role` with no stage yet, or a `to_role` handoff for that role arrived after the last stage of that role) → verify: unit tests: blocked ticket creates no stage; draft creates none; done and cancelled create none; a new `tester` handoff after a passed stage creates one new stage; a `tester` handoff on a ticket with `role` `worker` creates a `tester` stage; a ticket with `role` `worker` and no handoff creates only a `worker` stage; a second call while `queued` creates none (brief tests 1 and 9 cover claim/launch)
- [ ] 2.4 Role handoffs: `POST /handoffs` takes `to_role`; exactly one of `to` and `to_role`; the evaluator runs in the same dispatch → verify: `to_role` creates a stage; both fields get 400 and nothing is written; a `to`-only handoff behaves as before (existing handoff tests pass)
- [ ] 2.5 Ticket ownership on launch: in the `launching` transaction, set `ticket.assignee` to the session name with actor `system` via `ticket.assigned`; reassign on retry; accept the actor `system` only on hub-internal paths (this launch, the retry, the spec-review PASS); the first-turn assignment wakes no one → verify: integration test: launch of `worker-1` gives assignee `worker-1` and one `ticket.assigned` event by `system`; retry gives `worker-2`; a test that walks every HTTP route of the hub with `by: "system"` gets 400 on each and writes nothing

## 3. Slots and limits

- [ ] 3.1 Room defaults for `role_limits` (worker 2, tester 2, validator 1, writer 1, editor 1, reviewer 1) and `stage_timeout_min` 30; `PUT /rooms/<room>/settings` accepts a limit from 0 to 10 → verify: a new room has the defaults; 11 gets 400
- [ ] 3.2 Queue: a full role keeps the stage `queued`; on a free slot, the oldest queued stage of that role starts; name `<role>-<n>` takes the lowest free number among live sessions in all rooms (one tmux socket); the limits stay per room → verify: brief test 2 (limit 1, second ticket waits, starts on close); name reuse after `worker-1` closes gives `worker-1`; with `worker-1` live in room A, a worker stage in room B gets `worker-2` while room B's limit counts only room B

## 4. Launch channel

- [ ] 4.1 **High blast radius.** Hub launch-request queue: `GET /launches/stream` (SSE, bearer or `?token=`), `POST /launches/<id>/ack`; requests `launch` and `close`; a launch with no ack in 15 s counts as a failed attempt → verify: integration test with a fake shell client: a launch request arrives, an ack moves the stage to `running`; no ack in 15 s moves it to `retrying`; a `POST` to every existing ticket, handoff and room route and to every chatbridge tool queues no launch unless the evaluator finds a ready stage; a `to_role` handoff on a `draft`, blocked or `done` ticket, or with the role at its limit, queues none; no route has a launch parameter; one function (for example `enqueueLaunch`) queues launches, only `evaluateStages` and the retry path call it, and a grep shows no other caller (no per-role token, see design risks)
- [ ] 4.2 **High blast radius.** Rust shell: opens the launch stream with the hub token at startup; on `launch` calls `pty_spawn` with the role, the cwd, the initial prompt and env `CUBILOT_STAGE_ID`; on `close` runs `tmux kill-session` for that name only; never kills sessions on app exit → verify: `cargo test --manifest-path src-tauri/Cargo.toml` passes; add a test for `close` naming one session; brief test 3 check: a tester launch starts in its worktree (live check in 6.5)
- [ ] 4.3 Initial prompt: render the ticket part (no role prompt) to `<app data>/sessions/<session>/first-message.md` and pass it as one quoted argument of the launch command, read through `$(cat …)` in the single `$SHELL -ic` argv element; retries add the stop reason line; untested points: pi accepts a positional prompt; the largest ticket part fits the argv limit → verify: launch command of a worker contains `--append-system-prompt-file` and the prompt argument, and no role text in the prompt; two worker launches for different tickets share the role prompt file and differ only in the ticket part; a ticket part of 100 KB launches (or the limit is recorded here); a pi launch receives the prompt (or the gap is recorded here)
- [ ] 4.4 **High blast radius.** Read-only worktrees: for Validator and Reviewer, `chmod -R a-w` on the work tree (not `.git`), and `git status` plus a read of the tree work inside it → verify: a write attempt inside the worktree fails; `git status` and `git diff` still run; record the result in this file; if git needs `.git` writes that fail, record the exception here before the change ships
- [ ] 4.5 Worktrees from the room's project folder: Worker and Writer use `ticket/<id>` (created from the room base if missing) and reuse it; other roles get `--detach` at the handoff commit; temporary worktrees are removed after pass or final fail; a room with no project folder refuses the launch with `room has no project folder`, marks the stage `failed` and counts no attempt → verify: brief test 3: a tester handoff gets a worktree detached at the named commit; a worker stage is on `ticket/<id>`; the temporary worktree is gone after pass; a room without a project folder gets the error and no session

## 5. Results, reminders, retries and close

- [ ] 5.1 Result schema check on result handoffs: `context.stage_id` and `context.ticket_id` always; `context.verdict` (`PASS` | `FAIL`) and `context.findings` for Validator and Reviewer → verify: brief test 4: an invalid verdict returns errors to the same session with `stage.rejected`, the stage stays `running`; a valid one passes
- [ ] 5.2 Turn end: the bridge core reports end of turn (`onRunEnd`, both harnesses) to `POST /stages/<CUBILOT_STAGE_ID>/turn-end`; the first end without a result sends one `stage.reminder`; a passing result writes `stage.passed`, then the hub queues `close`; transcript kept → verify: brief test 5: after pass and turn end, the session closes and the transcript is in the room history; one end without a result gets one reminder and the stage stays `running`
- [ ] 5.3 Retry: a second end of turn without a result, or a time-out, or agent gone longer than `STALE_AGENT_MS`, ends attempt 1 with `stage.retrying`; attempt 2 uses the same ticket part plus a reason note and reassigns the ticket (2.5); a second failure moves to `failed` and sends a handoff to the Orchestrator → verify: brief test 6: one relaunch on first stop; second stop sends the Orchestrator a message; a reminder followed by one more end of turn counts as a stop
- [ ] 5.4 Interrupts: an interrupt on a stage session changes nothing → verify: integration test: stage stays `running`, session stays open
- [ ] 5.5 Pane "finished" list in the UI (`ui/`, vanilla JS; no framework) → verify: a closed stage session appears in the list; the list survives a reload from the ledger

## 6. Tool limits and checks

- [ ] 6.1 Hub-launched Claude session blocks `Task` and `Agent`; `ack_permission` blocked (reuses `factory-roles` launch) → verify: brief test 7: the launch command of a hub-started `worker` contains both blocks; a live check in the app with a launched worker
- [ ] 6.2 Orchestrator and chatbridge tools cannot start a session; `factory/orchestrator/orchestrator.md` says so → verify: brief test 8: a tool list check shows no launch tool; the Orchestrator's launch attempt via any tool fails
- [ ] 6.3 Rebuild bridges and sidecars: `./scripts/build-sidecars.sh` and `./scripts/check-mod.sh` → verify: both pass
- [x] 6.4 Checks: `bun test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bun x tsc --noEmit` → verify: all pass; record the output in this file
  - Result (Tester1, run started 2026-10-23 23:14:39, after Orchestrator's git-stash notice): `bun test`: 1322 pass, 0 fail, 5872 expect() calls, 106 files, exit 0. `cargo test --manifest-path src-tauri/Cargo.toml`: 137 passed, 0 failed, 1 ignored, exit 0. `bun x tsc --noEmit`: no output, exit 0.
- [x] 6.5 Live check in the app: a Worker and a Tester stage on one ticket with a handoff; back up the ledger first; install with `./scripts/install.sh` → verify: record the result in this file
  - Partial record (Tester1, 2026-10-24, in progress). Check ticket `t_05dd39e796a34d9a` (request `r-2026-10-24-live-6.5`, role `worker`, low radius, created by Tester1).
  - Worker stage: session `worker-1` (assigned by `system`, `ticket.assigned` version 2014). Status: queued, claimed, in_progress, in_review (versions 2016 to 2018). Worktree `worktrees/cubilot/t_05dd39e796a34d9a/worker-1`, branch `ticket/t_05dd39e796a34d9a`. File `live-check-6.5.txt` holds `live check 6.5`, not committed. Launch flags (Orchestrator check): `Task`, `Agent` and `ack_permission` blocked.
  - Tester stage: session `tester-1` (assigned by `system`, `ticket.assigned` version 2023). `CUBILOT_STAGE_ID=s_a75ab85d57c0caab` (Orchestrator check). Launch flags: `Task`, `Agent` and `ack_permission` blocked (Orchestrator check). Open point: no `tester-1` worktree found under the ticket folder or in `git worktree list` at 2026-10-24 (Tester1 check). Orchestrator asked to confirm.
  - Stage statuses (Orchestrator check): worker stage `s_057d78a6727b8896` passed, verdict empty. Tester stage `s_a75ab85d57c0caab` passed, verdict empty.
  - Tester handoff: `tester-1` sent handoff `h_b94d51783efba7e1` with result FAIL. Its worktree started detached at `c9c060f`. `worker-1` had not committed `live-check-6.5.txt`, so the tester could not see it.
  - Tester handoff went to the agent `Validator`, not to the role `validator`.
  - Worktree `worktrees/cubilot/t_05dd39e796a34d9a/tester-1` was removed while session `tester-1` still ran.
  - Result: FAIL, design gap. Cause: the worktree of a Tester stage does not include the uncommitted Worker output, and the hub removed a worktree of a live session. Decision on the commit rule: human.
  - `tester-1` closed later. The hub removed it as stale after its connection dropped. No tmux session for `worker-1` or `tester-1` remains.
  - Re-run after install 14 (Tester1, 2026-10-24). Check ticket `t_f03e8bebfcffa1f3` (request `r-2026-10-24-live-6.5b`, role `worker`, low radius). Worker session `worker-1`.
    1. PASS: `worker-1` committed `live-check-6.5b.txt` on `ticket/t_f03e8bebfcffa1f3` as commit `f2b5831`. Main stayed at `c9c060f`. Nothing was pushed.
    2. PASS: the worker handoff used `to_role: tester` and named the commit `f2b5831`.
    3. PASS: the tester worktree was detached at `f2b5831` and held the check file.
    4. PASS: the tester result used `to_role: validator` with `verdict` PASS and `report` in the context.
    5. PASS: the tester stage shows verdict PASS.
    6. PASS: the tester worktree was removed after the close.
    7. Open: no stale `worker-N` or `tester-N` tab check yet. The human looks at the tab rail.
    - Validator stage `s_333fe1491432d2d6` ran in a read-only worktree. It sent FAIL: the first message had no tester verdict or report. Design gap A.
    - The new `tester-1` session saw old ticket `t_05dd39e796a34d9a` in its briefing, because the old assignee is `tester-1`. Design gap B. Orchestrator asked the human to cancel `t_05dd39e796a34d9a`. Do not change that ticket here.
  - Third run after install 15 (Tester1, 2026-10-24). Check ticket `t_22a1daded732cdc9` (request `r-2026-10-24-live-6.5c`, role `worker`, low radius).
    1. PASS: `worker-1` committed on `ticket/t_22a1daded732cdc9` as commit `776f715`. Main stayed at `c9c060f`.
    2. PASS: the tester worktree was detached at `776f715`.
    3. PASS: `tester-1` sent its result to role `validator` with verdict PASS and report (handoff `h_3325ade965df3075`). Two earlier sends got 400 for a wrong stage id. The session corrected them.
    4. PASS: the tester stage shows verdict PASS.
    5. PASS: the first message of `validator-1` has the `## Handoff` section with the tester verdict and report.
    6. PASS: `validator-1` sent PASS (handoff `h_8bc3890bfd3404c6`).
    7. FAIL: after its stage passed, `tester-1` saw the old ticket `t_05dd39e796a34d9a` in its briefing. Fix ticket `t_fbc17efda6820109` (gap B follow-up).
    8. PASS: the tester and validator worktrees were removed after the close. The worker worktree stays.
    9. Visual check not done by the human (2026-10-24). Hub data: the stage sessions opened and closed in the roster, and `t_09af79d42ef7a531` moved to done.
  - Fourth run after install 16 (Tester1, 2026-10-24). Check ticket `t_117bd2ff361dfc17` (request `r-2026-10-24-live-6.5d`, role `worker`, low radius). Reported by Orchestrator; Tester1 did not read the session output.
    1. PASS: `worker-1` committed on `ticket/t_117bd2ff361dfc17` as commit `f210e8d`. Main stayed at `c9c060f`.
    2. PASS: the tester worktree was detached at `f210e8d`.
    3. PASS with a note: `tester-1` sent its result to role `validator` with verdict PASS and report (handoff `h_64e4e0d63eba976f`). Two earlier sends used the worker's stage id from the handoff section and got 400. Fix ticket `t_585bca05171bdcd0`.
    4. PASS: the tester stage shows verdict PASS.
    5. PASS: the first message of `validator-1` has the `## Handoff` section.
    6. PASS: `validator-1` sent PASS (handoff `h_81e531823fea86a8`). No duplicate result.
    7. No symptom seen: `tester-1` and `validator-1` did not ask about the old ticket `t_05dd39e796a34d9a` after their stages passed. The briefing text was not read directly. Unit tests in `tests/unit/stage-briefing.test.ts` cover the rule.
    8. PASS: the tester and validator worktrees were removed after the close.
    9. Visual check not done by the human (2026-10-24). Hub data: the stage sessions opened and closed in the roster, and `t_09af79d42ef7a531` moved to done.
  - On 2026-10-24 the human closed the four live-check tickets: `t_05dd39e796a34d9a` cancelled, and `t_f03e8bebfcffa1f3`, `t_22a1daded732cdc9`, `t_117bd2ff361dfc17` done.
  - Fifth run on install 18 (Tester1, 2026-10-24). Check ticket `t_09af79d42ef7a531` (request `r-2026-10-24-live-6.5e`, role `worker`, low radius). Reported by Orchestrator and checked in the worktree folder; Tester1 did not read the session terminals.
    1. PASS (ledger, checked by Orchestrator): `worker-1` sent `h_ba6f17e07526fb07` with `s_a946bd4c7874af76` (worker stage). `tester-1` sent `h_071fbb5e160c191e` with `s_b0dae6d0ad5a3888` (tester stage). `validator-1` sent `h_0268a1883014c25b` with `s_d36ab2929674de48` (validator stage). Each one names its own stage. A 400 is not recorded in the ledger, so a refused attempt is not checked.
    2. PASS: `validator-1` sent PASS (handoff `h_0268a1883014c25b`, per Orchestrator). Ticket `t_09af79d42ef7a531` moved to `done` with `from="system"` (version 2304). No human action.
    3. PASS (ledger, checked by Orchestrator): each session sent exactly one handoff for this ticket. None came after Orchestrator's accept.
    4. Not verified by Tester1: the stage briefings. The sessions `worker-1`, `tester-1` and `validator-1` were offline when checked, so their terminals could not be read.
    5. PASS: the tester and validator worktrees are gone (`worktrees/cubilot/t_09af79d42ef7a531/` holds only `worker-1`). The worker worktree stays, as designed. Worker commit on `ticket/t_09af79d42ef7a531`: `59ebbae`. `main` stays at `c9c060f`.
  - Still open: point 4 of the fifth run and point 7 of the fourth run (stage session briefings: not verified; read them during 7.2 while each session is online).
  - Closed fixes: `t_585bca05171bdcd0` (stage id wording) is done. Design gaps A and B are fixed: `t_50e9d158b282e0ef`, `t_0ed6e0e890de11f8` and `t_fbc17efda6820109` are done.

## 7. Docs

- [ ] 7.1 `docs/PROTOCOL.md`: `to_role`, the `stage` kind, the launch stream, the result schema, the `system` actor on launch → verify: Writer and Reviewer pass (`[doc]` ticket)
- [ ] 7.2 `CLAUDE.md`: hard rules for launches (hub only, shell executes), stage events, read-only worktrees, the stage id env. Add this line: "A stage launch writes `stage.launching` and `ticket.assigned` in one transaction; this is the only cross-kind transaction." → verify: review; `grep -n "only cross-kind transaction" CLAUDE.md` finds the line
