## 1. Data

- [ ] 1.1 Create `stage_scope (stage_id, ticket_id, PRIMARY KEY (stage_id, ticket_id))` and index `stage(request_id, review, created_seq)` in `migrate()`, guarded so a second run changes nothing; no change to `stage` (it comes from `stage-sessions` 1.2) → verify: `migrate()` twice gives the same schema; `EXPLAIN QUERY PLAN` of the waiting-for-approval query uses the index; the migration runs only after a snapshot exists (`stage-sessions` 1.1)

## 2. Spec stage

- [ ] 2.1 `to_role: "validator"` with `review: "spec"` and `request_id` creates one spec stage; required `request_text` (at most 20 000 characters); optional `spec_paths`, `ticket_ids`, `commit` → verify: brief test 9 (no Worker session for a draft ticket) and a unit test: a spec handoff without `request_text` gets 400 and writes nothing
- [ ] 2.2 Scope: default is every `draft` ticket of the request in the room; a named ticket that is not `draft` or carries another request id gets 400 → verify: unit tests for default scope, a `queued` ticket in the list, and a ticket of another request
- [ ] 2.3 One live spec stage per request; a second handoff creates a `queued` stage with its own scope → verify: integration test with two handoffs for one request: one `running`, one `queued`
- [ ] 2.4 `enqueueLaunch` accepts a spec stage: validator slot only, no ticket checks, no ticket assignment, detached read-only worktree at `commit` or HEAD → verify: integration test: the validator launch names no ticket; the worktree is read-only (reuse the check of `stage-sessions` 4.4)
- [ ] 2.5 First message for a spec stage: request text, scope tickets with criteria, `blocked_by`, `blast_radius`, spec paths, worktree path and commit, earlier FAIL findings; role prompt absent → verify: brief test 12 (a second spec review gets the findings of the first); a unit test checks the rendered text has no role prompt

## 3. PASS and approval

- [ ] 3.1 Spec result schema: `review`, `request_id`, `verdict` (`PASS` | `FAIL`), `findings` (`ticket_id` in scope, `severity` `blocking` | `suggestion`, `text`), `suggestions`, `questions_for_human`; PASS with a blocking finding fails the check; the errors go back to the same session and the stage does not change → verify: unit tests for each rule; integration test: the session stays open after a schema error
- [ ] 3.2 **High blast radius.** PASS transaction: `stage.passed` with `verdict = 'PASS'` and one `ticket.queued` per scope ticket still `draft` (actor `system`); when the request has a non-terminal `high` ticket, only `stage.passed` is written → verify: brief test 10: a normal PASS moves both tickets to `queued`; a request with one `high` ticket keeps its tickets in `draft`; a draft ticket outside the scope stays `draft`; a forced failure in the middle leaves no event and no ticket change
- [ ] 3.3 **High blast radius.** `POST /requests/<room>/<request_id>/approve`: human only (403 for others); queues every `draft` ticket of the request in one transaction, one `ticket.queued` per ticket, actor human → verify: integration test: the human approves and both tickets are `queued`; a Claude agent and a Pi agent each get 403 and no ticket changes
- [ ] 3.4 Derived "waiting for approval": PASS verdict, a scope ticket still `draft`, and a non-terminal `high` ticket in the request → verify: unit test on the query for each of the three cases
- [ ] 3.5 `system` actor on the PASS path only: every HTTP route refuses `by: "system"` with 400 → verify: the route-walk test of `stage-sessions` 2.5 covers this change's routes too (the spec approve route and any new route)

## 4. FAIL and human notice

- [ ] 4.1 FAIL: `stage.passed` with `verdict = 'FAIL'`; no ticket moves; no relaunch; the Validator's result handoff goes to the Orchestrator; the session closes at turn end → verify: integration test: a FAIL moves no ticket and launches no session
- [ ] 4.2 Second FAIL since the last PASS adds a `ui-only` system entry with the open findings of the second FAIL → verify: brief test 11 (a second FAIL sends the human a message with the findings); a PASS in between resets the count
- [ ] 4.3 "Needs you" area lists the open findings of a request at a FAIL count of two or more, next to the approvals → verify: visual check in the three themes (run the board flow in Chrome before install, per the `ui-browser-check-before-install` memory)
- [ ] 4.4 Board: plan waits for your approval, with an Approve button that calls the route of 3.3 → verify: a request with a high ticket shows the waiting plan and the button; the button queues the scope tickets; an agent cannot use it

## 5. Changed tickets

- [ ] 5.1 A `queued` ticket whose criteria, role or `blocked_by` change moves to `draft` in the same transaction; one `ticket.edited` event carries the status change; `claimed`, `in_progress` and `in_review` tickets do not move → verify: integration test: queued ticket goes to `draft` with one event; claimed ticket stays `claimed`; the edit and the move are rolled back together on a forced failure
- [ ] 5.2 Spec review of a changed ticket: the handoff names it in `ticket_ids` and the scope holds only that ticket → verify: unit test: the scope of the handoff is the one ticket
- [ ] 5.3 Orchestrator text for a claimed ticket that needs a change: cancel it or create a new `draft` ticket → verify: Writer and Reviewer pass (`[doc]` ticket)

## 6. Docs and rules

- [ ] 6.1 `factory/orchestrator/orchestrator.md` step 7: the PASS moves tickets by the hub; the Orchestrator does not call `transition_ticket` for a PASS; a high-radius request waits for the human's approval → verify: Writer and Reviewer pass (`[doc]` ticket)
- [ ] 6.2 `CLAUDE.md` (with `stage-sessions` 7.2): name both cross-kind transactions in one line: the stage launch (`stage.launching` with `ticket.assigned`) and the spec PASS (`stage.passed` with `ticket.queued`) → verify: `grep -n "cross-kind transaction" CLAUDE.md` finds one line that names both
- [ ] 6.3 `docs/PROTOCOL.md`: the spec result schema, the approval route, the `system` actor on hub-internal paths → verify: Writer and Reviewer pass (`[doc]` ticket)

