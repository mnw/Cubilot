# Rules: kinds

Hub state-machine kinds, tickets, stages, launches, rooms and ledger transaction rules.

## Every structured-message state change writes exactly one event + one derived-table update in one SQLite transaction

- **Every structured-message state change writes exactly one event + one derived-table update in one SQLite transaction.** Applies to `createHandoff`, `acceptHandoff`, `declineHandoff`, `cancelHandoff`, `expireHandoff`, `createInterrupt`, `ackInterrupt`, and the nutshell-update path inside `acceptHandoff` (where the nutshell patch is applied in the SAME transaction as the handoff accept event). Never bypass.

## Cross-kind transactions

- **Cross-kind transactions.** A ticket-stage launch writes `stage.launching` and `ticket.assigned` (actor `system`) in one transaction. A spec-review launch has no ticket and writes no `ticket.assigned`. The spec-review PASS writes `stage.passed` and one `ticket.queued` for each promoted scope ticket in one transaction. The final PASS of a validator or reviewer stage writes `stage.passed` and, for an `in_review` ticket, one `ticket.done` (low radius) or one `ticket.assigned` to the room lead (high radius; the hub never writes `done` on a high ticket), both actor `system`, in one transaction. These three are the only cross-kind transactions: both kinds commit or roll back together. Do not add a fourth one without updating this line and `docs/PROTOCOL.md`.

## Broadcasts carry `version = events.seq`

- **Broadcasts carry `version = events.seq`.** Clients (UI + agents) reconcile by `(id, max version seen)` across both `handoff.*` and `interrupt.*` kinds. Older versions MUST be discarded.

## Terminal-state policy on handoff accept/decline/cancel and interrupt ack

- **Terminal-state policy on handoff accept/decline/cancel and interrupt ack.** Same-status-retry → idempotent 200. Different-status-retry → 409 Conflict. Uniform across all transition routes.

## `/interrupts` kind

- **`/interrupts` kind.** Lifecycle `pending → acknowledged` (terminal). No cancel, no expire. 500-char `text` cap. Not a preemption — cooperative signal only.

## All persistent state-machine kinds live in `hub/kinds/<kind>.ts` implementing the `KindModule` contract from `hub/core/types.ts`

- **All persistent state-machine kinds live in `hub/kinds/<kind>.ts` implementing the `KindModule` contract from `hub/core/types.ts`.** Adding a kind is one file under `hub/kinds/` + one entry in the `KINDS` array in `hub/hub.ts`. The orchestrator (routes dispatch, reconnect replay, briefing tool aggregation) is kind-agnostic — never add kind-specific branches to `hub.ts`. Route handlers receive a `HubCapabilities` object (DB + scoped agents + scope-typed SSE emit + auth + events + config); they never reach for module-level globals.

## Broadcasts use `cap.sse.emit(entry, scope)`

- **Broadcasts use `cap.sse.emit(entry, scope)`.** Never enumerate agent queues from inside a kind. Scope enum: `{ kind: "broadcast" }` · `{ kind: "to-agents", agents: string[] }` · `{ kind: "ui-only" }` · `{ kind: "room", room: string }`. The `emitWhere(entry, predicate)` escape hatch exists but kinds should prefer named scopes.

## Tickets require acceptance criteria, and an agent moves a `high` blast-radius ticket to `done` only after the human's Allow (the human may complete it directly)

- **Tickets require acceptance criteria, and an agent moves a `high` blast-radius ticket to `done` only after the human's Allow (the human may complete it directly).** `hub/kinds/ticket.ts`. The approval is an ordinary `permission` request (`tool_name: "ticket:done"`) created by `POST /tickets/:id/approval` together with the ticket's `approval_request_id` pointer in ONE transaction (one `permission.new` event; the pointer is a derived link, not a ticket event). The gate accepts only the pointed-to request with `status = 'allowed'` AND `resolved_by` = the human name — an agent's Allow never opens it. Rework (`in_review → in_progress`) clears the pointer. Ticket events reach agents in `context` mode and are not replayed on reconnect, except that `ticket.new`/`ticket.assigned` wake the assignee once (not the creator of its own new ticket), an unassigned ticket wakes the room lead (`GET/POST /rooms/:room/lead`) to triage it, and the human's answer on a `ticket:done` approval wakes the requester. The human may move an open ticket to any column (agents keep the fixed lifecycle); `done` and `cancelled` stay terminal; the agent's own open tickets come through the `briefingLines` hook, and every ticket change calls `cap.briefing.refresh()`.

