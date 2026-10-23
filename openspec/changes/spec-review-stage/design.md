## Context

`stage-sessions` defines the `stage` kind (its table already holds request-level rows: `ticket_id`, `request_id`, `review`, `verdict`), `to_role` handoffs, `evaluateStages(ticket)`, `enqueueLaunch`, role slots, worktrees and the minimal result schema. Ticket stages are keyed by `(ticket, role)`. A spec review is keyed by the request. `ticket-grouping` defines `draft`, `request_id`, `blocked_by`, the `ticket.queued` event, and the `high` blast-radius gate for the room lead. `factory/validator/validator.md` already defines the spec verdict body: `verdict` `PASS` or `FAIL`, `findings` with `blocking` or `suggestion`, and `questions_for_human`.

**Goal:** no ticket of a request starts before the Validator passes its plan, and a high blast-radius plan waits for the human.

**Non-goals:** context pack, notes, `review.json`, moving claimed or in-progress tickets (decision 11).

## Decisions

1. **Spec review is a stage of the request.** The handoff `{to_role: "validator", request_id, review: "spec"}` creates one `stage` row with `review = 'spec'`, `request_id`, and `ticket_id = NULL`. Required context: `request_text` (string, at most 20 000 characters) and `spec_paths` (list of paths in the project folder, may be empty). Optional context: `ticket_ids` (list of ticket ids of that request; default: all `draft` tickets of the request in the room) and `commit`.
   - The hub stores the scope in `stage_scope (stage_id, ticket_id)`.
   - Every scope ticket must be `draft` and carry that `request_id`. Otherwise the hub returns 400 and records nothing.
   - A request has at most one live spec stage (`queued`, `launching` or `running`). A later spec handoff while one is live creates a `queued` stage. It keeps its own scope.

2. **Schema.** The `stage` columns (`ticket_id` nullable, `request_id`, `review`, `verdict`) and their check come from `stage-sessions` task 1.2. This change creates only `stage_scope` and an index. No rebuild.

3. **Launch rules for a spec stage.** `enqueueLaunch` (stage-sessions decision 7) checks the validator slot and the stage state. It does not check the ticket rules, because no ticket is the subject. A spec stage assigns no ticket (the ownership rule of `stage-sessions` applies to ticket stages only). Worktree: detached at `commit` or HEAD, read-only, as stage-sessions decision 8.

4. **Spec result schema.** The Validator's result handoff must contain:
   - `context.stage_id`, `context.request_id`, `context.review = "spec"`,
   - `context.verdict`: `PASS` or `FAIL` (uppercase; the same enum as `stage-sessions` uses for code reviews),
   - `context.findings`: list of `{ticket_id, severity: "blocking" | "suggestion", text}`. Every `ticket_id` must be in the stage scope,
   - `context.questions_for_human`: list of strings, may be empty,
   - `context.suggestions`: list of strings, required on PASS, may be empty.

   A failing check returns the errors to the same session (stage-sessions decision 10). The stage does not change.

5. **PASS.** One transaction:
   - `stage.passed` with `verdict = 'PASS'` (kind `stage`),
   - `ticket.queued` for each scope ticket that is still `draft` (kind `ticket`), unless the request has a non-terminal `blast_radius: high` ticket. In that case no ticket moves.
   - The actor of each `ticket.queued` is `system`, as an extension of the `stage-sessions` actor rule (decision 3). The `system` actor stays on hub-internal paths only.

   This is the second transaction that writes events of two kinds. CLAUDE.md names both (task 6.2).

   The hub moves only the scope tickets, not every draft ticket of the request. A draft ticket outside the scope stays `draft` until its own review, or until the human queues it (human decision, 2026-10-23).

6. **Waiting for approval.** A request is "waiting for approval" when a spec stage has `verdict = 'PASS'` and at least one scope ticket is still `draft`, and the request has a non-terminal `blast_radius: high` ticket. This is derived from the tables. No flag is stored.

7. **Human approval (high blast radius).** `POST /requests/<room>/<request_id>/approve` is a human-only route (the `by` field must be the human name, as for the other human-only routes). It queues every `draft` ticket of the request in the room, in one transaction, one `ticket.queued` event per ticket. The actor is the human. A non-human caller gets 403. This route is the only way to queue a high-radius request.

8. **FAIL.** The Validator sends its result handoff to the Orchestrator. The hub records `stage.passed` with `verdict = 'FAIL'` at the end of the turn, and closes the session. The hub does not relaunch and does not move tickets.
   - Open findings: the `findings` of the latest FAIL of the request.
   - Fail count: the number of spec stages with `verdict = 'FAIL'` since the last spec stage with `verdict = 'PASS'`, for the request.
   - At the second FAIL, the hub adds a `ui-only` system entry for the human that lists the open findings. The same list appears in the "Needs you" area, with the approvals (human decision, 2026-10-23).

9. **Follow-up review.** The first message of a second or later spec stage holds every FAIL finding of the request since the last PASS. `validator.md` step 8 then checks each one first.

10. **First message (spec).** Rendered from `factory/validator/first-message.md`, ticket part only, passed as the initial prompt (stage-sessions decision 9). Contents, in order: request text, scope tickets (id, title, role, criteria, `blocked_by`, `blast_radius`), spec file paths, worktree path and commit, earlier FAIL findings. The role prompt stays with `factory-roles`.

11. **Changed ticket.** A `queued` ticket whose criteria, role or `blocked_by` change moves to `draft` in the same transaction as the edit. The edit writes one `ticket.edited` event that also carries the status change to `draft`. The lead or the human makes the edit, as `ticket-grouping` already allows. The Orchestrator then sends the ticket to spec review with a handoff whose `ticket_ids` names it.
    - A `claimed`, `in_progress` or `in_review` ticket that needs a change is not moved by the hub (human decision, 2026-10-23). The Orchestrator cancels it, or creates a new `draft` ticket that replaces it.

## Risks and trade-offs

- **Two cross-kind transactions.** The stage launch (`stage-sessions`) and the PASS (decision 5) both write `stage` and `ticket` events together. CLAUDE.md names both. If a later rule forbids it, split the PASS into a stage transaction and a ticket transaction, and add a recovery step for a crash in between.
- **System actor is wider but still hub-internal.** The `system` actor writes the launch, the retry and the PASS. Every HTTP route refuses it (`stage-sessions` task 2.5 tests every route). A token holder can still reach the hub's internal paths only through the routes that call them, so the risk is the same as the accepted token risk in CLAUDE.md.
- **Derived states.** "Waiting for approval" and the fail count are derived from `stage` rows. A query that is slow on a large ledger needs the index on `(request_id, review, created_seq)`.
- **Narrowed PASS.** A ticket added after the scope was set stays `draft` and is not reviewed until the Orchestrator sends it again or the human queues it.

## Migration

- New table `stage_scope (stage_id, ticket_id, PRIMARY KEY (stage_id, ticket_id))`.
- Index `stage(request_id, review, created_seq)`.
- Both in `migrate()`, guarded. The `stage` table comes from `stage-sessions`. The snapshot rule of `stage-sessions` decision 13 applies to this migration too.

## Resolved questions

1. Claimed tickets: the hub does not move them; the Orchestrator cancels or replaces them (decision 11).
2. PASS scope: only the scope tickets move; other drafts wait for their own review or the human (decision 5).
3. Human notice: the `ui-only` entry and the "Needs you" area (decision 8).
4. Verdict case: `PASS` and `FAIL` for spec and code reviews alike; `stage-sessions` is updated to match.
