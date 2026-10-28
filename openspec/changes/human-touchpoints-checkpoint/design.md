## Context

Part 6 items 11 and 7 (`factory/brief/06-warp-patterns.md`). The human decided both on 2026-10-27. The interim rule (`orchestrator.md` item 10, `unblocking.md` step 4a) applies until the arbiter is live.

Code today:
- `hub/kinds/ticket.ts`: the approve route `POST /requests/<room>/<id>/approve` queues every draft of a request (human only). The lead's `draft → queued` gets 403 when the request has an open high ticket. `done` on a high ticket needs a `ticket:done` permission that the human allowed (`approval_request_id`, `POST /tickets/:id/approval`). `closeReviewedBySystemInTx` moves a low ticket to `done` after the final PASS and gives a high ticket to the room lead. Only the human edits `blast_radius`.
- `hub/kinds/stage.ts`: `passSpecStage` queues the scope unless the request has an open high ticket (`WAITING_FOR_APPROVAL_SQL`). `specFailState` counts spec FAILs; `stampResult` writes `fail_count` into spec FAILs only. `noticeRepeatedFail` and `needsYouRequests` send the second spec FAIL to the human. No FAIL count exists for ticket reviews.
- `hub/kinds/handoff.ts`: the spec FAIL gate (t_65a8) refuses a third spec review from a non-human sender. `createSystemHandoff` exists in `hub/kinds/index.ts`.
- `hub/core/worktrees.ts`: `READ_ONLY_ROLES` = validator, reviewer. `src-tauri/src/factory.rs` has its own read-only role list.
- `hub/core/role-models.ts` reads `role_models` from `config.yml` at each launch.
- `hub/channel/core.ts` posts turn ends only for stage sessions. Kinds register in `hub/kinds/index.ts`.
- Role limits: defaults worker 2, tester 2, validator 1, writer 1, editor 1, reviewer 1. The room setting of the Validator is 2 (human, 2026-10-27).

## Goals / Non-Goals

**Goals:** the human acts at the start (one Approve) and at the delivery (test, merge or fix request). Code decides the radius, the checks of high radius, and applies arbiter rulings. The Orchestrator's context stays small through a checkpoint that code runs.

**Non-Goals:** Jev (item 7 step 8, item 6 step B). OpenAI on Pi for the second review. A Pi Orchestrator checkpoint. Items 1 to 6 and 8 to 10 of Part 6.

## Decisions

### 1. The request is a Kind: `request`
Requests are only a label on tickets today. The approval needs the features, the origin and the approved scope, so the request becomes a Kind (`hub/kinds/request.ts`, table `requests`): id, room, request_id (unique for each room), `origin` (`human` | `factory`), `features_json`, `parent_request_id`, `source` (a ticket, decision or stage id), `approved_json` (null or the scope at the newest Approve), status `open` | `approved`, version. Events: `request.created`, `request.edited`, `request.approved`.
- `POST /requests` and the `create_request` tool (room lead or human). Origin default `human`. An agent's `factory` request must name `source` in the same room (and `parent_request_id` when the source has a request). Only the human edits `origin`. Hub code creates factory requests for arbiter follow-ups. The source rule stops an agent from calling a human request `factory` without a record; `by` is still self-asserted (accepted risk, `docs/rules/permissions.md`).
- A ticket that names an unknown `request_id` gets 400. Creating the row with the ticket would be a fourth cross-kind transaction. A ticket without `request_id` is queued only by the human.
- The Approve writes `request.approved` in its own transaction before the queue transaction (no fourth cross-kind transaction). A crash between the two leaves an approval and drafts; a repeated Approve queues the drafts.
- Migration: one request (origin `human`, no features) for each `request_id` in the ledger; an Approve by `system` for each with a ticket after `draft`.