## A `draft` ticket starts nothing, and an open blocker stops a claim

- **A `draft` ticket starts nothing, and an open blocker stops a claim.** `hub/kinds/ticket.ts`. A `draft` ticket cannot be claimed (409) and `ticket.new` / `ticket.assigned` wake no one while it is `draft`. `draft → queued` is done by the human or the room lead and writes the ledger event `ticket.queued`; the hub broadcasts `ticket.promoted`, on which the bridge wakes the assignee (or the lead for an unassigned ticket, unless the lead made the move). The lead gets 403 when a non-terminal ticket of the same `request_id` in the same Room has `blast_radius: high`; the human is never refused by the high gate; the role gate refuses every actor: a move into `queued` of a ticket with role `writer`, `editor` or `reviewer` is 409 `role <role> has no hub stage chain: ticket <id> cannot enter queued`, a create as `queued` is 409 `role <role> has no hub stage chain: create the ticket as draft`, and a spec PASS or an approval leaves such a draft ticket `draft` (`not_queued`). The list is `NO_CHAIN_ROLES` in `hub/kinds/ticket.ts`. Ticket `t_922581db0beb6fe4` removes the gate. A ticket with no `request_id` is checked alone. `claimTicketVerb` answers 409 `blocked by <id> (<status>)` while any `blocked_by` ticket is not `done`; a `cancelled` blocker still blocks (remove it from the list), and the human is not gated. `blocked_by` rows (`ticket_blockers`) change in the same transaction as the ticket's event; the cycle check and the claim gate read them in `decide()`, which holds only while the hub is the single writer of `ledger.db` and `dispatch()` has no `await` between read and write. `request_id` and `blocked_by` change by the human, the ticket's creator or the room lead (not the assignee), only while the ticket is `draft` or `queued`, except by the human. Like the `high` gate, the human-only parts are advisory against a token holder (see Accepted risks).

## The hub decides launches. The Rust shell only executes them

- **The hub decides launches. The Rust shell only executes them.** The hub never starts or stops an agent session. (It runs `git` subprocesses for the worktrees.) It queues `launch` and `close` requests on `GET /launches/stream`. `src-tauri/src/launches.rs` reads the stream, calls `pty_spawn` or `close_session`, and answers each request on `POST /launches/<id>/ack`. The shell decides nothing and never runs git. The hub creates the worktree before it queues the launch. One function queues launches: `enqueueLaunch` in `hub/kinds/stage.ts`. Only the stage evaluator and the retry path call it. Only `hub/kinds/stage.ts` may import `hub/core/launch-queue.ts`. `tests/unit/launch-queue.test.ts` checks both. No route and no chatbridge tool has a launch parameter. A close kills only the named session. The shell never kills sessions on app exit. Any `hub.token` holder can read the launch stream and send acks, because there is no per-role token. The code path is the only control (see Accepted risks).

## Stage state changes go through the stage API only

- **Stage state changes go through the stage API only.** `hub/kinds/stage.ts` (`createStageApi`) writes each move as one `stage.<status>` event and one `stage` row update, with actor `system`. The statuses are `queued`, `launching`, `running`, `retrying`, `passed` and `failed`. A stage has at most two attempts. No endpoint directly accepts a stage-create or arbitrary-transition command. A `to_role` handoff can create a stage through the evaluator. Some routes cause fixed moves from their input. The launch ack moves `launching` to `running`, or ends the attempt on an error. The turn-end report can stop a `running` stage (to `retrying` or `failed`). A valid result handoff moves `running` to `passed`. Stage events go to the UI only (`ui-only-ambient`). `stage.reminder` and `stage.rejected` go to the stage's own session. The launch queue, the end-of-turn counts and the time-out clocks are in memory. At hub start, each stage that is still `launching` counts as a launch with no ack.

