# Rules: kinds

Hub state-machine kinds, tickets, stages, launches, rooms and ledger transaction rules.

## Every structured-message state change writes exactly one event + one derived-table update in one SQLite transaction

- **Every structured-message state change writes exactly one event + one derived-table update in one SQLite transaction.** Applies to `createHandoff`, `acceptHandoff`, `declineHandoff`, `cancelHandoff`, `expireHandoff`, `createInterrupt`, `ackInterrupt`, and the nutshell-update path inside `acceptHandoff` (where the nutshell patch is applied in the SAME transaction as the handoff accept event). Never bypass.

## Cross-kind transactions

- **Cross-kind transactions.** A ticket-stage launch writes `stage.launching` and `ticket.assigned` (actor `system`) in one transaction. A spec-review launch has no ticket and writes no `ticket.assigned`. The spec-review PASS writes `stage.passed` and one `ticket.queued` for each promoted scope ticket in one transaction. The final PASS of a validator or reviewer stage writes `stage.passed` and, for an `in_review` ticket, one `ticket.done` (low radius) or one `ticket.assigned` to the room lead (high radius; the hub never writes `done` on a high ticket), both actor `system`, in one transaction. These three are the only cross-kind transactions: both kinds commit or roll back together. The human's Approve of a request (P6-02) is not a fourth: `request.approved` and its `requests` row commit in their own transaction (request kind only). The queue transaction after it writes one `ticket.queued` event for each draft ticket (ticket kind only). A crash between the two leaves an Approve and drafts, and a repeated Approve queues the drafts that are left. Do not add a fourth one without updating this line and `docs/PROTOCOL.md`.

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

## Tickets require acceptance criteria, and an agent moves a ticket to `done` only with its Validator PASSes (the human may complete it directly)

- **Tickets require acceptance criteria, and an agent moves a ticket to `done` only with its Validator PASSes (the human may complete it directly).** `hub/kinds/ticket.ts`. There is no human Allow step for `done` (P6-04): no approval route, no `ticket:done` permission. A ticket with `blast_radius: high` closes on the full suite and two Validator PASSes on one commit (L4, P6-04): the Tester result holds `full_suite {command, exit_code, pass, fail, log_path}`, the first PASS needs `exit_code` 0 on that commit, and the second PASS is a second review of that commit. `GET /tickets/<id>/merge-message` builds the merge message from the PASS handoff ids. An edit keeps the ticket status (L2): new criteria or a new radius move no ticket back to `draft` or `queued`, and the `ticket.edited` event keeps the old and new criteria text. The ticket kind's `start` dismisses a `ticket:done` permission left pending by an older hub, one transaction each. Ticket events reach agents in `context` mode and are not replayed on reconnect, except that `ticket.new`/`ticket.assigned` wake the assignee once (not the creator of its own new ticket), an unassigned ticket wakes the room lead (`GET/POST /rooms/:room/lead`) to triage it. The human may move an open ticket to any column (agents keep the fixed lifecycle); `done` and `cancelled` stay terminal; the agent's own open tickets come through the `briefingLines` hook, and every ticket change calls `cap.briefing.refresh()`.

## A `draft` ticket starts nothing, and an open blocker stops a claim

- **A `draft` ticket starts nothing, and an open blocker stops a claim.** `hub/kinds/ticket.ts`. A `draft` ticket cannot be claimed (409) and `ticket.new` / `ticket.assigned` wake no one while it is `draft`. `draft → queued` is done by the human or the room lead and writes the ledger event `ticket.queued`; the hub broadcasts `ticket.promoted`, on which the bridge wakes the assignee (or the lead for an unassigned ticket, unless the lead made the move). The lead gets 403 when a non-terminal ticket of the same `request_id` in the same Room has `blast_radius: high`, unless the human has approved the request (L1: one Approve releases every ticket of the request, also one added later); the human is never refused by the high gate; a ticket with role `writer`, `editor` or `reviewer` queues like any other (the hub starts its chain: Writer, Editor, Reviewer). A ticket with no `request_id` is checked alone. `claimTicketVerb` answers 409 `blocked by <id> (<status>)` while any `blocked_by` ticket is open (L3, `openBlockerIds` in `hub/kinds/ticket-blockers.ts`). A blocker is closed when it is `done`, or when the commit of its newest Tester PASS result is an ancestor of the `staging` branch of the room project (git runs with a fixed argument list and no shell; any git problem keeps the blocker open). A `cancelled` blocker still blocks (remove it from the list), and the human is not gated. `blocked_by` rows (`ticket_blockers`) change in the same transaction as the ticket's event; the cycle check and the claim gate read them in `decide()`, which holds only while the hub is the single writer of `ledger.db` and `dispatch()` has no `await` between read and write. `request_id` and `blocked_by` change by the human, the ticket's creator or the room lead (not the assignee), only while the ticket is `draft` or `queued`, except by the human. Like the `high` gate, the human-only parts are advisory against a token holder (see Accepted risks).

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