### 2. Scope change and the Approve rule, in code terms
`scopeChange(db, room, requestId)` compares `approved_json` with the ledger:
- added: a ticket of the request, not `cancelled`, not in the approved scope;
- removed: an approved ticket that is `cancelled` or has another `request_id`;
- raised: an approved ticket whose radius is now higher;
- features: the current list differs from the approved list (same strings, same order).
A criteria edit is not a scope change. It needs no new Approve. Its `ticket.edited` event holds `acceptance_criteria: {from, to}`; the delivery report shows each edit after the Approve with both texts. The arbiter sees these edits in its first message and can flag one in `meaning_changed`; only a flagged edit goes to the human (decision 9). The room lead can ask the arbiter about an edit (`question: criteria_edit`). An edit that no arbiter sees reaches the human at the delivery report.
`needsApprove(request)`: origin `human`, or origin `factory` with a high ticket that is not `cancelled` or a non-empty features list. Gate: when `needsApprove`, queue only with an Approve and no scope change. Else a spec PASS or the lead queues, as today.
Callers: `passSpecStage` and `WAITING_FOR_APPROVAL_SQL`, the lead's intake check in `transitionTicketVerb`, the Approve card, the arbiter cancel check (decision 9).
A human request with only low tickets now needs one Approve; before, it needed none. Item 11: the human approves the plan of each of their requests once.

### 3. Radius rule
`hub/core/radius-rule.ts`: `ruleRadius(text) → {radius, reasons}`. Terms match as whole words without case; paths match as substrings. Defaults (from the rule "launch, ownership, permissions, read-only worktrees, data loss"):
```yaml
radius_rule:
  terms: [launch, ownership, assignee, permission, permissions, read-only, worktree, migration, "data loss", delete, backup, restore, secret, token]
  paths: [hub/core/launch-queue.ts, src-tauri/src/launches.rs, src-tauri/src/pty.rs, hub/kinds/permission.ts, hub/core/worktrees.ts, hub/core/auth.ts, hub/core/ledger.ts, hub/core/store.ts]
```
New ticket columns `radius_rule`, `radius_reasons` (JSON), `radius_source`. A false positive costs a full suite and one more review. A false negative is the Orchestrator's to raise. A lower radius needs the arbiter (`question: radius`, ruling `waiver` with the radius in `waiver_text`).
`hub/core/config-file.ts` reads and parses `config.yml` once for each call; `role-models.ts` uses it. Every new setting of this change reads through it.

### 4. High radius: full suite, second review, done after two PASSes
- Tester: the template of a high ticket names `./scripts/test.sh`; `checkResult` requires `full_suite` on a Tester result of a high ticket.
- First Validator PASS on a high ticket: `checkResult` refuses it when the last Tester result has no `full_suite.exit_code` 0. `stage.passed` is written alone; the ticket stays `in_review`. After the commit, the hub creates a Validator stage with `review: 'second'` (own transaction). The sweep at start creates a missing one.
- The second stage launches with `second_review` of `config.yml` (default `{harness: claude, model: opus, effort: high}`) instead of `role_models.validator`. Its first message has the ticket, the diff and the criteria, not the first verdict.
- Its PASS calls `closeReviewedBySystemInTx`, which now moves a high ticket to `done` too (the existing third cross-kind transaction). The branch that gives a high ticket to the lead is removed.
- The `done` gate for agents checks for both PASSes after the last FAIL. `POST /tickets/:id/approval`, `APPROVAL_BLOCK_MESSAGE`, `retireStaleApproval` and the approval path of the `transition_ticket` tool are removed. The migration dismisses pending `ticket:done` permissions (one transaction each).
- `GET /tickets/<id>/merge-message` returns the text. The Orchestrator uses it for the merge commit. The delivery report marks a merge message without both ids.
- The Validator limit of the room is 2 (2026-10-27), so the second review runs in the second slot while another review runs. With the code default of 1, it waits for the slot.
- Main: no code change. The rule "only the human merges staging into main" stays in the role files; task 4.6 checks that no hub code writes main.

### 5. Ticket FAIL count and gate
`ticketFailState(db, ticketId)`: Validator and Reviewer stages of the ticket (review null or `second`) with verdict FAIL after the newest PASS stage. `stampResult` writes it into ticket review FAILs. `handoff.ts` refuses a role handoff to `validator`/`reviewer` at 2 or more unless the sender is the human or a grant exists (decision 8). `evaluateStages` creates no stage for a ticket with a count of 2 or more and no applied ruling, except the arbiter.

