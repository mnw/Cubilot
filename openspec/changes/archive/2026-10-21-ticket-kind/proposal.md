## Why

Work in a Room exists only once it has been handed to someone. There is no backlog: a
Room's queue is whatever the human types next, so priority is implicit, nothing is
visible before it is assigned, and "what is left" cannot be answered without reading the
transcript. The EUSPACE migration wave showed the cost — the same findings were
re-derived independently by three agents, and an agent built a polished deliverable on
an unverified source because no definition of done travelled with the work.

A `ticket` kind gives work an identity before it has an owner. It is also the
prerequisite for two further gains: acceptance criteria that state what "done" means,
and a blast radius that decides whether a human must approve a transition. Both are
properties of a work item, not of the message that happens to carry it — putting them on
`handoff` now would mean migrating them later.

## What Changes

- New persistent state-machine kind `ticket`, following the `KindModule` contract:
  lifecycle `queued → claimed → in_progress → in_review → done`, plus `in_review →
  in_progress` (rework) and terminal `cancelled`. Every transition writes one row in the
  shared `events` ledger and one `tickets` row update in one transaction.
- Tickets carry `title`, `acceptance_criteria` (required), `blast_radius` (`low` |
  `high`), `priority` (`highest` | `high` | `medium` | `low` | `lowest`, as in JIRA), `room`, `creator`, optional `assignee` and optional
  `external_ref` (opaque).
- Ownership: any Room member or the human claims a `queued` ticket; only the assignee or
  the human advances a claimed ticket; the assignee, the creator or the human cancels.
- **A `high` blast-radius ticket reaches `done` only with the human's approval.** The
  hub route `POST /tickets/:id/approval` creates an ordinary `permission` request
  (`tool_name: "ticket:done"`) and stores its id on the ticket (`approval_request_id`) in
  ONE transaction: the `permission.new` event plus the ticket pointer, like the nutshell
  write inside a handoff accept. The route returns the pending request instead of a new
  one, so repeated attempts make no duplicate card. `done` requires that exact request to
  be `allowed` with `resolved_by` equal to the human's name; an agent's Allow does not
  count, and the next approval call replaces it with a fresh request. The human
  completing a ticket directly needs no request. `permission.ts` gains one exported
  create helper and no behaviour change.
- Ticket events reach agents as context and never start a turn.
- The Briefing gains the agent's own open tickets through a new optional `KindModule`
  hook, and the tickets are part of the Briefing signature so a change re-sends it.
- The shared `accept_handoff` tool claims the ticket named in `context.ticket_id`
  after a successful accept. `hub/kinds/handoff.ts` is unchanged.
- Webview: a Room-scoped four-column board in the terminal pane area.

## Capabilities

### New Capabilities
- `work-tickets`: ticket lifecycle, Room scoping, ownership, acceptance criteria, blast
  radius, priority ordering, the human approval gate, and the handoff claim.

### Modified Capabilities
- `kind-runtime`: kinds may add Briefing lines through an optional hook, and may read
  another kind's table, with no kind-specific branch in `hub.ts` or the Briefing code.
- `agent-onboarding`: the Briefing lists the agent's own open tickets.
- `chatbridge-runtime`: ticket events are delivered in `context` mode. This delta depends
  on `chatbridge-claude-mod`; archive that change first.

## Impact

- **New**: `hub/kinds/ticket.ts`, `ui/kinds/ticket.js`, ticket styles in
  `ui/styles/kinds.css`, a `tickets` table in `ledger.db` (events go to the shared
  `events` table).
- **Modified**: `KINDS` array in `hub/hub.ts` (one entry); `hub/core/types.ts`
  (optional `briefingLines` hook); `hub/core/briefing.ts` (collect the lines, include them
  in the signature); `hub/channel/core.ts` (render the lines; ticket kinds in context
  mode); `hub/channel/tools.ts` (four ticket tools, the approval call, the claim after
  `accept_handoff`) — shared by the Claude mod and the pi extension; `docs/PROTOCOL.md`.
- **Changed minimally**: `hub/kinds/permission.ts` exports a create helper that runs a
  side effect in the create transaction; no behaviour change.
- **Unchanged**: `hub/kinds/handoff.ts`.
- **Migration**: additive table only. A downgrade leaves it unread.
- **Cost**: four new tools add to every agent's system prompt in every request.
- **Known limit**: verdicts use trust-on-self-assertion, like every other route: a token
  holder can claim `by: "human"`.