## Context pack and stage metrics

- **The hub builds the context pack with no model.** `hub/core/context-pack.ts` runs `graphify query`, `ctags` and `git` as argv arrays, 20 s each. It imports no model adapter and no shell string. A command that fails marks only its part `missing`; the launch continues.
- **The stable block carries no per-stage field.** `renderStable` in `hub/core/primer.ts` returns `docs/PRIMER.md` and the Nutshell only. No stage, time, session or worktree field. The ticket block follows it and nothing follows the ticket block, so two stages of one room share the same first bytes.
- **A metrics failure never changes a stage.** `hub/core/stage-metrics.ts` writes its row after the commit of `stage.passed` or `stage.failed`. A failed read or write logs one line.
- **Details:** `docs/PROTOCOL.md` sections "Context pack" and "Stage metrics".

## Requests, decisions and checkpoints are kinds

- **A request is a kind.** `hub/kinds/request.ts` (P6-02). It holds the request label with its `origin` (`human` or `factory`), its `features` (up to 50 texts), its `parent_request_id`, its `source` and the scope of the newest Approve. Status: `open` until the first Approve, then `approved`. The room lead or the human creates a request (`POST /requests`, tool `create_request`); the human alone changes the origin. A request of origin `factory` that an agent creates names a `source` (a ticket, decision or stage of this room), and a `parent_request_id` when the source belongs to a request. A request needs the human's Approve when its origin is `human`, or when it has a high ticket or a feature. Only the human approves (`POST /requests/<room>/<id>/approve`, one `request.approved` event per new scope). The scope change since the Approve (tickets added, removed or raised, features changed) is shown on the Approve card and does not hold a ticket (L1).
- **A decision is a kind.** `hub/kinds/decision.ts`. The room lead opens a human decision with the tool `escalate` (`POST /decisions`, five-part format: block, facts, options, human actions, next). The human alone answers it (`POST /decisions/<id>/answer`, event `decision.answered`). The hub gives the lead one entry with the answer and writes one note on the ticket. `GET /decisions?room=` lists the open decisions for the Needs-you list. The arbiter statuses of this kind are Part 19 and are not described here.
- **A delivery report is read, not stored.** `GET /requests/<room>/<id>/delivery` (`hub/core/delivery-report.ts`, P6-08) is built from the ledger and git on each call, with no model; the Needs-you route adds one `deliveries` line for each delivered request with a staging merge not on `main`. docs/PROTOCOL.md "The `stage` kind".
- **A checkpoint is a kind.** `hub/kinds/checkpoint.ts` (P6-15). The human starts a checkpoint for the room lead (`POST /checkpoints`). The lead writes a note with the tool `checkpoint_note` (200 words at most), the hub clears its session and gives it the state summary. Statuses: `noting`, `clearing`, `done`, `failed`. The lead's turn end also starts one by rule when it is due and the point is safe (request done, or context at `checkpoint.context_pct`). A Pi lead has no checkpoint. docs/PROTOCOL.md "Checkpoints".

## The checkpoint `/clear` goes to one named session

- **The checkpoint `/clear` goes to one named session.** The hub queues an `input {session, text}` request through `sendInput` of the stage runtime (the only owner of the launch queue). The shell writes one line to the PTY of that session only (`pty::write_input`, raw PTY). A change to that path needs `tests/integration/pty-plumbing.test.ts` "text reaches the named session and no other". The summary file is mode `0600` and the lead's `SessionStart` hook removes it. docs/PROTOCOL.md "Checkpoints".
