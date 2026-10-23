## 1. Data

- [x] 1.1 `migrate()`: add `request_id TEXT` to `tickets` and create `ticket_blockers (ticket_id, blocker_id, PRIMARY KEY)` with an index on `blocker_id`; guarded so a second run changes nothing → verify: a unit test runs `migrate()` two times on a v-current ledger and on a fresh one, with no error and the same schema
- [x] 1.2 Add `request_id` to `TicketSnapshot`, `ticketDecl.columns`, `rowToSnapshot` and the create payload; validate `^[A-Za-z0-9._-]{1,64}$` → verify: create with a valid label returns it; `"bad label!"` gets 400 and persists nothing

## 2. Blockers

- [x] 2.1 Validation helper for `blocked_by`: at most 20 ids, each an existing ticket in the same Room, not the ticket itself, no duplicate, no cycle (depth-first search over `ticket_blockers`); omitted changes nothing, `null` and `[]` clear (design decision 3) → verify: unit tests for self, unknown id, other Room, a 3-ticket cycle, 21 ids, a duplicate id and a non-string id, each 400 with the bad id in the message; tests for omitted, `null` and `[]`
- [x] 2.2 `create_ticket` and `edit_ticket` write the rows through `applyWithSideEffect`, so the event and the rows are one transaction; `edit` replaces the whole list; an edit of only the blockers emits `ticket.edited` → verify: an integration test sees one event and the rows after create, after edit, and after a blocker-only edit; a failing side effect leaves no event, keeps the old rows and sends no broadcast
- [x] 2.3 Claim gate: `claimTicketVerb` answers 409 `blocked by <id> (<status>)` while a blocker is not `done`; a `cancelled` blocker still blocks; the human is not gated → verify: integration test for blocked, blocked by a `cancelled` blocker, unblocked after the blocker is `done`, and the human's claim of a blocked ticket
- [x] 2.4 Read routes and broadcast entries add `blocked_by` and `open_blockers` → verify: `GET /tickets?room=` and the `ticket.update` entry both carry the two arrays

## 3. Draft status

- [x] 3.1 Add `draft` to the status type, `TARGET_STATUSES` and `CREATE_STATUSES`; the default at create stays `queued` → verify: create with `status: "draft"` gives a draft ticket; create without `status` gives `queued`
- [x] 3.2 A `draft` ticket cannot be claimed (409); `ticket.new` and `ticket.assigned` wake no one while the ticket is `draft`, and the room lead is not woken; `draft → queued` writes the ledger event `ticket.queued` and broadcasts `ticket.promoted`, which `hub/channel/core.ts` wakes on as on `ticket.assigned` (design decision 5) → verify: integration test with a bridge on the assignee and on the lead: no wake for a draft, one wake after the move to `queued` (also when the assignee is the creator), no wake for the lead when the lead made the move, no second wake on a retry
- [x] 3.3 `draft → queued` by the human or the room lead; the lead gets 403 when a non-terminal ticket with the same `request_id` has `blast_radius: high`; `queued → draft` by the human or the lead; from later statuses only the human → verify: integration tests for each rule, including a request with one `high` ticket where the lead is refused and the human succeeds, a `high` ticket with the same label in another Room that does not refuse the lead, and a ticket with no label that is checked alone
- [x] 3.4 `request_id` and `blocked_by` change by the human, the creator or the lead (not the assignee); only while the ticket is `draft` or `queued`, except by the human; existing fields keep their rule (design decision 7) → verify: tests for the creator, the assignee, the lead, an unrelated agent and the human; an agent's edit of a claimed ticket's `request_id` or blockers gets 409 and the human's succeeds; a terminal ticket refuses both
- [x] 3.5 `POST /tickets/:id/edit` accepts `priority` and `external_ref` (actor rule as for title) so the board can edit every draft field (human, 2026-10-23) → verify: unit tests for priority order, invalid priority 400, external_ref set and clear, 403 for another agent
- [x] 3.6 `POST /tickets/:id/attachments/:attachment_id/remove`: one `ticket.detached` event and the row delete in one transaction; the file stays on disk; the human on any open ticket, the creator or the author only in `draft` or `queued` (human, 2026-10-23: replace an attached file) → verify: tests for the transaction, actors, 404, idempotent retry and the count
- [x] 3.7 Unassign (`assignee: null`) is allowed on a `draft` ticket, as on `queued`; it wakes no one while the ticket is `draft` (Validator review of 6.7, 2026-10-23) → verify: tests for draft unassign 200, no lead wake, claimed unassign still 409

## 4. Tools

- [x] 4.1 `create_ticket`: add `request_id`, `blocked_by` and the `draft` status to the schema and the description → verify: tool tests pass the three fields to `POST /tickets` (the live check is in 8.2)
- [x] 4.2 `edit_ticket`: add `request_id` and `blocked_by` → verify: tool tests pass both fields to the edit route (the live check is in 8.2)
- [x] 4.3 `GET /tickets` and `list_tickets`: add a `request_id` filter, applied before the list limit; the tool output shows the label and the open blockers → verify: the tool returns only the tickets of one request; the same label in another Room is not returned
- [x] 4.4 Rebuild the bridges: `./scripts/build-sidecars.sh` and `./scripts/check-mod.sh` → verify: both pass
- [x] 4.5 `transition_ticket`: add `draft` and `queued` to the targets and the description (design decision 9) → verify: tool tests for both targets and for a refused actor

## 5. Briefing

- [x] 5.1 The `briefingLines` hook shows the request label and the open blockers of the agent's own tickets, and the status `draft` → verify: unit test on the hook output for a ticket with two open blockers

