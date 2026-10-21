## 0. Prerequisite

- [x] 0.1 Archive `chatbridge-claude-mod` (the `chatbridge-runtime` delta here depends on it) → verify: `openspec validate ticket-kind --strict`

## 1. Ledger and state machine

- [x] 1.1 Add `migrate()` in `hub/kinds/ticket.ts` creating the `tickets` table (`id`, `room`, `title`, `acceptance_criteria`, `blast_radius`, `priority`, `creator`, `assignee`, `approval_request_id`, `external_ref`, `status`, `created_at_ms`, `updated_at_ms`, `version`) — additive only; events go to the shared `events` table
- [x] 1.2 Declare the `StateMachineDecl` with statuses `queued | claimed | in_progress | in_review | done | cancelled`, terminal `{done, cancelled}`, and the moves `queued→claimed→in_progress→in_review→done`, `in_review→in_progress`, any non-terminal `→cancelled`
- [x] 1.3 `create` verb: 400 on empty `acceptance_criteria`, 403 on cross-room creation by a non-human sender, `external_ref` stored verbatim, `creator` = sender
- [x] 1.4 `claim` verb: any Room member or the human, `queued → claimed`, 409 when claimed by another actor, 403 outside the Room
- [x] 1.5 `transition` verb: assignee or human for advance and rework, assignee/creator/human for cancel (403 otherwise); same-status 200, different-status 409; the event records the actor
- [x] 1.6 Tests: one event + one `tickets` update per verb in one transaction; ownership 403s; first-claim-wins

## 2. Human approval gate

- [x] 2.1 `hub/kinds/permission.ts`: export a create helper that runs the existing create verb through `applyWithSideEffect`; no verb or route change → verify: permission tests unchanged and green
- [x] 2.2 `tickets.approval_request_id` column; `POST /tickets/:id/approval` (assignee, `in_review`, `high`): return the pending request if the pointer names one; else create a `ticket:done` request (hub-minted id) and set the pointer in the same transaction — one `permission.new` event; no `await` between check and write
- [x] 2.3a `in_review → in_progress` clears `approval_request_id` in its ticket event
- [x] 2.3 `done` decision: `low` → allowed; human actor → allowed; else the pointed-to row must be `allowed` with `resolved_by = config.humanName`, otherwise 409 with `approval_request_id`
- [x] 2.4 Tests: atomic create + pointer (one event); repeated calls return the same id and one row; agent Allow → 409 → next call makes a new request → human Allow → done; rework after a human Allow → 409 until a fresh human Allow; human direct done; low radius; `git diff --quiet hub/kinds/handoff.ts`; no kind name in `hub.ts` beyond the `KINDS` entry

## 3. Routes and registration

- [x] 3.1 Routes: create, claim, transition, approval (`auth: "mutating"`), list (`"read"`, one Room, `priority DESC, created_at_ms ASC` over the stored rank, each ticket with `approval: {id,status,resolved_by,version} | null`)
- [x] 3.2 Add the single `ticket` entry to `KINDS` in `hub/hub.ts`
- [x] 3.3 `pendingFor` returns `[]` (the Briefing carries open tickets)
- [x] 3.4 Every verb emits `{ kind: "room", room }`

## 4. Briefing hook

- [x] 4.1 Add optional `briefingLines(agent, cap): string[]` to `KindModule` in `hub/core/types.ts`
- [x] 4.1a `HubCapabilities.briefing.refresh()` → the dispatcher's `scheduleFanout()`; the ticket kind calls it after each committed `assignee`/`status` change
- [x] 4.2 `hub/core/briefing.ts`: collect the lines of all kinds into the payload; include them in `briefingSignature()`
- [x] 4.3 `hub/channel/core.ts` `renderBriefing`: render the lines
- [x] 4.4 Ticket kind: lines for the agent's own non-terminal tickets in its Room, highest priority first
- [x] 4.5 Tests: a claim re-sends the Briefing; no duplicate replay on reconnect; kinds without the hook unchanged

## 5. Bridge: delivery and tools

- [x] 5.1 `hub/channel/core.ts`: every `ticket.*` kind in `context` mode (unit test in `tests/unit/bridge-core.test.ts`)
- [x] 5.2 `hub/channel/tools.ts`: `create_ticket`, `claim_ticket`, `transition_ticket`, `list_tickets` — four only
- [x] 5.3 `transition_ticket` to `done` on a 409 approval answer: call `POST /tickets/:id/approval`, then report the request id to the agent
- [x] 5.4 `accept_handoff`: after a successful accept with `context.ticket_id`, call claim; the result states "accepted" plus the claim outcome (`claimed` / `already claimed by <name>` / `ticket in another room` / `claim failed: <reason>` for 5xx or transport errors); never a tool error once the accept succeeded — unit tests for each outcome
- [x] 5.5 Add the tool names to the kind's `toolNames`; rerun `./scripts/build-sidecars.sh` and `./scripts/check-mod.sh` (Claude mod and pi extension both read `tools.ts`)

## 6. Webview

- [x] 6.1 `ui/kinds/ticket.js` following the per-kind module pattern, reconciling by `(id, max version seen)`
- [x] 6.2 Scoped styles in `ui/styles/kinds.css`
- [x] 6.3 Four-column board — `queued`, `in progress` (`claimed` + `in_progress`), `in review`, `done` — priority-ordered, no `cancelled` column, a `+` under each column opens the ticket form in a modal and a saved ticket is moved into that column (human claims, then transitions), in the pane the terminal toggle frees
- [x] 6.4 Cards: assignee, blast radius, `external_ref`; transitions are buttons; approval state from the list route's `approval` and live `permission.*` entries with `tool_name: "ticket:done"` (`input_preview.ticket_id` is only a lookup hint; apply an entry only when its request id equals the ticket's current `approval_request_id`, reconciled by the permission's version; re-read the list route for an unknown request id) — shows requests raised by agents; unit checks: an unrelated request and a delayed event of a superseded request do not replace the current approval
- [x] 6.5 JIRA priority: `highest | high | medium | low | lowest` (default `medium`) in the API, tools, snapshots, Briefing lines and board; stored as rank 5…1; 400 for integers and other words; rank outside 1–5 reads as `medium` → verify: integration + tool + board tests, Tester1 HTTP probe on the installed build

## 7. Documentation and verification

- [x] 7.1 `docs/PROTOCOL.md`: ticket routes, lifecycle, ownership, gate, broadcast scope
- [x] 7.2 `CONTEXT.md`: the ticket-versus-Nutshell split
- [x] 7.3 `CLAUDE.md` (gitignored, local only): acceptance criteria mandatory; high radius needs the human's Allow
- [x] 7.4 Live run on an installed build with one Claude and one pi agent: create, two-agent claim race, ownership 403, high-radius block → human Allow → done, agent Allow ignored, handoff accept claims, Briefing lists owned tickets, ticket events do not wake idle agents