## 7. Checks

- [x] 7.1 `bun test`, `bun x tsc --noEmit` → verify: all pass; record the output in this file
  - Result (Tester1, 2026-10-24, ticket `t_ecff2c62a78a0b82`):
    - `bun test`: `1325 pass`, `0 fail`, `5906 expect() calls`, `Ran 1325 tests across 107 files. [86.44s]`, exit 0. Full log: `/tmp/tester1-7.1-bun-test.log`.
    - `bun x tsc --noEmit`: no output, exit 0. Log: `/tmp/tester1-7.1-tsc.log`.
- [ ] 7.2 Live check in the app: a request of two draft tickets, one `high`; the Validator sends a FAIL then a PASS; the human approves → verify: record the result in this file; back up the ledger first
  - Run record (Tester1, 2026-10-24, ticket `t_318becb4f392ed3b`, request `r-2026-10-24-live-7.2`):
    - Backup: `backups/ledger-20261024-134920-pre-7.2.db` (in `~/Library/Application Support/Cubilot/backups`), `PRAGMA integrity_check` = ok. Made before the run.
    - Install: none new. Install 18 holds the spec-review code (Orchestrator).
    - Draft tickets: `t_aac20cf214b5a6bd` (A, low, criteria with a contradiction: "The file must be empty"), `t_b68a7b110ed095f7` (B, high, clear criteria). Both draft, assignee Tester1, no role.
    - Spec review handoff: `h_d92a79d1f7f3e20a` to role `validator`, review `spec`, request `r-2026-10-24-live-7.2`, request text "Live check 7.2: two test files."
    - Validator session `validator-1` came online and listed both draft tickets (captured from its tmux pane, read-only).
    - Briefing of `validator-1`: not yet read in full. The pane scrollback showed only its tool calls. The briefing text was not visible.
    - Validator FAIL: stage `s_1e31255f8583a9a3`, handoff `h_23a14f25aec9bd3c`, verdict FAIL, accepted by Orchestrator after the session closed. Blocking findings: (a) ticket A has the planted contradiction; (b) A and B had no role, and `factory/orchestrator/orchestrator.md:24` requires role `worker` for a `[code]` ticket. Both findings correct.
    - Edits: A criteria changed to "Add live-check-7.2.txt with the line 'live check 7.2'." B criteria unchanged. Role `worker` set on A and B. Both still draft.
    - Second spec review handoff: `h_842aad6337d80931` to role `validator`, review `spec`, request `r-2026-10-24-live-7.2`. Expected PASS.
    - Briefing point: not verifiable live. A briefing arrives in context mode and is not in the terminal pane. The pi session file is not there. Covered by the unit tests of `t_fbc17efda6820109`. A spec-review session has no ticket, so it does not test this point.
    - Second review result: FAIL `h_dbe2c22990fb4166`, stage `s_309b6047e25eac78`, accepted by Orchestrator after validator-1 closed. Finding: B is high for a plain text file. Orchestrator confirmed the finding is correct and that B is high on purpose. The needs-you list showed fail_count 2. This records the repeated-FAIL path (brief test 11, task 4.2).
    - Third spec review handoff: `h_e43876c53b1f3ded` to role `validator`, review `spec`, request `r-2026-10-24-live-7.2`. request_text adds: "Ticket B is high on purpose. This live check tests the high-radius approval path (spec-review-stage tasks.md 7.2). Risks such as security, migration and accessibility do not apply to these text files." Expected PASS, both tickets draft.
    - Third review result: PASS `h_b4b702fcfe0df815`, stage `s_538417252bdbdf78`, verdict PASS, no findings, accepted by Orchestrator after validator-1 closed (Orchestrator message id=76). `h_e43876c53b1f3ded` is my third request to role `validator`; its status is `expired` (TTL 3600 s, resolved by hub at 1792846460611 ms, no decline or cancel). Orchestrator confirmed the expiry is expected.
    - First spec handoff `h_d92a79d1f7f3e20a` status is `expired` (TTL 3600 s, resolved 2026-10-24 by hub, no decline or cancel). Recorded as expired, not as a review result.
    - Second spec handoff `h_842aad6337d80931` status is `expired` (TTL 3600 s, resolved by hub, no decline or cancel). Its review result is the FAIL `h_dbe2c22990fb4166`, recorded above; the expiry does not change it.
    - Steps recorded now (7.2 paused by Orchestrator, message id=73):
      1. FAIL path: PASS. First FAIL `h_23a14f25aec9bd3c` (A contradiction, missing role on A and B). Fixed by edits.
      2. Repeated-FAIL path: PASS. Second FAIL `h_dbe2c22990fb4166`. Needs-you list showed fail_count 2 (per Orchestrator).
      3. Spec PASS with hold for a high ticket: PASS (per Orchestrator; third review, both tickets stay draft at the hold). Hub showed A and B `in_progress` after the human moved them by hand.
      4. Approval step (human Allow on B): not tested. The human moved A and B to `in_progress` by hand, so the Approve path did not run.
    - A and B not changed after the third review, per Orchestrator. Waiting for next Orchestrator message.
    - The checkbox stays open.

## Brief tests

- Test 9 (draft ticket launches no Worker): task 2.1
- Test 10 (PASS queues the tickets; high ticket keeps them draft): task 3.2
- Test 11 (second FAIL sends the human a message): task 4.2
- Test 12 (follow-up review gets the earlier findings): task 2.5