## `system` is the hub's own actor, never a caller's

- **`system` is the hub's own actor, never a caller's.** It is in `RESERVED_NAMES`. `hub/core/dispatcher.ts` examines the JSON body of every mutating request. It returns 400 when `by`, `from`, `actor`, `voter`, `requester`, `agent` or `creator` is `system`. Hub code writes `system` for stage moves, the launch assignment, the spec-review PASS, the final-failure handoff to the room lead, and handoff expiry. The bridge delivers a `ticket.assigned` from `system` in `context` mode. Thus its own assignment does not wake the launched session.

## Validator and Reviewer stage worktrees are read-only

- **Validator and Reviewer stage worktrees are read-only.** `hub/core/worktrees.ts` creates them detached. It runs `chmod -N` and `chmod a-w` on the work tree, but not on the root `.git` entry or on symlinks. Then it checks every entry with `access(W_OK)`. If one entry is still writable, it refuses the launch. The roles also block `Edit`, `Write` and `NotebookEdit` (`disallowedTools` in `factory/<role>/<role>.md`). It is not checked whether a pi session (the Validator's harness) applies `disallowedTools`. Worker and Writer stages use the worktree of the `ticket/<id>` branch. The other roles get a temporary detached worktree. The hub removes it when the stage ends.

## `CUBILOT_STAGE_ID` marks a hub-launched session

- **`CUBILOT_STAGE_ID` marks a hub-launched session.** The hub puts the stage id in the launch request. `pty.rs` passes it as `-e CUBILOT_STAGE_ID=<id>` on `tmux new-session`, only for a stage launch. The bridge reads it through `Host.stageId()`. It reports each end of turn to `POST /stages/<id>/turn-end`. A session without the variable is an ordinary agent and reports nothing. Do not set it by hand on a normal spawn.

## Nutshell is not a kind — it's a document

- **Nutshell is not a kind — it's a document.** Single-row (per room); no lifecycle; no broadcast fan-out to both parties. Lives standalone in `hub/nutshell.ts`. Its write path piggybacks on the handoff primitive (task prefix `[nutshell]`, `context.patch` carries the new text) — that coupling is why `hub/kinds/handoff.ts` imports from `hub/nutshell.ts`.

## Rooms are immutable per agent

- **Rooms are immutable per agent.** Captured on the first `/agent-stream` connect via `&room=<label>` (from the `CHATBRIDGE_ROOM` env the bridge was launched with). Subsequent reconnects ignore the arg. To change an agent's room, kill the agent and respawn. The human has `room = null` — super-user, implicitly in every room. Never add a route that mutates an existing agent's room mid-session.

## Cross-room mutations are 403 for non-human senders

- **Cross-room mutations are 403 for non-human senders.** `POST /handoffs`, `POST /interrupts` (single + bulk), and `POST /permissions/:id/verdict` all reject cross-room sends unless the sender/voter is the human. Bulk interrupt (`{ rooms: [...] }`) is human-only by rule — agents bulk-targeting other rooms would be a denial-of-attention vector. Never relax these without also deciding what abuse looks like.

## `target: "all"` from the human requires a `room` body field

- **`target: "all"` from the human requires a `room` body field.** The hub returns 400 `"room required for broadcast to 'all'"` otherwise. "All" is ambiguous across projects, and silently interpreting it as "every room" is worse than forcing the caller to be explicit. The webview composer passes the currently-selected room automatically.

## Nutshell is per-room, not single-row

- **Nutshell is per-room, not single-row.** The `nutshell` table has `room TEXT PRIMARY KEY`. Edits flow through the handoff primitive as before, with an added `context.room` field that the accept path respects. The human can patch any room; non-human senders can only patch their own. `GET /nutshell?room=<label>` is required — no-arg returns 400. Agents receive the same-room nutshell on connect via briefing AND live via `nutshell.updated` fan-out to same-room queues.
