## Context

Research and reasons: `factory/brief/03-ticket-grouping-checkpoints.md`. Tickets live in `hub/kinds/ticket.ts` (a `KindModule`), the board in `ui/kinds/ticket.js`, the tools in `hub/channel/tools.ts`. Statuses today: `queued | claimed | in_progress | in_review | done | cancelled`.

**Goal:** the hub knows which tickets form one request, which tickets wait for others, and which tickets are a plan that is not yet approved.

**Non-goals:** context checkpoints, closing a request, bulk promotion of a request, a wake on unblock (see the proposal).

## Decisions

1. **`request_id` is a label, not an entity.** A `TEXT_NULL` column on `tickets`. Format `^[A-Za-z0-9._-]{1,64}$`, for example `r-2026-10-22-login`. The Orchestrator chooses it. There is no `requests` table: a request is the set of tickets with the same label in one Room. Reason: a table adds a lifecycle that no part needs yet. Part 11 counts tickets by label; Part 4 promotes by label.

2. **Blockers in their own table.** `ticket_blockers (ticket_id TEXT, blocker_id TEXT, PRIMARY KEY (ticket_id, blocker_id))`. Not a JSON column, so the claim gate and the dashboard can query it. Each change to the list is part of the `ticket.edited` (or `ticket.created`) event, also when the edit changes only the list: the row changes go through `applyWithSideEffect` (`hub/core/ledger-entity.ts`), so the event and the table update are one transaction, as `CLAUDE.md` requires.

3. **Validation of `blocked_by`.** At most 20 ids. Each id is an existing ticket in the same Room, not the ticket itself. No duplicate ids. Each id is a string. The new graph has no cycle (depth-first search over `ticket_blockers`). Any failure: HTTP 400 with the bad id, nothing persisted and no broadcast. Omitted `blocked_by` changes nothing; `null` and `[]` clear the list.

   The check runs in `decide()`, before the write transaction, in the same synchronous `dispatch()` (`hub/core/ledger-entity.ts`) with no `await` between the read and the write. This holds because the hub is the only writer of `ledger.db` and runs on one thread. A second writer process, or an `await` in `dispatch()`, voids it: then the check moves into the transaction.

4. **The claim gate.** `claimTicketVerb` refuses with HTTP 409 `blocked by <id> (<status>)` while any blocker is not `done`. A `cancelled` blocker still blocks: a cancelled dependency is a planning error, and the human or the lead removes it from the list before a claim; after a claim, only the human changes the list (decision 7). The human is not gated (the human may move any ticket), the same as for the other rules. The gate reads the blockers in `decide()`, under the same single-writer assumption as decision 3.

5. **`draft` status.** First in the lifecycle: `draft → queued → claimed → …`. Rules:
   - `create` accepts `draft`. The default stays `queued`, so existing callers do not change.
   - A `draft` ticket cannot be claimed (409). It can be assigned, for planning, but `ticket.new` and `ticket.assigned` wake no one while the ticket is `draft`, and the room lead is not woken to triage it.
   - `draft → queued`: the human, or the Room lead. The lead is refused (403 `the request holds a high blast_radius ticket: only the human may queue it`) when any non-terminal ticket with the same `request_id` has `blast_radius: high`. A ticket without `request_id` is checked alone.
   - `queued → draft`: the human or the Room lead (a planned ticket goes back to review). From later statuses only the human moves a ticket to `draft`, as for `queued` today.
   - When a `draft` ticket moves to `queued`, the ledger event is `ticket.queued` and the broadcast entry kind is `ticket.promoted` (not `ticket.update`). `hub/channel/core.ts` wakes on `ticket.promoted` as on `ticket.assigned`: the assignee once (also when the assignee is the creator), or the lead for an unassigned ticket, except when the lead made the move. An idempotent retry emits no event, so it wakes no one.

6. **Responses.** Ticket JSON gets `request_id`, `blocked_by` (array of ids) and `open_blockers` (ids whose status is not `done`). The snapshot stores `request_id`. `blocked_by` and `open_blockers` are added by the read routes and the broadcast entry from `ticket_blockers`; they are not snapshot columns. `GET /tickets` takes `request_id=<label>` and applies it in SQL, before the list limit, inside the caller's Room.

7. **Who edits.** `request_id` and `blocked_by` change through `edit_ticket`, by the human, the creator or the Room lead. Provisional: the human confirms this actor rule (lead added, assignee excluded) before 3.4 reaches `done`. The assignee does not change them: the assignee is the agent the gate holds. The existing fields keep their rule (human, creator, assignee; `blast_radius` the human only). The two fields change only while the ticket is `draft` or `queued`; after a claim, only the human changes them. A terminal ticket changes no field.

8. **Board.** A Draft column before Queued (the board has five columns, with Cancelled behind the filter as today). A card shows the request label and, with open blockers, a lock mark with the count. The ticket dialog lists the blockers with their titles and statuses, and the human can edit both fields. The board calculates open blockers from the tickets it holds, so a card and an open dialog update when a blocker changes status (to `done` or `cancelled`; both are terminal), with no extra hub broadcast. Event versions are kept: an older version is discarded. A blocker that the board does not hold (list limit, archive filter) keeps the server's `open_blockers` result for that id; absence never counts as `done`. A request filter in the Filters panel. `lightOf()` does not change (Part 14 keeps it): a draft ticket with no one on it shows green. Keep the board changes small: Part 14 redesigns the board and will restyle them.

9. **Transition tool.** `transition_ticket` offers `draft` and `queued` as targets. The hub enforces who may move (decision 5); the tool only passes the move.

## Risks and trade-offs

- A label has no owner, so two requests can reuse one label by mistake. The Orchestrator mints labels with a date and a slug. Accepted until a request entity is needed.
- The claim gate and the cycle check read `ticket_blockers` in `decide()`, outside the write transaction. No race opens while the hub is the single writer on one thread (decision 3).
- Old clients and agents that do not know `draft` still work: they never create one, and a `draft` ticket only refuses their claim with a clear message.

## Migration

`ALTER TABLE tickets ADD COLUMN request_id TEXT` and `CREATE TABLE IF NOT EXISTS ticket_blockers …` in `migrate()`, guarded like `archived_at_ms` today. Existing tickets get `request_id = NULL` and no blockers. No data changes.

## Open questions

1. Must a blocker that is `cancelled` unblock? This design says no (decision 4). The human can change this before task 2.3.
