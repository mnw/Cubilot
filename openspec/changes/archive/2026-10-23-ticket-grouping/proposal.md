## Why

Tickets are flat today. The Orchestrator splits one human request into 3 to 10 tasks, but the hub does not know which tasks belong together, which task must wait for another, or which tasks are still a plan. Agents can claim a task before the task it depends on is done, and a plan can start before anyone has reviewed it.

Part 4 (sessions for each ticket stage) and Part 11 (dashboard) need three things from the tickets: the request a ticket belongs to, the tickets that block it, and a status for tickets that are planned but not yet approved. This change adds them.

Brief: `factory/brief/03-ticket-grouping-checkpoints.md` (decision 2026-10-19: two levels, request and task). Related: `factory/brief/04-sessions.md` items 9 and 10 (spec review), `factory/brief/11-dashboard.md` item 2 (Requests panel).

## What Changes

- **`request_id`:** an optional label on a ticket. All tasks of one human request carry the same label. There is no request table: a request is the set of tickets with its label.
- **`blocked_by`:** an optional list of ticket ids in the same Room. A ticket cannot be claimed while a ticket in its list is not `done`. The hub refuses a list that names the ticket itself, a ticket in another Room, an unknown ticket or a cycle.
- **`draft` status:** a new first status, before `queued`. A `draft` ticket cannot be claimed and wakes no one. The human or the Room lead moves it to `queued`. When the ticket's request has a `high` blast-radius ticket, only the human moves it.
- **Tools and routes:** `create_ticket` and `edit_ticket` take `request_id` and `blocked_by`. `create_ticket` accepts `status: "draft"`. `list_tickets` filters by `request_id`. Ticket responses carry `request_id`, `blocked_by` and `open_blockers`.
- **Board:** a Draft column before Queued, a request label on each card, a blocked mark, and a request filter. The traffic light (`lightOf()`) does not change.
- **Briefing:** the agent's own tickets show their request and their open blockers.
- **Orchestrator role text:** create tickets as `draft` with `request_id` and `blocked_by`, and move them to `queued` after a spec review PASS, until Part 4 does it automatically.

Not in this change:
- The context checkpoints of Part 3 (the brief keeps them as an idea).
- Closing a request, and the bulk move of a whole request to `queued`. Part 4 adds the bulk move for the spec review PASS.
- A wake when a ticket becomes unblocked. In Part 4 the hub launches a session for each ticket stage, so no agent waits on a blocker.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `work-tickets`: request label, blockers, the `draft` status, a fifth board column and the new tool fields.