## 6. Board

- [ ] 6.1 Draft column before Queued; `+` in the Draft column creates a draft ticket → verify: visual check in the three themes
- [ ] 6.2 Card: request label, and a lock mark with the count of open blockers; `lightOf()` unchanged; the open-blocker count comes from the board's tickets, so it updates when a blocker changes status; a blocker the board does not hold keeps the server's result (design decision 8) → verify: visual check; the count goes down by one when a blocker moves to `done`, and does not change when a blocker moves to `cancelled` (a cancelled blocker still blocks); an older event version is discarded; a blocker absent from the board still counts as open when the server says so; `lightOf()` diff is empty
- [ ] 6.3 Ticket dialog: request label and blockers (title and status), editable by the human; an open dialog updates when a blocker changes status → verify: the human edits both fields and the card updates; an open dialog shows a blocker's new status
- [ ] 6.4 Filters panel: filter by request → verify: with two requests on the board, the filter shows one
- [ ] 6.5 Keyboard: every new control works from the keyboard, text contrast 4.5:1 or more → verify: keyboard-only walk through the dialog; measured contrast of each new text in the three themes
- [ ] 6.6 Filters request select lists only the labels of tickets the board shows (not all cancelled or archived); a stored filter on a gone label falls back to All requests (human check, 2026-10-23) → verify: unit test; human check on the next install
- [ ] 6.7 Ticket dialog (human, 2026-10-23): in a draft, edit fields replace the read-only rows in the New ticket order (title, criteria, radius, priority, assignee, external ref, request, blocked by); a queued ticket edits only request and blockers; "Attach file" under the Attachments list; one bottom row: "Cancel ticket" (danger, left, second click confirms), Close, "Save changes" (primary, disabled until a change, sends only changed fields); unsaved-changes line on Close; refused edit shown inline; New ticket dialog gets Request and Blocked by; each attachment has Replace (attach new first, then remove old) and Remove; no browser dialogs → verify: unit tests (see ticket t_04b74cd1d98b0d1e); the human creates a ticket with a request, edits a draft, saves, reopens it and sees the new values
- [ ] 6.8 A refused Save shows a red message with role="alert" under the field the hub refused (Blocked by, Request) and a red border with aria-invalid, or above the action row for other refusals; editing the field clears it; the bottom action row and the error line stay visible (sticky) when the dialog content scrolls (human, 2026-10-23: the grey "Not saved" line was missed) → verify: unit tests; browser run with screenshots in the three themes

## 7. Docs and role text

- [x] 7.1 `docs/PROTOCOL.md`: the new fields, the `draft` status and its rules, the claim gate and the 409 message → verify: the Writer and Reviewer pass (`[doc]` ticket)
- [x] 7.2 `CLAUDE.md`: one hard rule for the `draft` promotion and the blocker gate → verify: review
- [x] 7.3 `factory/orchestrator/orchestrator.md`: create tickets as `draft` with `request_id` and `blocked_by`; after a spec review PASS, move them to `queued` with `transition_ticket` (until Part 4 does it); a request with a `high` ticket goes to the human → verify: ste-lint passes; the factory map shows the change

## 8. Checks

- [ ] 8.1 `bun test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bun x tsc --noEmit` → verify: all pass
- [ ] 8.2 Live check in the app: the Orchestrator creates a request of three draft tickets with one blocker, moves them to `queued`, a Worker claims the free one and is refused on the blocked one; a Claude agent and a Pi agent each create a draft ticket with a label and one blocker, and replace the blocker list of their own draft (from 4.1, 4.2); before the install, back up the ledger and pass 8.1 and `./scripts/check-mod.sh` → verify: record the result in this file

### 8.2 live check, part 1 (2026-10-22, installed build)

- Orchestrator (room lead) created A, B, C as `draft` in request `r-2026-10-22-live`, C `blocked_by` [A] (hub HTTP as Orchestrator; the running agents had the old tool code).
- Worker1 claim of draft B: 409 (message was "ticket already draft"; changed to "ticket is draft: it cannot be claimed").
- Lead moved A, B, C to `queued`: 200 each, broadcast `ticket.promoted`; the lead was not woken by its own moves.
- `GET /tickets?request_id=r-2026-10-22-live`: only A, B, C; C has `open_blockers` [A]. Briefing line shows the label and "Blocked by: A (queued)".
- Worker1 `claim_ticket` C: `409 blocked by t_c2e994b7c6aa0b9c (queued)`. `claim_ticket` B: claimed.
- Open: a new Claude agent and a new Pi agent create a draft with a label and one blocker, and replace the blocker list (part 2).

### 8.2 live check, part 2 (2026-10-22, installed build, new agents)

- probe-claude (Claude Code, `--plugin-dir` staged mod) and probe-pi (Pi, `-e pi-extension.js`); launch flags checked with `tmux display -p '#{pane_start_command}'`.
- Each called `create_ticket` with `status: "draft"`, `request_id: "r-2026-10-22-probe"`, `blocked_by: [X]`: t_ed85dcc9c523018c (Claude) and t_7ae9f98323bfebbd (Pi), both `draft` with `open_blockers` [X].
- Each called `edit_ticket` with `blocked_by: [Y]` on its own draft: both now `blocked_by` [Y], `open_blockers` [Y].
- Each called `list_tickets` with `request_id: "r-2026-10-22-probe"`: both returned exactly the two probe drafts, each with "request r-2026-10-22-probe" and "blocked by t_40573ddea1304291". Result: PASS for Claude and Pi.
