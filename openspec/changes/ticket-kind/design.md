## Context

A2AChannel owns three persistent kinds — `handoff`, `interrupt`, `permission` — each a
state machine over SQLite with one event plus one derived-table update per transition, in
a single transaction. The orchestrator in `hub.ts` is kind-agnostic: adding a kind is one
file under `hub/kinds/` and one entry in the `KINDS` array, with routes dispatch,
reconnect replay and Briefing tool aggregation all flowing through the `KindModule`
contract.

Every existing kind is *addressed*: a handoff has a `to`, an interrupt has a recipient, a
permission has a voter. None models work that exists before anyone owns it. That gap is
what a Room's backlog needs, and it is why acceptance criteria and blast radius belong
here rather than bolted onto `handoff.context`.

The constraint that shapes most decisions below: the kind infrastructure is mature and
opinionated, so the right implementation is the one that adds no new mechanism.

## Goals / Non-Goals

**Goals:**
- Work has an identity, a definition of done, and a priority before it has an owner.
- High-blast-radius completion passes through a human gate, reusing `permission`.
- An agent reconnecting learns what it owns from the Briefing, not from being retold.
- Zero kind-specific branching in `hub.ts`.

**Non-Goals:**
- Not a project management tool: no epics, dependencies, estimates, burndown, or
  due dates. One flat list per Room ordered by priority.
- No automatic assignment or scheduling. A ticket is claimed by an agent or the human,
  never pushed.
- No cross-Room tickets. Rooms are the isolation boundary everywhere else and this is
  not where that changes.
- Not a CI or pipeline trigger. Build, review and deploy stay outside A2AChannel.

## Decisions

**A separate kind, not fields on `handoff`.** A handoff is a transfer between two named
parties; a ticket is unowned until claimed and outlives any single transfer. Modelling
tickets as handoff metadata would mean a handoff with `to: null`, breaking the one
invariant that makes handoff routing checkable. *Alternative considered:* extend
`handoff.context` — rejected because the migration cost lands later, exactly when there
is real data to move.