### 6. The arbiter stage
- `STAGE_ROLES` gets `arbiter`; `DEFAULT_ROLE_LIMITS.arbiter = 1`. The ticket kind refuses it as a ticket role; the handoff route refuses it as `to_role`.
- Stage rows: `role 'arbiter'`, `review 'arbiter'`, `ticket_id` or `request_id`, new column `stage.fail_count`. Unique partial index on `(COALESCE(ticket_id, 'r:' || request_id), fail_count) WHERE review = 'arbiter' AND status != 'cancelled'`.
- Starts: after the commit of the second ticket FAIL or the second spec FAIL (this replaces `noticeRepeatedFail` to the human); `POST /tickets/<id>/arbiter` by the room lead with `question` and `text` (fail_count = the current count).
- Worktree: read-only and detached, as for the Validator (`READ_ONLY_ROLES` and the `factory.rs` list get `arbiter`). For a ticket: at the head of the ticket branch. For a request: at the spec commit.
- Model: `role_models.arbiter`, default `{harness: claude, model: opus, effort: high}`. A Pi value is refused for this role (the brief says Claude).
- Role files: `factory/arbiter/arbiter.md` (read-only rules, the trust boundary of item 4, "never rule on scope or features", "cite code for an implementation detail"), `first-message.md`. `factory.rs` stages `factory/orchestrator/unblocking.md` and `factory/validator/validator.md` into the arbiter's staged folder, so that the hub reads them from the staged version.

### 7. Ruling result and application
Result schema in the spec. The hub writes `fail_count` and the target. Application, each its own transaction, in this order: `decision.recorded` → ticket note on each case ticket (`Ruling (arbiter): …`) → effect → `decision.applied` (or `decision.escalated`). At start, each `recorded` decision is finished; each step checks if its effect exists first (a note with the decision id, a handoff with `context.decision_id`, a stage with that grant).
Effects:
| Option | Ticket | Request (spec) |
|---|---|---|
| rework | system role handoff to `worker` (scope + open findings) + 1 grant | one entry to the lead with the scope + 1 grant |
| waiver | review with `waiver_text` and `waived_findings` in the first message | spec review with the waiver |
| third_review | review with the scope | spec review with the scope |
| follow_up | factory request `<request_id>-followup` (cut to 64 chars, parent and decision as source), one draft ticket, a spec review by `system`; then as waiver | same |
| cancel | system cancel (only outside the approved scope) | always escalated |
| human | open human decision | open human decision |
A waived finding is a suggestion in that review. The Validator role file says so.
Follow-up tickets go to a new request with origin `factory` on purpose: they are outside the approved scope. The Approve rule (decision 2) applies: a follow-up with only low tickets and no features is queued by its spec PASS; a high one waits for the human. The delivery report of the parent lists it.

### 8. Grants
A grant is a field of the applied decision (`grant_stage_id` null). The gate (spec or ticket) accepts a review when an applied decision of the case has `grant_stage_id` null; the stage creation sets it (`decision.grant_spent`, own transaction, after `stage.queued`). A crash between the two leaves a grant unspent; the sweep sets it from the stage's `context.decision_id`.

### 9. What escalates, in code terms
- `cancel` of a ticket in the newest approval, or of a request.
- A non-empty `meaning_changed`: the arbiter says a criteria edit after the Approve changes the meaning. The human decision shows the text before and after.
- A last FAIL with a finding `category: "security"` and option not `rework`. Validator findings get the optional `category` (`security` or absent).
- A failed arbiter stage.
- A ruling with `implementation_detail: true` is refused at the schema check, not escalated, when `code_refs` are missing or wrong; the second attempt of the stage then runs. `implementation_detail` is self-declared: code cannot find an implementation ruling by itself. This is a known limit.

### 10. `decision` Kind for the human
One Kind for rulings and human questions (`hub/kinds/decision.ts`), so that the checkpoint, the summary and the report read one table. Human decisions hold the five parts of the escalation format. `escalate` tool (room lead only) and `POST /decisions`. `POST /decisions/<id>/answer` (human only): `decision.answered`, then one entry to the lead and one ticket note (own transactions). UI: `ui/features/decisions.js` renders the Needs-you lines.

