# Part 11: progress dashboard

## Goal

The ticket board shows where each ticket is now. The dashboard answers four other questions for one room:
1. What waits for the human?
2. What is stuck?
3. How fast does work move, and how good is it?
4. What does it cost?

Build Part 11 after Parts 1, 2 and 7. It only reads data that the factory makes.

## Data that exists

| Data | Where |
|---|---|
| Ticket moves with time and actor | `events` table (`hub/core/ledger.ts:67`, `insertEvent` in `hub/core/events.ts:12`). For a ticket, `entity_id` is the ticket id. Kinds: `ticket.created`, `ticket.claimed`, `ticket.in_progress`, `ticket.in_review`, `ticket.done`, `ticket.cancelled`, `ticket.assigned`, `ticket.archived`, `ticket.noted`, `ticket.attached` (`hub/kinds/ticket.ts`). |
| Room lead changes | `events` with `entity_id` `room:<room>`, kind `ticket.lead` |
| Handoffs | `handoffs` table (`hub/core/ledger.ts:78`): status, sender, receiver, times |
| Interrupts | `interrupts` table (`hub/core/ledger.ts:112`) |
| Permissions and ticket approvals | `permissions` table (`hub/core/ledger.ts:162`). A ticket approval is a permission with tool `ticket:done`. |
| Agents | Roster: online state, room, paused state |
| Claude plan usage | `/usage` (`hub/features/usage.ts`), shown in the header pill (`ui/features/usage.js`) |
| Pi cost | Pi session files. Each assistant `message` entry and each `usage` entry has `usage.cost.total` (Pi `docs/session-format.md`). With Part 7, the files are in `<app data>/pi-agent/sessions/`. |

## Data that is missing

1. **Structured verdicts.** Verdicts travel as handoffs with free text (Part 2, open item 1). The dashboard cannot count FAIL and CHANGES loops from text in a reliable way. Add the `review` kind first: `ticket_id`, `reviewer`, `verdict` (`pass | fail | approve | changes`), `findings` (count of blocking and suggestion), and, for code, `mutation_score`.
2. **Ticket groups.** A ticket has no parent. Add an optional `request_id` to tickets. The Orchestrator sets the same `request_id` on all tickets of one human request. Do not use `external_ref` for this: it holds the key of an outside tracker.
3. **Graph freshness.** Part 7 records the commit of each graph build. Expose it through the hub, so the dashboard can show it.

## Panels

| Panel | Content | Source |
|---|---|---|
| Waiting for you | Ticket approvals, pending permissions, handoffs to the human, interrupts to the human. Oldest first, with the wait time. | `permissions`, `handoffs`, `interrupts` |
| Stuck | A ticket with no event for N minutes. A handoff pending for N minutes. An agent that is offline or paused while it holds a ticket. N is a room setting, default 30. | `events`, `handoffs`, roster |
| Requests | For each `request_id`: tickets done of total, open blockers | `request_id` (missing item 2) |
| Flow | Tickets done each day. Time from `ticket.claimed` to `ticket.done` (median and slowest). Time in each column. Tickets in progress for each agent. | `events` |
| Quality | First-time PASS rate. FAIL and CHANGES loops for each ticket. Mutation score for each code ticket. Tickets over the two-loop limit (README ground rule 9). | `review` kind (missing item 1) |
| Agents | Role, harness and model, current ticket, busy or idle, paused | Roster, tickets, role data from Part 2 |
| Cost | Claude plan usage. Pi cost for each Pi agent and for the room, today and in total. | `/usage`, Pi session files |
| Graphs | For each worktree: current, or N commits behind | Part 7 (missing item 3) |

## Design

1. **Hub feature.** Add `hub/features/dashboard.ts` with `GET /rooms/:room/dashboard`. It computes all panels with SQL on the ledger, plus the roster and the Pi session files. It writes nothing. Room scoping follows the existing rules: an agent sees only its own room, the human sees all rooms.
2. **Live updates.** The UI subscribes to the event stream that the board uses. On a `ticket.*`, `handoff.*`, `interrupt.*`, `permission.*` or `review.*` event for the room, it reads the dashboard again. Limit this to one read each 2 seconds.
3. **Pi cost.** Read the Pi session files in the background, and keep the totals in memory with the read position of each file. Do not read each file again in full for each request.
4. **UI.** Add a "Dashboard" tab beside the ticket board in the right pane (`ui/index.html`, near `ticket-board-columns`). Use the existing tokens in `ui/styles/tokens.css`. A click on an item in "Waiting for you" or "Stuck" opens that ticket, handoff or agent tab.
5. **Agents do not need the dashboard.** Do not add a tool for it. The Orchestrator already has the triage list in its Briefing.
6. **Orchestrator summary (optional).** Add the "Waiting for you" and "Stuck" content to the Orchestrator's Briefing lines. The Orchestrator can then act on stalls (role file, step 8).

## Order of work

1. The `review` kind (`add-kind` skill), and the Validator and the Reviewer use it for their verdicts.
2. `request_id` on tickets, and the Orchestrator sets it.
3. The dashboard feature and tab, with "Waiting for you" and "Stuck" first. These two need no new data.
4. Flow, Quality, Requests, Agents, Cost and Graphs.

## Tests

1. "Waiting for you" lists a pending ticket approval and removes it when the human allows it.
2. A ticket with no event for longer than the limit shows in "Stuck". A new event removes it.
3. Flow: for a ticket claimed at time T1 and done at time T2, the cycle time is T2 minus T1.
4. Quality: a ticket with two `fail` verdicts and one `pass` shows two loops.
5. An agent cannot read the dashboard of another room (HTTP 403). The human can.
6. Pi cost: the total for an agent is the sum of `usage.cost.total` in its session files. A new line in a file updates the total without a full read.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