**The human approves high-radius completion through an ordinary `permission` request,
created and linked by the hub in one transaction.** `POST /tickets/:id/approval` (assignee
only, ticket `in_review`, `high` radius) runs the permission kind's create verb with a side
effect, the pattern the handoff accept already uses for the nutshell
(`applyWithSideEffect`): one transaction writes the `permission.new` event, the
`permissions` row (`tool_name: "ticket:done"`, `input_preview: {"ticket_id":"<id>"}`,
agent = the requester, room = the ticket's room, a fresh hub-minted request id) and the
ticket's `approval_request_id` pointer. The pointer is a derived link, not a ticket state
change, so it adds no ticket event — the transaction still writes exactly one event.
Binding is the pointer, never a text match. Repeats: when the pointer names a `pending`
request, the route returns it and writes nothing, so repeated attempts never add a card.
The check and the write run in one synchronous handler with no `await` between them, so
two calls cannot both create (*ceiling:* relies on the hub's single JS thread; move the
check inside the transaction if the hub ever handles requests in parallel). The `done`
decision accepts only the pointed-to row with `status = 'allowed'` and `resolved_by` equal
to `config.humanName`. An agent's Allow leaves that row terminal but unusable; the next
approval call sees no pending request and points the ticket at a fresh one, so a bad
agent vote never blocks a later human approval. The human's own `done` needs no request.
`permission.ts` gains one exported helper; its verbs and routes do not change.
*Alternatives considered:* the agent tool calling `POST /permissions` — rejected, the link
and the request would be two transactions and concurrent attempts could create duplicate
cards; an `approved_by` column on `ticket` — rejected, two kinds would own approval.
*Known limit:* verdicts are trust-on-self-assertion, like every route: a token holder can
claim `by: "human"`.

**Rework voids the approval.** The `in_review → in_progress` transition clears
`approval_request_id` in its own ticket event. A later `done` needs a fresh request and a
fresh human Allow: the human approved the work as it was, not the reworked version.

**The board shows approval state from permission events, not ticket versions.** Setting
the pointer writes no ticket event, so the ticket's version does not change and a
version-reconciling renderer would ignore it. The list route therefore returns each
ticket with its `approval` (`{ id, status, resolved_by, version }` of the pointed-to request, or
null). Live, `ui/kinds/ticket.js` also consumes `permission.*` entries whose `tool_name`
is `ticket:done`, keys them by the `ticket_id` in `input_preview`, and reconciles them by
the permission's own `(id, max version)`. A request raised by an agent's tool therefore
appears on the board exactly like one raised from the board.

**Ticket changes schedule a Briefing refresh explicitly.** The Briefing dispatcher only
re-sends on roster and presence changes; a new signature alone sends nothing.
`HubCapabilities` gains `briefing.refresh()`, which calls the dispatcher's
`scheduleFanout()` (500 ms debounce, signature dedup). The ticket kind calls it after any
committed change to `assignee` or `status`. The capability is kind-agnostic: any kind with
`briefingLines` uses it the same way.

**The accept-then-claim tool reports both outcomes.** If `accept_handoff` succeeds and
the claim fails — 409, 403, a 5xx or a transport error — the tool result states that the
handoff IS accepted and names the claim outcome (`claimed`, `already claimed by <name>`,
`ticket in another room`, or `claim failed: <reason>`). It is not reported as a tool error,
because the accept stood; the agent can retry `claim_ticket`.

**`acceptance_criteria` is required at creation, not optional.** The failure this change
exists to prevent is work completed against an assumption. An optional field would be
omitted in exactly the rushed cases where it matters most. *Alternative considered:*
required only when `blast_radius` is `high` — rejected; the EUSPACE incident that
motivates this was a low-radius document task.

**Claim is first-come, not assigned; ownership decides who moves a ticket.**
Any Room member or the human may claim a `queued` ticket; a second claim answers 409.
Only the assignee or the human moves a claimed ticket forward (`in_progress`,
`in_review`, `done`) or back for rework (`in_review → in_progress`). The assignee, the
creator or the human may cancel. The event records the actor, so a human move on an
agent's ticket is visible as `by: human`.

**Priority is a JIRA level the human sets, not a computed score.** The Prioritizer in a
factory diagram ranks by model judgement; here the human already knows the order and a
computed score would be unexplainable. The levels are JIRA's — `highest`, `high`,
`medium` (default), `low`, `lowest` — because a bare integer is ambiguous (is 1 the top or
the bottom?) and that ambiguity surfaces at assignment. The column stays an INTEGER rank
(`highest` 5 … `lowest` 1) and the table needs no migration; the hub maps names at its
boundary. A rank outside 1–5 (rows written before this change) reads as `medium` and
sorts as `medium`: ordering is by the effective rank, `CASE WHEN priority BETWEEN 1 AND 5
THEN priority ELSE 3 END DESC, created_at ASC`, in both the list and the Briefing query.

**Accepting a handoff claims the ticket — in the shared tool, not in the hub.**
Work reaches an agent through a handoff, so a separate explicit claim afterwards would be
skipped and the board would lie. After `accept_handoff` succeeds and the handoff's
`context.ticket_id` names a ticket, the tool calls `claim` for the accepter. A 409 (already
claimed) or 403 (another Room) is ignored: the accept stands. The two steps are separate
transactions, each with its one event. `hub/kinds/handoff.ts` is unchanged, and no
transaction writes two kinds. *Alternative considered:* claiming inside the accept
transaction — rejected, it writes two events in one transaction and couples handoff to
ticket.

**`external_ref` is an opaque string, not an integration.** Client work is tracked
outside A2AChannel under keys like `EUSPACE-246`, which is also the enforced commit
prefix. Carrying the key makes a thread traceable across ticket, chat and commit for the
cost of one nullable column. *Alternative considered:* syncing with the external tracker —
rejected; it buys a copy that goes stale, plus auth, rate limits and a failure mode for a
system we do not control. A2AChannel tickets are agent-coordination state at a finer
grain than the tracker's deliverables; one external item may spawn several.

**A four-column board, not six.** `cancelled` and the distinction between `claimed` and
`in_progress` do not earn standing horizontal space in a window that also holds chat and
a terminal pane. The board renders where the terminal pane sits, using the existing
terminal toggle, which is exactly when the human is reviewing progress rather than
watching an agent work. The pane holds only the columns: a `+` under each column opens
the ticket form in a modal, as in JIRA, and the saved ticket is moved into that column by
the ordinary claim and transition verbs with the human as actor. No create-at-status verb
is added to the hub, so the gate and ownership rules stay in one place. Transitions are buttons, not drag-and-drop: dragging costs hit
targets, drop zones, optimistic reordering and race handling against the hub's 409s, for
no gain over a labelled button.

**Four agent-facing tools only** — create, claim, transition, list. Each tool costs system
prompt tokens in every request for every agent, so the surface stays minimal; richer
queries belong in the webview, which pays no such cost. Tools are defined once in
`hub/channel/tools.ts` and reach both harnesses, since `pi-extension.ts` imports the same
registry.

**Broadcast scope per verb, and context delivery.** Every ticket event fans out to the
Room (`{ kind: "room", room }`); no verb uses `broadcast`. The bridge core delivers all
`ticket.*` kinds in `context` mode: a ticket event never starts a turn. Work that needs
an agent's attention reaches it as a handoff or a chat message. Pause does not filter
ticket events — pause filters chat only.

**Briefing lines come from an optional `KindModule` hook.** `briefingLines?(agent, cap):
string[]` lets a kind contribute text to the Briefing. `briefing.ts` collects the lines
from all kinds and includes them in `briefingSignature()`, so a ticket change re-sends the
Briefing; the bridge core renders them. The ticket kind returns the agent's own
non-terminal tickets, highest priority first. `pendingFor` returns nothing for tickets:
the Briefing is the only replay path, so a reconnect does not deliver the same list
twice.

## Risks / Trade-offs

- **A backlog invites process where there was none** → Keep the lifecycle to five states
  and refuse feature requests that add fields; the Non-Goals list is the defence.
- **The automatic claim surprises an agent that accepted a handoff without wanting the
  ticket** → Accepted. The handoff names the ticket explicitly, so accepting is already a
  statement of intent; and the claim is visible on the board immediately.
- **Tickets and the Nutshell overlap as "what is going on"** → Nutshell stays strategic
  and human-curated; tickets are discrete and agent-transitionable. Document the split in
  `CONTEXT.md` so the ubiquitous language does not drift.
- **Required acceptance criteria will be filled with filler under time pressure** →
  Accepted. A visible bad criterion is still better than an unstated assumption, and the
  reviewer can see it.
- **Ticket churn inflates the ledger** → Same shape as handoff events, which have not been
  a problem; revisit only if the growth of ticket rows in `events` is observed.
- **The permission gate can deadlock a ticket if the human never votes** → By design:
  permissions have no TTL, and auto-approving a high-radius change is a worse failure than
  a stalled ticket. `cancelled` remains available as the escape.

## Migration Plan

Additive only. `migrate()` creates the `tickets` table; ticket events go to the shared
`events` table. No existing table is altered and no row is rewritten. A downgrade leaves the tables present and unread rather
than corrupting state, so rollback is "revert the binary" with no data step.

`handoff.context.ticket_id` is optional, so handoffs written before this change remain
valid and nothing replays differently.

## Open Questions

- Should the board offer drag-and-drop later, once the column layout has proven itself?
- Does `in_review` need to name a reviewer, or is the reviewing handoff's `to` enough?
  Leaving it unnamed until a second kind needs it keeps the table narrow.