### 11. Delivery report
`hub/core/delivery-report.ts`, no stored state. Ledger reads: the request (origin, features), its tickets, the criteria edits after the Approve (`ticket.edited` payloads), its decisions, and the factory requests with `parent_request_id` = this request. Git reads in the room's project folder: `git log staging --merges --format=%H%x00%s --grep "Merge ticket/<id>"`; staging log `~/Library/Logs/Cubilot/staging-suite/<sha>.log` (bun summary lines `N pass`, `N fail`); `git merge-base --is-ancestor <sha> main` ends the Needs-you line. Test steps: the criteria of the request's ticket whose title has `[human]`. Overrule: `decision.overruled` (human only). `GET /rooms/<room>/arbiter-stats`: rulings and overrules.

### 12. Checkpoint
- Measure (`hub/core/lead-inbound.ts`): a counter in `agents.enqueueFor` for agents that are a room lead; one JSONL line for each lead each hour. This is a log, not state with a lifecycle, so it is not a Kind.
- Quick fixes: the lead's briefing signature drops stage sessions (`hub/core/briefing.ts`). The digest and the summary of result handoffs are bridge policy (`hub/channel/core.ts`; "bridge core owns policy"). Digest interval 10 minutes, a constant (`ponytail:` comment; a setting when the measure says so). Full results: new `GET /handoffs/<id>` (room-scoped read) and the `read_handoff` tool.
- Context: Claude Code plugins cannot set `statusLine`; the role settings file (`--settings`) can. `factory.rs` adds `statusLine: {type: command, command: <shared>/scripts/statusline.sh}` to each Claude role's settings. The script writes stdin to `<app data>/context/$CHATBRIDGE_AGENT.json` (atomic rename) and prints one short line. It replaces the user's own status line in factory sessions. `hub/core/context-usage.ts` reads it for `hub/features/roster.ts`.
- Summary (`hub/core/state-summary.ts`): plain text, fixed order, cut from the end of each list, a "+N more: <command>" line for each cut. Tokens = chars / 4 (no model, no tokenizer).
- Kind `checkpoint` (`hub/kinds/checkpoint.ts`): `noting → clearing → done | failed`. Turn ends of the lead come from a `Stop` hook of the Orchestrator role plugin (`factory/orchestrator/hooks/`), which posts `POST /agents/<name>/turn-end`. This needs no bridge change. The note comes from `checkpoint-note.sh` (Bash; the Orchestrator has Bash). The `SessionStart` hook, matcher `clear`, prints the summary as `additionalContext` and removes the file; the sweep sees the file gone and moves the checkpoint to `done`, with the next `context_pct` as "after".
- `/clear`: a new launch-stream request `input {session, text}`. The shell writes `text + "\r"` to the PTY master of that session only (raw PTY; no `send-keys`). This is a write into a live session: radius high, and `pty.rs` needs an integration test (CLAUDE.md).

### 13. Settings in `config.yml`
`radius_rule` (decision 3), `second_review` (decision 4), `role_models.arbiter` (decision 6), `checkpoint.context_pct` (default 60). All read through `hub/core/config-file.ts` at each use; a bad value gives the default and one log line.

### 14. Transactions
No new cross-kind transaction. The three stay: stage launch, spec PASS, final review PASS (now also for high tickets). Approval, decision, grant, note and checkpoint writes are each their own transaction, with recovery at start.

### 15. `stage-diagnosis`
That unarchived change also adds a stage role (`diagnostician`), stage review types and stage columns. Both edit `STAGE_ROLES`, the `review` union, the stage migration and `READ_ONLY_ROLES`. The change that is built second rebases. An arbiter stage gets no diagnosis (stage-diagnosis already excludes diagnosis stages; its implementer adds `arbiter` to that list).

### 16. Tickets and order
One ticket for each piece of behaviour. tasks.md group N = ticket N. `blocked_by` only for an output or a same file.
| # | Ticket | Radius | blocked_by (reason) |
|---|---|---|---|
| 1 | Human escalation (`decision` Kind) | low | — |
| 2 | Request Kind and the Approve rule | high (who may queue) | 1 (same files `hub/kinds/index.ts`, `hub/channel/tools.ts`) |
| 3 | Radius by rule | high (permissions) | 2 (same file `hub/kinds/ticket.ts`); 1 (same file `hub/channel/tools.ts`) |
| 4 | High radius checks, Allow removed | high (permissions, launch) | 3 (same files `ticket.ts`, `tools.ts`, `ui/kinds/ticket.js`; output `config-file.ts`) |
| 5 | Ticket FAIL count and gate | high (permissions) | 4 (same file `hub/kinds/stage.ts`) |
| 6 | Arbiter stage | high (launch, read-only worktree) | 5 (same files `stage.ts`, `handoff.ts`; output FAIL count); 11 (same file `src-tauri/src/factory.rs`) |
| 7 | Rulings applied | high (permissions) | 6 (same file `stage.ts`; output arbiter stage) |
| 8 | Delivery report and overrule | low | 7 (same file `hub/kinds/decision.ts`; output rulings) |
| 9 | Measure lead inbound | low | — |
| 10 | Lead briefing ignores stage sessions | low | 9 (output: the baseline measure) |
| 11 | Context percentage | low | — |
| 12 | Ticket-event digest for the lead | low | 9 (output: the baseline measure) |
| 13 | Result summary for the lead, `read_handoff` | low | 12 (same file `hub/channel/core.ts`); 7 (same file `hub/kinds/handoff.ts`); 4 (same file `tools.ts`) |
| 14 | State summary | low | 1 (output: `decision` table) |
| 15 | Checkpoint run | high (writes into a live session) | 2 (same file `index.ts`); 3 (output `config-file.ts`); 11 (output context reader); 14 (output summary) |
| 16 | Docs and role files | low | 8, 10, 13, 15 (output: the final routes, tools and rules to document) |
| 17 | [human] Live check | low | 16 (output: the installed build with the role files) |
| 18 | Closing: interim rule removed, tasks.md ticks | low | 17 (output: proof that the arbiter is live) |
Chain 1→2→3→4→5→6→7→8→16→17→18 has 10 links. Reason: tickets 2 to 8 edit the same files (`ticket.ts`, `stage.ts`, `handoff.ts`, `tools.ts`, `index.ts`). At once: 1, 9, 11 (3 tickets; 2 Worker slots).

## Risks / Trade-offs

- [The human has fewer gates] → the arbiter and code checks replace them; every ruling is a ticket note and is in the delivery report; overrules measure the arbiter.
- [A criteria edit changes the meaning and no arbiter runs on the ticket] → the delivery report shows each edit with both texts; the human sees it before the merge into main.
- [An agent marks a human request as `factory`] → the source must be a record of the room, and the human can change the origin; `by` stays self-asserted.
- [Radius false negative] → the Orchestrator raises; the delivery report lists every high change, not the low ones. Accepted.
- [`implementation_detail` is self-declared] → known limit; the Validator and the overrules show misuse.
- [`/clear` while the human types in the Orchestrator pane] → the checkpoint runs only at a turn end; the input request writes one line. Accepted.
- [The status line replaces the user's own in factory sessions] → accepted; factory sessions are app-owned.
- [The digest delays a ticket event up to 10 minutes] → decision events still come at once.
- [Legacy requests approved by the migration] → only requests already past `draft`; drafts need the human's Approve as before.

## Migration Plan

Each Kind migrates its own tables and columns (kind-runtime "Each kind owns its schema evolution"); each step takes the snapshot first and is guarded, so a second run changes nothing. The steps add: tables `requests`, `decisions`, `checkpoints`; ticket columns `radius_rule`, `radius_reasons`, `radius_source` (existing rows: `radius_rule` computed at the first edit, `radius_source` `human`); stage column `fail_count`; the arbiter unique index; legacy requests and Approves; dismissal of pending `ticket:done` permissions. Rollback: restore the snapshot; the old app reads `approval_request_id` as before.
Install after ticket 15 in one clean window (backup, no live stage). Ticket 18 removes the interim rule only after ticket 17 proves the arbiter live.

## Open Questions

None that change what is built.
