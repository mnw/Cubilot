# Cubilot Protocol Reference

The Cubilot hub speaks two kinds of message. Free-text chat goes through
the `post` tool and the `/post` + `/send` HTTP routes — it has no persistent
state beyond the in-memory chat log. **Typed protocol messages** have a
`kind`, a typed payload, a lifecycle, and persist in a SQLite ledger so
in-flight work survives app restarts.

Today's structured kinds: **`handoff`** (typed work transfer with an explicit
state machine), **`interrupt`** (high-visibility attention flag), **`permission`**
(Claude Code tool-use approval relay, v0.8+), **`ticket`** (room work items)
and **`stage`** (one hub-started session per role and ticket). **`nutshell`** is a single-row
per-room living project summary — not a kind (no lifecycle) but uses the
same event ledger for audit. Additional kinds can be added without schema
migration; every kind writes to the same `events` table and keeps its derived
state in a kind-specific projection.

## Kind runtime (v0.9.5+)

Every state-machine kind implements the `KindModule` contract from
`hub/core/types.ts`:

```ts
type KindModule = {
  kind: string;                                                // "handoff", "interrupt", "permission"
  migrate(db: Database): void;                                 // idempotent schema migration
  routes: RouteDef[];                                          // static HTTP route declarations
  pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[];  // reconnect replay
  toolNames: string[];                                         // briefing aggregates these
  priority?: number;                                           // optional replay-ordering hint
};
```

The hub orchestrator (`hub/hub.ts`) is kind-agnostic. At startup it iterates
the `KINDS` array, calls `migrate(db)` on each, precompiles their `routes[]`
into a dispatch table, and on agent reconnect gathers `pendingFor(agent, cap)`
from every kind to replay. Briefing tool list is aggregated from each kind's
`toolNames`.

Route handlers receive `HubCapabilities` — the sole access path for DB, scoped
agent accessors, SSE emit with typed `Scope` (`broadcast | to-agents | ui-only
| room`), auth helpers, and event-log insert. Kinds never touch hub-level
globals; the orchestrator owns the state.

Adding a kind: drop a file at `hub/kinds/<kind>.ts` implementing the contract,
add it to the `KINDS` array in `hub/hub.ts`. That's it. No other edits required.

---

## The `handoff` kind

### Lifecycle

```
               ┌──► accepted     (terminal)
pending ───────┼──► declined     (terminal)
               ├──► cancelled    (terminal)  — sender or human initiates
               └──► expired      (terminal)  — background sweep
```

- `pending` is the only non-terminal state.
- `accepted` / `declined` / `cancelled` / `expired` are terminal — the
  handoff will never transition again.
- The expiry sweep runs every **5 seconds**, so TTL precision is ±5 s.
- A handoff created with `ttl_seconds=3600` (the default) will therefore
  expire between 3600 s and 3605 s after creation.

### Snapshot schema

Every broadcast, list result, and idempotent/conflict response includes a
`HandoffSnapshot`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Format `h_[0-9a-f]{16}`, minted server-side. |
| `from_agent` | `string` | Validated against agent-name regex; trust-on-self-assertion (see below). |
| `to_agent` | `string` | Same constraints. |
| `task` | `string` | Required; ≤ 500 chars. |
| `context` | any JSON | Optional; serialized form ≤ 1 MiB. Hub stores as JSON text. |
| `status` | `"pending" \| "accepted" \| "declined" \| "cancelled" \| "expired"` | |
| `decline_reason` | `string \| null` | Set when `status="declined"`. |
| `comment` | `string \| null` | Optional accept-time note. |
| `cancel_reason` | `string \| null` | Optional cancel-time note. |
| `cancelled_by` | `string \| null` | Who issued the cancel (sender or human). |
| `created_at_ms` | `number` | `Date.now()` at creation. |
| `expires_at_ms` | `number` | `created_at_ms + ttl_seconds*1000`. |
| `resolved_at_ms` | `number \| null` | Set on transition to any terminal state. |
| `version` | `number` | Monotonic `events.seq` of the last event touching this handoff. Clients reconcile by `(id, max version seen)` — see SSE events below. |

### TTL bounds

| Bound | Value |
|---|---|
| Minimum `ttl_seconds` | 1 |
| Maximum `ttl_seconds` | 86 400 (24 hours) |
| Default `ttl_seconds` | 3 600 (1 hour) |

Out-of-range values return HTTP 400.

### Terminal-state policy

Uniform across `accept`, `decline`, `cancel`:

| Condition | Response |
|---|---|
| Handoff doesn't exist | `404 {"error": "not found"}` |
| Caller isn't the expected actor | `403 {"error": "not the recipient"}` (accept/decline) or `403 {"error": "not the sender"}` (cancel) |
| Same-status retry (e.g. accept an already-accepted handoff, by the right actor) | `200 {"snapshot": ..., "idempotent": true}` — **no new event written, no new broadcast** |
| Different-status retry (e.g. accept an already-declined handoff) | `409 {"error": "handoff already <status>", "snapshot": ...}` |
| Valid transition | `200 {"snapshot": ...}` + broadcast `handoff.update` |

Creation (`POST /handoffs`) always returns `201 {"id": "h_..."}` on success;
there is no creation-side idempotency because `id` is server-minted.

---

## MCP tools

All tools are exposed by the channel-mode `cubilot-bin` sidecar. Every tool call
becomes an authenticated POST to the hub; the sidecar attaches
`Authorization: Bearer <hub.token>` and retries once on HTTP 401 after
re-reading the token file (to handle app-restart rotations transparently).

### `send_handoff`

Transfer a bounded unit of work to another participant, or to a stage role.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `to` | `string` | one of `to`, `to_role` | Recipient name (agent or the human's configured name). |
| `to_role` | `string` | one of `to`, `to_role` | A stage role. Needs `context.ticket_id`. See [role handoffs](#role-handoffs-to_role). |
| `task` | `string` | yes | 1–500 chars. |
| `context` | `object` | no | Arbitrary JSON; ≤ 1 MiB serialized. |
| `ttl_seconds` | `integer` | no | 1–86 400; default 3 600. |

Returns `handoff_id=h_...` on success. Raises with the hub's error message on
4xx/5xx.

### `accept_handoff`

Confirm you've taken a pending handoff addressed to you.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handoff_id` | `string` | yes | Format `h_[0-9a-f]{16}`. |
| `comment` | `string` | no | ≤ 500 chars; delivered to the sender in the updated snapshot. |

The hub verifies `by == to_agent`. Calling on a non-pending handoff returns
409 (different status) or 200 idempotent (already accepted by you).

### `decline_handoff`

Refuse a pending handoff addressed to you. A reason is required so the
sender can re-route.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handoff_id` | `string` | yes | |
| `reason` | `string` | yes | 1–500 chars. |

### `cancel_handoff`

Withdraw a pending handoff you created. The human may cancel any pending
handoff regardless of sender.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handoff_id` | `string` | yes | |
| `reason` | `string` | no | ≤ 500 chars. |

The hub verifies `by == from_agent` OR `by == human_name`.

### `post`

Free-text chat. Not a structured kind — no ledger entry, no state machine,
just a broadcast through the hub. Included here for completeness.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `text` | `string` | yes | Message body. |
| `to` | `string` | yes | `"you"` (human), an agent name, or `"all"`. |

### `post_file`

Upload a file from the agent's local filesystem and post it as an
attachment. Symmetric with human-driven uploads — same on-disk path,
same CSP, same allowlist.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | `string` | yes | Absolute path on the agent's filesystem. |
| `to` | `string` | no | Recipient name. Defaults to `"all"`. |
| `caption` | `string` | no | Optional text body. |

Behavior: reads the file, multipart-POSTs to `/upload`, then calls `/post`
with `image = <returned URL>`. Peers receive `[attachment: <abs path>]` in
their channel notifications — same convention as human uploads.

The tool's return value is the **absolute filesystem path** (same path the
recipient sees via `[attachment: ]`). The hub's `/upload` route also
returns a `path` field alongside the `url` field; callers composing a
subsequent `send_handoff.context` should reference the fs path, not the
`/image/<id>.<ext>` URL (the URL is for the UI viewer only).

Constraints (enforced hub-side):
- Filename extension must be in `config.json::attachment_extensions`
  (default: `jpg`, `jpeg`, `png`, `pdf`, `md`, `txt`).
- Max 8 MiB per upload.
- The hub does not trust the browser/agent-reported MIME; extension is the
  only gate. CSP + `nosniff` on the serve route prevent execution.

### `send_interrupt` / `ack_interrupt`

See [the interrupt kind](#the-interrupt-kind) above for schema and lifecycle.

---

## HTTP endpoints

All routes are under `http://127.0.0.1:<hub-port>` (dynamic; see
`~/Library/Application Support/Cubilot/hub.url`).

| Method | Path | Auth | Body cap | Purpose |
|---|---|---|---|---|
| POST | `/handoffs` | Bearer header | 1 MiB | Create. Returns `201 {"id": "h_..."}` + broadcasts `handoff.new`. |
| POST | `/handoffs/{id}/accept` | Bearer header | 256 KiB | Recipient accepts. |
| POST | `/handoffs/{id}/decline` | Bearer header | 256 KiB | Recipient declines with `reason`. |
| POST | `/handoffs/{id}/cancel` | Bearer header | 256 KiB | Sender (or human) cancels. |
| GET | `/handoffs?status=&for=&limit=` | Bearer header OR `?token=` query | — | List snapshots. Filters: `status` (default `pending`; `all` returns any), `for` (agent name; matches as sender or recipient), `limit` (1–1000, default 100). |

### Create request body

```json
{
  "from": "alice",
  "to": "bob",
  "task": "Migrate logging to structured JSON",
  "context": { "pr": "#42", "files": ["src/log.ts"] },
  "ttl_seconds": 3600
}
```

### Transition request body (accept / decline / cancel)

```json
{ "by": "bob", "comment": "on it" }
{ "by": "bob", "reason": "out of scope for my role" }
{ "by": "alice", "reason": "superseded by h_..." }
```

`by` is the actor's name. It is validated against the route's expected
actor (recipient for accept/decline, sender-or-human for cancel) but NOT
cryptographically tied to the token — any token-holder can claim any name
(see trust model below).

---

## SSE events

Handoff state changes are broadcast on two streams:

- `/stream` — UI consumer. Every handoff event goes to every connected UI
  subscriber alongside chat entries.
- `/agent-stream?agent=<name>` — per-agent stream. On create, the recipient
  gets a `handoff.new`. On any transition, both sender and recipient get a
  `handoff.update`. On reconnect, every pending handoff involving the agent
  replays with `replay=true`.
  `POST /post` does not register agents: an unknown sender gets 409 `connect /agent-stream first`, because the agent's room is fixed by its first stream. `POST /remove` ends the removed agent's live stream, so its bridge reconnects at once and registers anew; a stream's cleanup only counts against the agent it registered with. An agent has one live `/agent-stream`: a new connection for the same agent ends the older one (an event that had reached the old stream's reader but was not yet sent goes back to the front of the queue at the moment of the takeover, so the new stream gets the events in their original order)
  (the agent stays online through the new one), so no event goes to a bridge connection that is
  already gone. A bridge whose stream is ended reconnects after its retry delay, so two live bridges
  for one agent name would take the stream from each other in turn.

Event shape (on both streams — the SSE frame is one JSON object):

```json
{
  "kind": "handoff.new",
  "handoff_id": "h_0123456789abcdef",
  "version": 42,
  "expires_at_ms": 1718000000000,
  "replay": false,
  "snapshot": { /* full HandoffSnapshot, see above */ },
  "from": "alice",
  "to": "bob",
  "text": "{...stringified snapshot...}",
  "ts": "14:22:03",
  "image": null
}
```

Kind values:

| Kind | When |
|---|---|
| `handoff.new` | Emitted once, at creation. |
| `handoff.update` | Every subsequent state change (accept, decline, cancel, expire). |

There are no `handoff.expired` / `handoff.cancelled` kinds as separate
events — the terminal state is carried in `snapshot.status`, and the
`version` bump disambiguates it from the preceding `pending` state.

### Reconciliation contract

Clients MUST reconcile by `(handoff_id, max version seen)`:

- Discard any incoming event whose `version` is **≤** the highest version
  already applied for that `handoff_id`.
- Accept otherwise, replacing the in-memory snapshot.

This makes replay-on-reconnect, out-of-order delivery, and SSE retry all
idempotent without extra client-side bookkeeping.

---

## The `interrupt` kind

High-visibility attention flag. Lifecycle: `pending → acknowledged`
(terminal). No cancel, no expire — interrupts stay pending until the
recipient acknowledges them.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Format `i_[0-9a-f]{16}`. |
| `from_agent` | `string` | |
| `to_agent` | `string` | |
| `text` | `string` | 1–500 chars. |
| `status` | `"pending" \| "acknowledged"` | |
| `created_at_ms` | `number` | |
| `acknowledged_at_ms` | `number \| null` | Set on ack. |
| `acknowledged_by` | `string \| null` | The `by` of the ack (recipient or human). |
| `version` | `number` | `MAX(events.seq)` for this interrupt's id. |

### HTTP

| Method | Path | Auth | Body cap | Purpose |
|---|---|---|---|---|
| POST | `/interrupts` | Bearer | 256 KiB | Create. Returns `201 {"id":"i_..."}`. |
| POST | `/interrupts/{id}/ack` | Bearer | 256 KiB | Acknowledge. `{by: <recipient-or-human>}`. |
| GET  | `/interrupts?status=&for=&limit=` | Bearer header OR `?token=` | — | List snapshots. |

### MCP tools

- `send_interrupt({to, text})` → returns `interrupt_id=i_...`.
- `ack_interrupt({interrupt_id})` → idempotent if already acknowledged by you.

### SSE events

- `interrupt.new` — once, at creation.
- `interrupt.ack` — once, at acknowledgement.

Reconciliation follows the same `(id, version)` contract as handoffs.

### Trust semantics

The interrupt is **not** a kernel-level preemption; the hub can't force an
LLM to pause mid-turn. The coordination value is:

1. A distinct `<channel kind="interrupt.new">` notification the agent's
   system prompt teaches it to react to (via the briefing).
2. A persistent, sticky UI card the human cannot visually miss.
3. An explicit ack protocol so senders know when the message was read.

Cooperative agents honor it; uncooperative ones don't. Acceptable for a
collaboration-oriented tool.

---

## The `permission` kind

Claude Code tool-use approvals relayed through the chat. Lifecycle:
`pending → allowed | denied | dismissed` (terminal). No TTL — Claude
Code's local dialog owns the effective timeout. `dismissed` is for
user-acknowledged ghosts (xterm answered first, channel never notified).
Requires Claude Code 2.1.81+ which ships the `claude/channel/permission`
capability; older versions ignore the capability and fall back to the
xterm-only flow.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Claude-generated request_id. Format `[a-km-z]{5}` (5 lowercase letters a–z excluding `l`). |
| `agent` | `string` | The agent whose session produced the approval prompt. |
| `tool_name` | `string` | e.g. `Bash`, `Write`, `Edit`. 1–120 chars. |
| `description` | `string` | Claude's single-line summary (≤2000 chars). |
| `input_preview` | `string` | Truncated tool input (≤8000 chars). |
| `status` | `"pending" \| "allowed" \| "denied" \| "dismissed"` | `dismissed` = ghost card cleared by the human after an xterm-first answer. |
| `created_at_ms` | `number` | |
| `resolved_at_ms` | `number \| null` | Set on verdict. |
| `resolved_by` | `string \| null` | Who answered (human or any agent). |
| `behavior` | `"allow" \| "deny" \| null` | Mirrors `status` in the resolved state. |
| `version` | `number` | `MAX(events.seq)` for this permission's id. |

### HTTP

| Method | Path | Auth | Body cap | Purpose |
|---|---|---|---|---|
| POST | `/permissions` | Bearer | 16 KiB | Create pending. Body `{agent, request_id, tool_name, description, input_preview}`. Same-id replay while pending → idempotent 200; same id already resolved → 409. |
| POST | `/permissions/{id}/verdict` | Bearer | 16 KiB | Submit verdict. Body `{by, behavior: "allow"\|"deny"}`. `by` must be the human or a registered agent (else 403). A paused agent voting on another agent's request → 423. Same-status retry → idempotent 200; different status → 409; missing id → 404. |
| POST | `/permissions/{id}/dismiss` | Bearer | 16 KiB | Clear a ghost pending card. Body `{by}`. Only the requesting agent or the human (else 403; an unknown name or an agent of another room → 403). Pending → `dismissed`; same-status retry → idempotent; non-pending non-dismissed → 409. |
| GET | `/permissions?status=&for=&limit=` | Bearer header OR `?token=` | — | List snapshots. Default `status=pending`. |
| GET | `/permissions/{id}/wait?timeout_ms=` | Bearer header OR `?token=` | — | Long-poll one request. Returns the snapshot as soon as its status is terminal, or the `pending` snapshot when `timeout_ms` elapses. Default 60000, capped at 300000, `0` returns the current snapshot immediately. Invalid id or `timeout_ms` → 400; unknown id → 404. Polls the ledger every 250 ms per waiting request. |

### MCP tools

- `ack_permission({request_id, behavior})` — any agent may ack any pending permission. First verdict wins; later arrivals are idempotent (same behavior) or rejected with 409 (different behavior).

  Tool return value: `verdict_applied=<allow|deny> resolved_by=<agent> your_verdict_won=<true|false>` (plus `already_resolved=true` suffix when the race was lost). Delegation-minded callers (four-eyes, peer-quorum) must read `your_verdict_won` — a `200` alone means the state is resolved, not that the caller's verdict was the transitioning one.

  **Design note:** `ack_permission` is itself an MCP tool call, so Claude Code's local permission UI gates it for the acking agent unless `chatbridge__ack_permission` is in that agent's allowlist. For delegation to race the human's manual click on the original prompt, pre-allowlist the tool in the delegator's Claude Code config (`"permissions": { "allow": ["mcp__chatbridge__ack_permission"] }` or equivalent). Without pre-allowlist, the human typically wins the race and the peer-ack becomes a signal channel, not an actual delegation mechanism.

### MCP capability

chatbridge declares `capabilities.experimental["claude/channel/permission"] = {}`. Claude Code 2.1.81+ forwards `notifications/claude/channel/permission_request` to chatbridge, which POSTs them to `/permissions`. When the hub emits `permission.resolved`, chatbridge emits `notifications/claude/channel/permission` upstream so Claude Code applies the verdict and closes its local xterm dialog.

### Terminal-state policy

| Arrival | Current status | Result |
|---|---|---|
| `allow` | `pending` | Transition to `allowed` (200). |
| `deny` | `pending` | Transition to `denied` (200). |
| same behavior | `allowed`/`denied` | Idempotent (200 with `idempotent: true`). |
| different behavior | already resolved | Conflict (409 with current snapshot). |

### SSE events

- `permission.new` — once, at creation. Replayed as `replay=true` on `/agent-stream` reconnect for every currently-pending permission.
- `permission.resolved` — once, on verdict (`allowed` or `denied`).
- `permission.dismissed` — once, on user dismiss of a ghost card.

Reconciliation follows the same `(id, version)` contract as handoffs.

### Trust semantics

The local xterm dialog stays live. Path behavior diverges by who answers first:

- **Chat-first** — chatbridge emits `notifications/claude/channel/permission` upstream, Claude Code applies the verdict, the local xterm dialog closes. Clean bidirectional.
- **Xterm-first** — Claude Code applies the verdict locally and runs the tool. It does NOT emit a reciprocal notification. The hub's permission row would stay `pending` forever; the chat card blinks until the human clicks the `×` dismiss button (or Allow/Deny if they want a verdict audit record, noting that the tool already ran either way). Dismiss records `status="dismissed"` with `behavior=NULL` — distinct from allow/deny so the audit log stays truthful. No TTL, so ghosts persist across reconnect until manually dismissed.

No cryptographic identity binding on `by` — same trust-on-self-assertion model as handoff/interrupt routes. The `claude/channel/permission` capability MUST NOT be declared without bearer-token auth on `/permissions/*`; see the CLAUDE.md hard rule.

---

## The `nutshell` kind

A single-row living document — the project's working reference point.
Stored in a one-row `nutshell` table guarded by `CHECK(id = 0)`. Edits are
proposed via the existing `handoff` primitive (no separate edit route) to
keep the accept/decline UX consistent.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `text` | `string` | The current nutshell. Empty on first launch. |
| `version` | `number` | Monotonic; 0 before the first accepted edit. |
| `updated_at_ms` | `number` | |
| `updated_by` | `string \| null` | The `from_agent` of the last accepted edit. |

### Edit protocol

Callers send a handoff:

```json
POST /handoffs
{
  "from":    "<proposer>",
  "to":      "<human-name>",
  "task":    "[nutshell] <short summary>",
  "context": { "patch": "<full new nutshell text>" }
}
```

On accept by the human, the hub atomically writes the patch, bumps
`version`, sets `updated_by = <proposer>`, and broadcasts an
`SSE event: type=nutshell.updated` to all UI subscribers. Agents receive
the updated text on their next connection as part of the briefing. The
handoff-accept path validates:

- Task prefix is `[nutshell]` (case-sensitive).
- Recipient is the configured human name.
- `context.patch` is a string.

If any check fails the handoff accepts normally but the nutshell is not
modified — no partial state is possible.

### HTTP

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/nutshell` | Bearer header OR `?token=` | Current snapshot. |

No direct POST/PUT; use the handoff flow above.

---

## The `ticket` kind

Room-scoped work items that exist before they have an owner. Lifecycle `draft → queued → claimed → in_progress → in_review → done`, plus `in_review → in_progress` (rework) and `cancelled` from any non-terminal status. The default creation status is `queued`. A create request may name another status (see the create row under "HTTP"). The human may also move an open ticket to `draft`, `queued`, `in_progress`, `in_review` or `done` from any non-terminal status (`POST /tickets/:id/transition {by, to}`; the assignee is kept). An agent moves a ticket to `draft` or `queued` only in the two intake moves described under "Draft tickets"; every other move into `draft` or `queued` is the human's (403 for an agent). Agents keep the lifecycle above. Every transition writes one row in `events` and one `tickets` update in one transaction; broadcasts carry `version = events.seq`.

### Snapshot schema

`id` (`t_…`), `room`, `title`, `acceptance_criteria` (required, non-empty), `blast_radius` (`low` | `high`), `archived_at_ms` (null, or when a done/cancelled ticket was archived), `priority` (`highest` | `high` | `medium` | `low` | `lowest`, default `medium`; stored as an integer rank 5–1, a stored value outside 1–5 reads as `medium`), `creator`, `assignee` (null until claimed), `approval_request_id` (null or a permission id), `external_ref` (opaque string, never interpreted), `request_id` (null, or a label that groups the tickets of one request), `role` (null, or the stage role of the first stage: see the `stage` kind), `status` (`draft` | `queued` | `claimed` | `in_progress` | `in_review` | `done` | `cancelled`), `created_at_ms`, `updated_at_ms`, `version`. Read routes and broadcast entries also carry two derived arrays, `blocked_by` (the ids of the tickets that block this one) and `open_blockers` (the ids among them whose status is not `done`). They come from the `ticket_blockers` table and are not snapshot columns.

### Ownership

- Claim (`queued → claimed`): any agent in the ticket's room, or the human. A second claim → 409. A `draft` ticket cannot be claimed (409 `ticket is draft: it cannot be claimed`). An agent cannot claim a ticket while a blocker is open (see "Request label and blockers").
- Advance and rework: the assignee or the human. Others → 403.
- Cancel: the assignee, the creator or the human.
- Cross-room creation or claim by a non-human → 403.

### Approval for `high` radius

`done` on a `high` ticket succeeds only when the human is the actor, or the permission named by `approval_request_id` is `allowed` with `resolved_by` = the human's name. Otherwise 409 with `approval_request_id` (this key appears only on this 409). `POST /tickets/:id/approval` (assignee, `in_review`, `high`) returns the pending request, or creates a `ticket:done` permission request (`input_preview` `{"ticket_id":"…"}`) and sets the pointer in one transaction — one `permission.new` event, no ticket event. `in_review → in_progress` and a human `in_review → queued` clear the pointer. Rework, cancel and a human `done` also dismiss a still-pending request in a separate transaction after the ticket's (`permission.dismissed`), so it is neither pending nor replayed on reconnect. Trust is self-asserted like every route, so `blast_radius: high` is advisory: a token holder can send `by` = the human name, open the gate or complete the ticket itself. The gate stops an agent that reports its own name honestly. Enforcement needs per-agent tokens bound to identity.

### Request label and blockers

`request_id` is a label, not an entity. It has the format `^[A-Za-z0-9._-]{1,64}$`, for example `r-2026-10-22-login`. A request is the set of tickets with the same label in one room. There is no request table. A bad label → 400 and nothing is stored.

`blocked_by` lists the ids of tickets that must be `done` before this ticket can be claimed. The rows are in the `ticket_blockers` table. The hub checks the list before it writes. At most 20 ids. Each id is a string that names an existing ticket in the same room. A ticket cannot block itself. An id cannot appear twice. The new list cannot make a cycle. Any failure → 400, and nothing is stored or broadcast. An error about one blocker id (a wrong format, the ticket itself, a duplicate, an unknown ticket, another room, a cycle) names that id. A value that is not an array, or a list of more than 20 ids, gets a general message. An omitted `blocked_by` changes nothing. `null` and `[]` clear the list. The event and the rows are written in one transaction.

**Claim gate.** A claim by an agent gets 409 `blocked by <id> (<status>)` while any blocker has a status other than `done`. A `cancelled` blocker still blocks: it must be removed from the list. The human is not gated. The hub reads the blockers before the write transaction, in the same synchronous dispatch with no `await` between the check and the write. This is safe only while both conditions hold: the hub is the only writer of the ledger, and the dispatch stays synchronous. A second writer process or an `await` in the dispatch voids it, and the check must then move into the transaction. The human, the creator or the room lead can remove a blocker from the list before the claim.

**Who edits.** The human, the ticket's creator and the room lead change `request_id` and `blocked_by` with `POST /tickets/{id}/edit`. The assignee does not (403), unless the assignee is also the creator or the lead. An agent changes them only while the ticket is `draft` or `queued`. After the claim, the creator and the room lead get 409. An assignee who is neither of them still gets 403, because the hub checks the role before the status. The hub also checks the role before the terminal state: a `done` or `cancelled` ticket gives 403 to an actor with no right and 409 to one with the right. The human changes them in any non-terminal status. A `done` or `cancelled` ticket refuses every edit, the human included (409). The other fields keep their own rule.

### Draft tickets

A `draft` ticket is a planned ticket that is not released. It cannot be claimed. `ticket.new` and `ticket.assigned` entries for a draft wake no one, and the room lead is not woken to triage it. The entry of a draft carries no `lead`.

- `draft → queued`: the human or the room lead. Others → 403. The lead gets 403 `the request holds a high blast_radius ticket: only the human may queue it` when any non-terminal ticket with the same `request_id` in the room has `blast_radius: high`, this ticket included. A ticket with no `request_id` is checked alone. The same label in another room does not count. The human is never refused.
- `queued → draft`: the human or the room lead. The radius check does not apply.
- From a later status, only the human moves a ticket to `queued` or `draft`.
- The move `draft → queued` writes the ledger event `ticket.queued` and broadcasts the entry kind `ticket.promoted` (not `ticket.update`). The entry always carries `by`, the actor of the move. It carries `lead` (the room lead or null) only when the ticket has no assignee. A repeated move is idempotent and emits nothing, also when the lead repeats it.

### HTTP

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/tickets` | Bearer | Body `{by, room, title, acceptance_criteria, blast_radius, priority?, external_ref?, request_id?, blocked_by?, assignee?, status?}` → 201 `{snapshot}`. `request_id` and `blocked_by` follow the rules under "Request label and blockers". `status` ∈ `draft`, `queued` (default), `in_progress`, `in_review`, `done`: the ticket is created in that column by the one `ticket.created` event, assigned or not; `done` only for the human (403), any other value → 400. `assignee` (optional) must be a registered agent in the room: unknown or the human → 400, another room → 403. `priority` ∈ `highest`, `high`, `medium` (default), `low`, `lowest` — lowercase names only; an integer, another word or a different case → 400 `invalid priority`. |
| POST | `/tickets/{id}/claim` | Bearer | Body `{by}` → 200 `{snapshot}` (or `idempotent: true`).  A `queued` ticket with an assignee is claimable only by that assignee: any other actor, the human included, gets 409 `assigned to <name>`. A `draft` ticket → 409 `ticket is draft: it cannot be claimed`. An agent's claim of a ticket with an open blocker → 409 `blocked by <id> (<status>)`. |
| POST | `/tickets/{id}/attachments` | Bearer | Body `{by, url, name}`; `url` is a file already uploaded through `/upload` (`/image/<id>.<ext>`, the extension on the upload allowlist, the file present); `name` a one-line label ≤ 200 chars. `by` is the human, the ticket's creator or its assignee (403 otherwise); any ticket status, archived included. Append-only; one `ticket.attached` event; the ticket's version does not change. The same file twice on one ticket is an idempotent 200 (`idempotent: true`, no event) → 201 `{attachment: {id, author, name, url, created_at_ms}, attachments_count}`. The link goes to the UI stream only (ambient entry `ticket.attached`), never to an agent. |
| POST | `/tickets/{id}/attachments/{attachment_id}/remove` | Bearer | Body `{by}`. Removes the link, not the uploaded file (it stays on disk). One `ticket.detached` event (payload `{attachment_id}`) and the `ticket_attachments` DELETE in one transaction. `by` is the human, the ticket's creator or the attachment's author (403 otherwise). The human may remove on any open ticket. The creator and the author only while the ticket is `draft` or `queued` (409 otherwise). A `done` or `cancelled` ticket → 409 for everyone. Unknown attachment id → 404. A retry of a removed attachment → 200 `{idempotent: true}`, no event. → 200 `{attachments_count}`. The removal goes to the UI stream only (ambient entry `ticket.detached` with `attachment_id` and `attachments_count`), never to an agent. |
| GET | `/tickets/{id}/attachments` | Bearer header OR `?token=` | Plain array of `{id, author, name, url, path, created_at_ms}`, oldest first; `path` is where an agent reads the file on this machine. 404 for an unknown ticket. |
| POST | `/tickets/{id}/notes` | Bearer | Body `{by, text}`; `by` is the ticket's assignee or the human (403 otherwise); `text` non-empty, ≤ 4096 UTF-8 bytes (400). Any ticket status, archived included. Append-only; one `ticket.noted` event; the ticket's version does not change → 201 `{note: {id, author, text, created_at_ms}, notes_count}`. The note goes to the UI stream only (ambient entry `ticket.noted`), never to an agent. |
| GET | `/tickets/{id}/notes` | Bearer header OR `?token=` | Plain array of `{id, author, text, created_at_ms}`, oldest first. 404 for an unknown ticket. |
| POST | `/tickets/{id}/archive` | Bearer | Body `{by, archived: true\|false}`; `by` is the human or the room lead (403 otherwise). Only a `done` or `cancelled` ticket (409 otherwise). Sets or clears `archived_at_ms`; the status is unchanged → 200 `{snapshot}` (or `idempotent: true`). One `ticket.archived` event. The update goes to the UI stream only (ambient entry `ticket.archived` with the snapshot), never to an agent. |
| POST | `/tickets/{id}/assign` | Bearer | Body `{by, assignee}`; `by` is the human, the ticket's creator or the room lead; the ticket is not `done`/`cancelled`. `assignee: null` unassigns, only while the ticket is `draft` or `queued` (409 otherwise). Unassigning a draft wakes no one. Sets or changes the assignee without changing the status → 200 `{snapshot}` (or `idempotent: true` for the current assignee). Unknown assignee or the human → 400; assignee in another room, or `by` neither the human nor the creator → 403; terminal ticket → 409. Reassigning a ticket in `in_review` clears its approval pointer and dismisses a pending request. |
| GET | `/rooms/{room}/lead` | Bearer header OR `?token=` | → `{room, lead}`; `lead` is null when none is set or the stored agent is no longer a registered agent of the room. |
| POST | `/rooms/{room}/lead` | Bearer | Body `{by, agent}`; human only (403 otherwise). `agent` is a registered agent of the room (unknown or the human → 400, another room → 403), or `null` to clear. One `ticket.lead` event; refreshes the Briefings → 200 `{room, lead}` (or `idempotent: true`). |
| POST | `/tickets/{id}/edit` | Bearer | Body `{by, title?, acceptance_criteria?, blast_radius?, priority?, external_ref?, request_id?, blocked_by?}`, at least one field (400 otherwise); `priority` is a priority name (400 `invalid priority` otherwise); `external_ref` is a string of at most 200 chars, or `null` to clear it (400 `invalid external_ref`); `request_id` is a label, or `null` to clear it; `blocked_by` replaces the whole list; `title` ≤ 200 chars, `acceptance_criteria` ≤ 4000 chars, both non-empty after trim. `by` is the human, the ticket's creator or its assignee (403 otherwise) for `title`, `acceptance_criteria`, `priority`, `external_ref` and `blast_radius`; for `request_id` and `blocked_by` it is the human, the creator or the room lead, and only while the ticket is `draft` or `queued` for an agent (see "Who edits"). An edit that mixes both kinds must pass both rules. A change of only the blocker list still emits one `ticket.edited` event. `blast_radius` is the human's alone: any agent that sends it gets 403 and nothing changes, even with the current value. A `done` or `cancelled` ticket → 409. Values equal to the current ones → 200 `idempotent: true`, no event. One `ticket.edited` event and one `tickets` update in one transaction; the `ticket.update` entry goes to the room and the Briefings refresh → 200 `{snapshot}`. Changing `acceptance_criteria` or lowering `blast_radius` clears `approval_request_id` in the same transaction and dismisses a still-pending request in a separate one; an `allowed` request no longer opens the gate, so a `done` move needs a new Allow. |
| POST | `/factory/relink` | Bearer | Body `{agent, force?, reload_id?}`. Hot reload: the records per agent in `<CUBILOT_FACTORY_DIR>/agents/`. The link `<hex of the name's UTF-8 bytes>` is the files the agent sees. `<hex>.applied` is the version its runtime loaded with success. `<hex>.pending` is a reload that this route ordered and nobody has completed. It has three lines: the version, the `reload_id` of the human's request (empty when the bridge started the reload) and the attempt id of this one order. `<hex>.last` is the result of the newest reload that the bridge reported (see `/factory/applied`). The desired version is `CUBILOT_FACTORY_VERSION`, and it must be a `v-<16 hex>` directory under the factory dir. No `agent` → 400. No link (no role, a launch before per-agent links, or a no-role relaunch) → 404: the bridge never reloads. No valid desired version → 409, nothing moves. Link and `.applied` both equal the desired version and `force` is not `true` → 200 `{reload:false}`. `force:true` skips only this same-version short circuit. The route then orders a reload even when the agent already has the desired version (the choice of skills changed, not the version). When the link names another version, the link still moves to the desired version. A `.pending` file exists, for ANY version → 200 `{reload:false, pending:true}`: a reload is running, so the replacement bridge after a Pi reload or a newer version orders no second one. **`.pending` has no time limit.** Only `/factory/applied` (success or failed) or a new session (the app deletes the agent's records at launch) clears it, so a reload with no completion stays blocked and the bridge logs "hot reload still pending: restart the agent". A bridge that gets `pending` keeps its check: it asks again after 5 s, 10, 20, up to 60 s, with no model turn, and stops when the answer is not `pending`. So a newer desired version is applied after the earlier reload ends. Else the link moves by temp link plus rename when it differs, `.pending` is written, → 200 `{reload:true, version, attempt}`. An agent that has skills records (`.skills-prepared` or `.skills-published`) first takes the publication lock (`.skills-lock`): a busy lock after 2 s → 503, any other lock error → 500. Under the lock the route checks for `.pending` again, moves the link, publishes the prepared build (the `.view` link swaps to `.view-<gen>`), and writes `.skills-pending` and `.pending`. A failed write → 500 and the route undoes the swap (the text says `rollback:` when the undo fails). There is no rollback of the reload itself. The bridge asks at the agent's idle point (at once when idle, at run end when busy). After the first reload ends, `.applied` differs from a newer desired version, so the next idle point reloads that one. |
| POST | `/factory/applied` | Bearer | Body `{agent, version, attempt}` or `{agent, failed:true, attempt}`. A report is accepted only for the order in `.pending`: no `.pending`, or an `attempt` that differs from the third line of `.pending` → 409 `stale or unknown attempt`, and nothing changes. Missing `agent`, or neither `version` nor `failed` → 400. No link → 404. `failed:true`: writes `.last` (`failed`), deletes `.pending` and `.skills-pending`, and writes nothing else. `.skills-published` and `.skills-applied` stay, so the next relink orders the reload again with the same selection. `version`: must be the version the agent's link names (else 409). An agent with a `.skills-pending` record must report the same attempt (else 409). The route copies `.skills-pending` to `.skills-applied`, writes `<hex>.applied` by temp file plus rename, writes `.last` (`applied`), and deletes `.pending` and `.skills-pending`. A write error before `.pending` is deleted (`.skills-applied`, `.applied` or `.last`) → 500 and `.pending` stays, so the same report can be sent again. The final cleanup is not covered: the route deletes `.pending` first, then `.skills-pending`, so a failure of the second delete can return 500 after `.pending` is gone. `.last` is JSON `{result:"applied"|"failed", version, at, reload_id}`; `reload_id` is the human's request id or null. The adapter calls it after a good reload: the Pi `/cubilot-reload` handler after `ctx.reload()` resolves (`session_shutdown` is not success), the Claude mod after `reload-plugins` resolves. If the reload replaced the Claude module, the old module stored the version in `$.state` first and the new module records it at its start. Both adapters bound the wait for a reload to 30 s (a timeout is not a failure, and it reports nothing). The Claude mod keeps success and failure attached to the real command, so a command that ends after the bound still records applied or reports failed. A failed reload is retried once at the next idle point, then logged as "hot reload failed". Accepted limits: chat in flight can be lost when Reload settings restarts the hub. A new run that starts while the relink call is pending can see changed files. A runtime reload that continues after its 30 s bound is not stopped, and `.pending` blocks a second one for as long as it runs. A failed Pi reload needs an agent restart: `ctx.reload()` stops the bridge and invalidates the runtime API before it fails, so the handler reports `failed:true`, posts "<agent>: hot reload failed, restart this agent" to the human through the hub, and logs. |
| POST | `/agents/{name}/reload` | Bearer | The human's Reload button. Body `{by, force?}`. `by` must be the human name (403 otherwise). An unknown agent or the human → 400. The route sends one control entry `agent.reload` (see "Reload request event") to that agent's bridge only when the agent has a factory link and an open stream. An offline agent, or an agent with no link, gets nothing and the request is not kept for later. → 200 with the status below plus `{requested, reload_id}`. `reload_id` is 16 hex characters when `requested` is true, else null. The status is `{agent, online, paused, room, factory:{desired, linked, applied, pending, pending_reload_id, last}}`: the version names, the `.pending` version and `reload_id`, and the content of `.last`. The route changes no file. |
| GET | `/agents/{name}/reload-status` | Bearer header OR `?token=` | Read only. The same status as the reload route, and nothing is sent to the agent. An unknown agent or the human → 400. The UI polls it to see its `reload_id` in `pending_reload_id` (the bridge started) and in `last.reload_id` (the result). |
| POST | `/tickets/{id}/transition` | Bearer | Body `{by, to, note?}`; **an agent's move to `in_review` needs a non-empty `note` (≤ 4096 UTF-8 bytes; 400 otherwise)** saying how it was built and tested; the human may move without one. A note on any move is stored in the same transaction and event (its id is the event's seq); a repeat move stores none; `to` ∈ `draft`, `queued`, `in_progress`, `in_review`, `done`, `cancelled`. `draft` and `queued` follow the rules under "Draft tickets". Same-status → idempotent 200; conflict → 409. |
| POST | `/tickets/{id}/approval` | Bearer | Body `{by}` → 200 `{request_id, created, status}`; `status` is `pending` or `allowed`. `created: false` with `allowed` means the human already allowed the pointed request: nothing new is made and the tool retries the move. |
| GET | `/tickets?room=&status=open\|all&request_id=` | Bearer header OR `?token=` | `room` required. Archived tickets are hidden unless `archived=1` is added. `request_id` (optional) keeps only the tickets with that label in the room; the hub filters in SQL before the list limit, and a bad label → 400. Each ticket also carries `blocked_by` and `open_blockers`. Plain array ordered by priority rank (highest first) then `created_at_ms ASC`, each with `approval: {id, status, resolved_by, version} \| null`, `notes_count` and `attachments_count` (`version` = the permission's `events.seq`). Default `status=open` (non-terminal). |

### Reload request event

`POST /agents/{name}/reload` sends one SSE entry to the named agent's `/agent-stream` queue: `{type: "agent.reload", from: "system", to: <name>, text: "", ts, image: null, room, force, reload_id}`. `force` is true when the body asked for it. `reload_id` is the 16 hex characters that the route returns. The scope is `agents-ambient` (`hub/core/types.ts`): the named agents only, with no UI subscriber, no chat log entry and no transcript line. The bridge (`hub/channel/core.ts`) never shows the entry to the model. It clears the failure count of the version it knows, keeps `force` and `reload_id`, and runs the reload check: at once when the agent is idle, at the end of the run when it is busy. The check posts `/factory/relink` with `force` and `reload_id`, so `.pending` and `.last` carry the id of the click. The cross-room rule of the bridge applies to this entry like to any other.

### Agent tools

`create_ticket` (also `status` `draft`, `request_id`, `blocked_by`), `claim_ticket`, `transition_ticket` (targets include `draft` and `queued`; the hub decides who may use them), `list_tickets` (also a `request_id` filter; each line shows the label and the open blockers), `assign_ticket`, `edit_ticket` (also `request_id` and `blocked_by`; the tool does not send `priority` or `external_ref`). `transition_ticket` to `done` calls the approval route on the approval 409 and returns the request id. `accept_handoff` claims the ticket named in `context.ticket_id` after a successful accept and reports both outcomes.

### SSE events

`ticket.new`, `ticket.update`, `ticket.assigned` (an assignment, status unchanged) and `ticket.promoted` (a draft moved to `queued`) with `ticket_id`, `version`, `snapshot` (which includes `blocked_by` and `open_blockers`); scope `{kind: "room", room}`. The entry's `from` is the actor who made the change (the assignee is only in `snapshot`). The bridge delivers every ticket entry in `context` mode (it enters the agent's context and starts no turn), except these wakes, which start a turn: a `ticket.new` or `ticket.assigned` entry wakes the ticket's assignee (only a `ticket.new` is skipped for the agent that created the ticket, because it just made it; a `ticket.assigned` always wakes the assignee, its creator included); a `ticket.new` entry of an unassigned ticket, or a `ticket.assigned` entry that unassigns, wakes the room lead (the agent named in the entry's `lead`); and a `permission.resolved` for a `ticket:done` request wakes the agent that raised it. A `permission.new` for a `ticket:done` request wakes no one. A draft ticket wakes no one on `ticket.new` or `ticket.assigned`. A `ticket.promoted` entry wakes the assignee once, also when the assignee created the ticket, or wakes the room lead for an unassigned ticket, except when the lead made the move (`by`). A `ticket.update` never wakes. The hub does not broadcast the dependent ticket again when one of its blockers changes status: the board works out the open blockers from the tickets it holds. The entries for archiving (`ticket.archived`), notes (`ticket.noted`) and a lead change (`room.lead`) go to the UI stream only. The `ticket.update` entry of a move that stored a note carries `notes_count` but never the text. Notes are an audit trail, not chat: they are in no Briefing and reach no agent. Tickets are not replayed on reconnect; the agent's own open tickets are in its Briefing (each with the request label, the status `draft` when it applies, and a `Blocked by:` line for blockers that are not `done`), and the room lead's Briefing also lists the open unassigned tickets of its room under "Unassigned tickets to triage:". The `ticket.new` entry of an unassigned ticket carries `lead` (the room lead or null), and so does the `ticket.assigned` entry of an unassign. A lead change is sent to the UI stream only, as an ambient `room.lead` entry `{room, lead}` (not a `ticket.*` kind: no agent receives it). The lead's block starts with a line that tells it to use `assign_ticket`.

A `ticket.assigned` entry with `from: "system"` is the hub's own assignment: at a stage launch, or to the room lead after a final PASS (see "Launch ownership" and "Final PASS" under the `stage` kind). It wakes no stage session, because the first message of the session already holds the ticket. An ordinary assignee, for example the room lead, is woken as for any other assignment. The `ticket.update` of a `done` move by `system` wakes no one.

## The `stage` kind

A stage is the work of one role on one ticket. The hub creates the stage, starts one session for it, checks its result and closes the session. Source: `hub/kinds/stage.ts`, `hub/core/launch-queue.ts`, `src-tauri/src/launches.rs`. Spec: `openspec/changes/stage-sessions`.

The roles are `worker`, `tester`, `validator`, `writer`, `editor` and `reviewer` (`STAGE_ROLES` in `hub/core/ledger.ts`). The `stage` table also holds request-level spec-review stages (`review = 'spec'`, `ticket_id` NULL). This section describes ticket stages first. "Spec-review stages" below gives the differences.

### Lifecycle

```
queued ──► launching ──► running ──► passed     (terminal)
  │            │            │
  │            │            └──► retrying ──► launching   (attempt 2)
  │            └──► retrying
  └──► failed  (no project folder: no attempt counted)
launching / running / retrying ──► failed       (terminal, after attempt 2)
```

| Status | Meaning |
|---|---|
| `queued` | The stage waits for a free slot of its role, or for its ticket to become ready. |
| `launching` | The hub queued a launch request. The shell has not acknowledged it yet. |
| `running` | The shell started the session. |
| `retrying` | Attempt 1 ended without a result. The stage waits for its relaunch. |
| `passed` | A valid result arrived. A `FAIL` verdict also gives `passed`: the stage is a record and the verdict goes to the Orchestrator in the result handoff. |
| `failed` | Attempt 2 ended without a result, or the room has no project folder. |

A stage has at most two attempts (`attempt` 1 and 2). Each transition writes one ledger event (`stage.queued`, `stage.launching`, `stage.running`, `stage.retrying`, `stage.passed`, `stage.failed`) and one `stage` row update in one transaction. The actor of every stage event is `system`.

### Snapshot schema

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Format `s_[0-9a-f]{16}`. |
| `ticket_id` | `string \| null` | Set for a ticket stage. NULL for a spec-review stage. |
| `request_id` | `string \| null` | Set for a spec-review stage. |
| `review` | `"spec" \| null` | NULL for a ticket stage. |
| `verdict` | `string \| null` | NULL until a result with a verdict is recorded. |
| `role` | `string` | One of the six roles. |
| `attempt` | `number` | 1 or 2. |
| `status` | `string` | See "Lifecycle". |
| `session` | `string \| null` | `<role>-<n>`. Set on `launching`. |
| `slot_seq` | `number \| null` | |
| `version` | `number` | `events.seq` of the last stage event. |

The table also has `created_seq` (the queue order) and `updated_seq`. They are not in the snapshot.

### When the hub creates a stage

The ticket field `role` (one of the six roles, or null) names the role of the first stage. `create_ticket` and `edit_ticket` set it. An unknown role → 400 and nothing is stored. The human, the ticket's creator and the room lead change `role`, with the same rule as `request_id`.

The hub evaluates a ticket (`evaluateStages`) after each change that can make it ready. These changes are a ticket created as `queued`, a draft moved to `queued`, a blocker moved to `done`, and a `to_role` handoff. The hub creates a stage for a role when all of these conditions are true:

1. The ticket is not `draft`, `done` or `cancelled`.
2. No ticket in its `blocked_by` list has a status other than `done`.
3. No stage of that ticket and role is `queued`, `launching`, `running` or `retrying`.
4. One of these is true:
   - The role is the ticket's `role` and the ticket has no stage of that role yet.
   - A `to_role` handoff for that ticket and role is newer than the last stage of that role. A `cancelled` or `declined` handoff does not count.

The ticket's `role` starts only the first stage. Every later stage, of the same role or another role, comes from a `to_role` handoff.

### Role handoffs (`to_role`)

`POST /handoffs` and the `send_handoff` tool take `to_role` in place of `to`:

```json
{
  "from": "worker-1",
  "to_role": "tester",
  "task": "Test the login fix",
  "context": { "ticket_id": "t_0123456789abcdef", "commit": "c9c060f" }
}
```

| Rule | Failure |
|---|---|
| Name exactly one of `to` and `to_role`. | 400 `name either to or to_role, not both` |
| `to_role` is one of the six roles. | 400 `invalid to_role (one of …)` |
| `context.ticket_id` names a ticket. | 400 `a to_role handoff needs context.ticket_id`. 404 for an unknown ticket. |
| `context.commit`, when present, is a hex commit hash of 7 to 64 characters. | 400 |
| The ticket is in the sender's room (the human is exempt). | 403 `cross-room handoff not permitted` |

The hub stores the recipient as `role:<role>` in `to_agent`. No agent can have this name, because agent names cannot contain `:`. The handoff names no session. The handoff writes its own single event. The stage evaluator then runs in the same request, after the handoff is recorded. A `to_role` handoff does not start a session by itself. When the ticket is not ready or the role is at its limit, the stage stays `queued` or the hub creates no stage.

A `to_role` handoff with `review: "spec"` is a spec-review request. It names a request, not a ticket. See "Spec-review stages".

### Slots, limits and session names

`PUT /rooms/<room>/settings` holds two stage settings:

| Field | Values | Default |
|---|---|---|
| `role_limits` | Object of role → whole number 0 to 10. Only the six roles. `null` restores the defaults. | `worker` 2, `tester` 2, `validator` 1, `writer` 1, `editor` 1, `reviewer` 1 |
| `stage_timeout_min` | Whole number of 1 or more, or `null`. | 30 |

A slot is a stage of the role in the room that is `launching` or `running`. A session of the role whose close the shell has not acknowledged also holds a slot. A stage whose role is full stays `queued`. When a slot becomes free, the hub starts the waiting stages of that role in that room. It starts the `retrying` stages first, then the `queued` stages by age (`created_seq`).

The session name is `<role>-<n>`. `n` is the lowest number of 1 or more that no live session of the role uses, in all rooms. All rooms count because all sessions share one tmux socket. A name whose close has no acknowledgement is not free. The limits stay per room.

### The launch stream

The hub does not start or stop an agent session. It queues requests, and the Rust shell does the work. (The hub itself runs `git` subprocesses for the worktrees.)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/launches/stream` | Bearer header OR `?token=` | SSE stream of launch and close requests. Each event has `id: <request id>` and `data: <request JSON>`. |
| POST | `/launches/{id}/ack` | Bearer header | The shell's answer to one request. |

Request formats (`id` has the format `l_[0-9a-f]{16}`):

```json
{
  "id": "l_…", "kind": "launch", "stage_id": "s_…", "session": "worker-1",
  "role": "worker", "room": "cubilot", "harness": "claude",
  "cwd": "<worktree path>", "prompt": "<first message>",
  "env": { "CHATBRIDGE_AGENT": "worker-1", "CHATBRIDGE_ROOM": "cubilot", "CUBILOT_STAGE_ID": "s_…" }
}
{ "id": "l_…", "kind": "close", "session": "worker-1" }
```

- `harness` comes from the role's staged `harness` file (`hub/core/role-harness.ts`). The default is `claude`.
- `cwd` is the worktree that the hub made before it queued the launch. The shell never runs git.
- `prompt` is the ticket part of the first message, rendered from `factory/<role>/first-message.md`. It does not contain the role prompt. `factory-roles` passes the role prompt as a file: Claude Code gets `--append-system-prompt-file <file>`, and pi gets `--append-system-prompt <file>` (`src-tauri/src/pty.rs`). A retry adds one line with the reason of the earlier stop. When a `to_role` handoff started the stage, the prompt also holds a section `## Handoff` with the sender, the task and the context JSON of that handoff. The section is capped at 64 KB. Over the cap, the hub cuts it and adds one line that names the handoff id. A stage that no handoff started gets no such section. A retry gets the same section. The section starts its context with one line that names the session's own stage id: "The stage_id in this context is the sender's stage. Your stage id is <id>. Use your own stage id in your result." The cap includes this line.
- The shell reads `stage_id` and sets `CUBILOT_STAGE_ID` itself. It does not read `env`.

Ack body:

```json
{ "result": "spawned" }
{ "result": "error", "error": "<text, max 500 chars>" }
{ "result": "error", "error": "no such session", "absent": true }
```

`result` is `spawned` or `error`. An `error` ack needs `error` text. `absent` is allowed only with `error` and only means something for a close.

| Ack | Response |
|---|---|
| Unknown request id | 404 |
| First answer | 200 `{"ok": true}` |
| Same answer again | 200 `{"idempotent": true}` |
| Other `result` than the recorded one, or an ack after the time-out | 409 |
| Close with `error` and no `absent` | 200 `{"ok": true, "pending": true, …}`. The close stays pending. |
| The hub could not record the stage change | 500. Send the ack again. |

The hub compares only `result` with the recorded answer. It ignores the `error` text. The hub keeps a completed request in memory for 600 000 ms (10 minutes). After that time, an ack for the request gets 404.

Rules:

- A launch that gets no ack within 15 s after its delivery to the shell counts as a failed attempt. So does an `error` ack. Attempt 1 goes to `retrying`, attempt 2 to `failed`. `CUBILOT_LAUNCH_ACK_MS` changes the 15 s.
- A `spawned` ack moves the stage from `launching` to `running`.
- While no shell is connected, requests wait in the hub. A new connection replaces the older one. It receives the undelivered requests and every close that has no ack. A launch that the hub sent to an older connection is not sent again, because the session could start twice.
- A close is complete on `spawned`, or on `error` with `absent: true`. Until then the session name is reserved.
- The queue is in memory. At hub start, each stage that is still `launching` counts as a launch with no ack. Each `passed` stage whose session no live stage uses gets one close request.
- The shell retries an ack up to 10 times, 1 s apart, on no answer or a 5xx. It never does the work again because an ack failed.

**Who can queue a launch.** No route and no chatbridge tool has a launch parameter. One function, `enqueueLaunch` in `hub/kinds/stage.ts`, queues launch requests. Only the stage evaluator and the retry path call it. `tests/unit/launch-queue.test.ts` checks that `enqueueLaunch` is named, and the launch queue is imported, only in `hub/kinds/stage.ts`. Each call checks the launch conditions again. The ticket is not `draft`, `done` or `cancelled`, no blocker is open, and the role has a free slot. When a check fails, the stage stays as it is.

**Accepted risk.** There is no per-role token. Any holder of `hub.token` can read `/launches/stream` and send acks. The code path is the only control. See "Identity and trust model".

### Worktrees

The hub makes every stage worktree from the room's project folder (`project_folder` in the room settings). Worktrees are under `<app data>/worktrees/<room>/<ticket>/<session>`.

- `worker` and `writer`: the branch `ticket/<id>`. The hub creates the branch from the room base when it does not exist. A later stage of the same ticket and role uses the same worktree again.
- `tester`, `validator`, `editor`, `reviewer`: a temporary worktree with `--detach`. Its commit is `context.commit` of the newest live `to_role` handoff for that ticket and role. When that handoff has no commit, the hub uses the head of `ticket/<id>` when that branch exists, else HEAD. The hub removes the worktree after the close of its session is acked. When no session runs (the stage fails for good, or an attempt ends before a retry), the hub removes it at once.
- `validator` and `reviewer`: the worktree files are read-only (`chmod -R a-w`, not `.git`).
- A room with no project folder: the stage goes from `queued` to `failed` with the error `room has no project folder: set it in New factory room`. No session starts and no attempt is counted.

### Launch ownership and the `system` actor

When a stage moves to `launching`, the hub sets the ticket's `assignee` to the session name. The hub writes the `stage.launching` event and a `ticket.assigned` event with actor `system` in one transaction. Three transactions write events of two kinds: this one, the spec-review PASS (`stage.passed` and `ticket.queued`), and the final PASS of a ticket review (`stage.passed` and `ticket.done` or `ticket.assigned`, see "Final PASS"). A retry assigns the ticket to the new session name. After `passed`, the assignee stays the last session name, as a record, unless a final PASS assigns the ticket to the room lead. The assignment clears `approval_request_id`, as every assignment does. The bridge delivers a `ticket.assigned` from `system` in `context` mode to a stage session, so the new session is not woken: its first message already holds the ticket. Session names are used again, so an old open ticket can still name the same session as assignee. Therefore the Briefing of an agent follows the newest stage row of its session name, in any status. It lists only the ticket of that stage while the ticket is open, else no ticket. A spec-review session gets no ticket list. An agent with no stage row keeps the usual list.

`system` is a reserved name (`RESERVED_NAMES` in `hub/core/ids.ts`). The dispatcher examines the JSON body of every mutating request. When `by`, `from`, `actor`, `voter`, `requester`, `agent` or `creator` is `system` (any case), it returns 400 `the actor 'system' is reserved for the hub`. Nothing is written. Only code in the hub writes events with actor `system`. These are the stage transitions, the launch assignment, the spec-review PASS, the ticket move after a final PASS, the handoff to the Orchestrator after a final failure, and handoff expiry.

### Results

A stage ends with a result handoff from its session. The hub treats a handoff as a result when its `from` is the session of a `running` stage. The hub checks the result before it records the handoff.

| Field | Ticket stage, all roles | `validator` and `reviewer` |
|---|---|---|
| `context.stage_id` | required, the stage's id | required |
| `context.ticket_id` | required, the stage's ticket | required |
| `context.verdict` | — | `"PASS"` or `"FAIL"`, upper case |
| `context.findings` | — | list of `{ticket_id, text}`. Each `ticket_id` and `text` is a non-empty string. The list can be empty. |

Example of a valid Validator result:

```json
{
  "from": "validator-1",
  "to": "Orchestrator",
  "task": "Validation of t_0123456789abcdef",
  "context": {
    "stage_id": "s_0123456789abcdef",
    "ticket_id": "t_0123456789abcdef",
    "verdict": "FAIL",
    "findings": [{ "ticket_id": "t_0123456789abcdef", "text": "The 409 path has no test." }]
  }
}
```

- An invalid result → 400 `{"error": "result rejected", "errors": [...]}`. The hub records no handoff and does not change the stage. The hub also sends a `stage.rejected` entry to the same session. Its `text` field holds the JSON string `{"stage_id": "s_…", "errors": [...]}`. The session stays open and can send the result again.
- A handoff whose `context.stage_id` names a `passed` or `failed` stage → 409 `{"error": "<text>"}`. The hub records no handoff and sends no `stage.rejected`. The hub does this check before the schema check, for every sender. When the sender has a `running` stage, the text is `stage <id> is already <status>. Your running stage is <own id>. Send your result with that stage_id.` Otherwise the text is `stage <id> is already <status>; it takes no more results`.
- A valid result → the hub records the handoff, and the stage moves to `passed` with the verdict (if any). The session stays open until its next end of turn.

**Final PASS.** When a `validator` or `reviewer` stage of a ticket passes with `verdict: "PASS"`, and the ticket is `in_review`, the hub also moves the ticket. It writes the ticket event in the transaction of `stage.passed`, with actor `system`. Both commit or roll back together.

- `blast_radius: low`: one `ticket.done` event. The ticket moves to `done`. The hub then evaluates the tickets that this ticket blocked.
- `blast_radius: high`: one `ticket.assigned` event to the room lead. The hub never writes `done` on a `high` ticket. The assignment clears `approval_request_id`. The lead then asks the human's Allow with `POST /tickets/:id/approval`.

Nothing moves for a FAIL, a spec-review stage, a `worker`, `tester` or `writer` stage, or a ticket that is not `in_review`. Nothing moves for a `high` ticket when the room has no lead (the hub logs one line) or when the lead is already the assignee.

### End of turn, reminders and retries

The bridge of a stage session reads `CUBILOT_STAGE_ID` from its env. At each end of a turn it sends `POST /stages/{id}/turn-end` with `{agent}`. Only the session of that stage may report (403 otherwise). The response is `{"action": "close" | "reminder" | "stop" | "none"}`.

| Situation | Action |
|---|---|
| The stage is `passed` | `close`: the hub queues one close request. |
| First end of turn without a result | `reminder`: the hub sends one `stage.reminder` entry to the session. The stage stays `running`. |
| Second end of turn without a result | `stop`. |
| Other | `none`. |

Every 30 s the hub also checks the stages (a sweep). Each time limit starts when a sweep first sees the stage in that state, not at the spawn or at the result:

- A `running` stage that a sweep saw first more than `stage_timeout_min` ago is a stop.
- A session that left the roster is a stop, when a sweep saw the stage `running` first 90 s or more ago.
- A `passed` stage with no end-of-turn report gets its close 120 s after a sweep saw it first.

These clocks are in memory. A hub restart starts the clocks of the `running` stages again. At hub start, the hub queues a close at once for each `passed` stage whose session no live stage uses. The 120 s grace does not start again.

A stop queues a close for the session and ends the attempt. The reason is in the event payload. Attempt 1 goes to `retrying`. The hub relaunches the stage when the close is acknowledged and a slot is free. The relaunch has the same ticket part and one line with the reason. Attempt 2 goes to `failed`. The hub then sends a handoff from `system` to the room lead (default `Orchestrator`). Its context is `{stage_id, ticket_id, request_id, role, reason}`. An interrupt does not change a stage and does not close its session.

### Spec-review stages

A spec review is a `validator` stage for the plan of one request: its `draft` tickets and its spec. The stage has `review = 'spec'`, `request_id` set and `ticket_id` NULL. Source: `hub/kinds/handoff.ts`, `hub/kinds/stage.ts`. Spec: `openspec/changes/spec-review-stage`.

**Request.** A `POST /handoffs` with `to_role: "validator"`, `review: "spec"` and `request_id` at the top level of the body. The `send_handoff` tool has the same two optional fields.

```json
{
  "from": "Orchestrator",
  "to_role": "validator",
  "review": "spec",
  "request_id": "r-2026-10-24-login",
  "task": "Spec review of the login plan",
  "context": {
    "request_text": "<the human's request>",
    "spec_paths": ["openspec/changes/login/spec.md"],
    "ticket_ids": ["t_0123456789abcdef"],
    "commit": "c9c060f"
  }
}
```

| Field | Rule | Failure |
|---|---|---|
| `review` | Only `"spec"`, and only with `to_role: "validator"`. | 400 |
| `request_id` | Format `^[A-Za-z0-9._-]{1,64}$`. | 400 |
| `context.request_text` | Required. A non-empty string of at most 20 000 characters. | 400 |
| `context.spec_paths` | Optional. A list of non-empty strings. | 400 |
| `context.ticket_ids` | Optional. A list of ticket ids. Each ticket is `draft`, has this `request_id` and is in the sender's room. | 400, the message names the ticket |
| `context.commit` | Optional. A hex commit hash of 7 to 64 characters. | 400 |

The room of the review is the sender's room. The scope is the tickets in `context.ticket_ids`. Without that list, the scope is every `draft` ticket of the request in the room. An empty scope gets 400 `no draft ticket to review in request <id>`. When the handoff has no `commit`, the hub runs `git rev-parse HEAD` in the room's project folder. If the room has a project folder and the command succeeds, the hub records that commit in the stored context. Thus a later commit does not change the review. Otherwise the context has no commit, and the launch uses HEAD at launch time. The hub writes the handoff, then one `stage.queued` event. The scope rows (`stage_scope`) are written in the transaction of that event.

**Launch.** A spec stage uses a slot of the `validator` limit of the room. At most one spec stage of a request is `launching`, `running` or `retrying` in a room. A later one stays `queued` until the live one ends. The worktree is read-only and detached at the recorded commit, under `<app data>/worktrees/<room>/request-<request_id>/<session>`. The launch assigns no ticket, so it writes no `ticket.assigned`. The first message holds the request text, the spec paths and the scope tickets (criteria, `blocked_by`, `blast_radius`). It also holds the worktree, the commit, and the findings of the earlier FAIL results since the last PASS.

**Result schema.** The result is a handoff from the session of the running spec stage. It goes to the room lead (`to` = the lead, default `Orchestrator`).

| Field | Rule |
|---|---|
| `to` | The room lead. |
| `context.stage_id` | The id of the spec stage. |
| `context.review` | `"spec"`. |
| `context.request_id` | The request of the stage. |
| `context.verdict` | `"PASS"` or `"FAIL"`, upper case. |
| `context.findings` | A list of `{ticket_id, severity, text}`. `ticket_id` is a ticket in the scope. `severity` is `blocking` or `suggestion`. `text` is a non-empty string. The list can be empty. |
| `context.questions_for_human` | A list of strings. Required. It can be empty. |
| `context.suggestions` | A list of strings. Required on PASS (it can be empty). Optional on FAIL. |

A PASS with a `blocking` finding is invalid. An invalid result gets 400 and a `stage.rejected` entry, as for a ticket stage. The stage stays `running`.

**PASS.** The hub writes one transaction (`passSpecStage`):

1. `stage.passed` with `verdict = 'PASS'`.
2. One `ticket.queued` event with actor `system` for each scope ticket that is still `draft` and still has this `request_id`.

A scope ticket that moved or left the request after the review started does not move. When the request has a `blast_radius: high` ticket that is not `done` or `cancelled` in the room, the transaction writes only `stage.passed`. The tickets stay `draft`, and the request waits for the human's approval. After the commit, the hub sends a `ticket.promoted` entry for each queued ticket and evaluates the ticket for its stages.

**FAIL.** The hub writes `stage.passed` with `verdict = 'FAIL'`. No ticket moves, and the hub starts no automatic repeat review. The end of the stage can free a `validator` slot for other queued stages. The findings stay in the result handoff to the room lead. The hub counts the FAIL results of the request in the room since its last PASS. From the second FAIL, the hub also sends the human a `ui-only` system entry with the findings of this FAIL. A PASS starts the count again.

**Waiting for approval.** This state is not stored. A request in a room waits for approval when all of these are true:

1. A spec stage of the request has `verdict = 'PASS'`.
2. A scope ticket of that stage is still `draft`, still has this `request_id` and is in the same room.
3. The request has a `blast_radius: high` ticket that is not `done` or `cancelled`.

**Approval route.** `POST /requests/{room}/{request_id}/approve` with body `{"by": "<human name>"}`.

| Condition | Response |
|---|---|
| Bad room label or bad request id | 400 |
| `by` is not the human | 403 `only the human may approve a request` |
| No ticket of the request in the room | 404 |
| Success | 200 `{"room", "request_id", "queued": [ticket ids]}`. The hub adds `"idempotent": true` when no ticket was `draft`. |

The route moves every `draft` ticket of the request in the room to `queued`, not only the scope tickets. It writes one `ticket.queued` event for each ticket in one transaction, with the human as the actor. It then sends a `ticket.promoted` entry for each ticket and evaluates the tickets for their stages. The route does not check that the request waits for approval. Trust is self-asserted, as on every route (see "Identity and trust model").

**The `system` actor.** On the spec-review path, the hub writes `system` for every stage event: the creation (`stage.queued`), the launch, `running`, the retry moves, PASS and FAIL. The PASS transaction also writes each `ticket.queued` with `system`. The approval route writes the human's name. Every mutating route refuses `system` as an actor with 400 (see "Launch ownership and the `system` actor").

### Read routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/stages?status=&role=&limit=` | Bearer header OR `?token=` | List snapshots. `status` is a stage status or `all` (default `queued`). `limit` 1 to 1000, default 100. |
| GET | `/stages/{id}` | Bearer header OR `?token=` | One snapshot, or 404. |
| POST | `/stages/{id}/turn-end` | Bearer header | End-of-turn report of the stage's session (see above). |
| GET | `/requests/{room}/waiting` | Bearer header OR `?token=` | The requests of the room that wait for approval: `{room, waiting: [{request_id, stage_id, high_tickets, draft_tickets}]}`. |
| GET | `/requests/{room}/needs-you` | Bearer header OR `?token=` | The requests of the room with two or more spec FAILs since the last PASS: `{room, requests: [{request_id, fail_count, findings}]}`. The findings come from the latest FAIL, `blocking` first. |
| POST | `/requests/{room}/{request_id}/approve` | Bearer header | The human's approval (see "Spec-review stages"). |

No endpoint directly accepts a stage-create or arbitrary-transition command. A `to_role` handoff (`POST /handoffs`) can create a stage through the evaluator. Some routes cause fixed moves as a result of their input. `POST /launches/{id}/ack` moves `launching` to `running` (or to `retrying` or `failed` on an error). `POST /stages/{id}/turn-end` can move `running` to `retrying` or `failed` (a stop). A valid result handoff moves `running` to `passed`.

### SSE events

- `stage.queued`, `stage.launching`, `stage.running`, `stage.retrying`, `stage.passed`, `stage.failed`: scope `ui-only-ambient`. They go to the UI stream only. They are not in the chat log or the transcript. No agent receives them.
- `stage.reminder`: scope `to-agents`, to the stage's session. The bridge delivers it in `wake` mode.
- `stage.rejected`: scope `to-agents`, to the session that sent the result. The bridge delivers it in `context` mode, because the 400 of the handoff call already told the session.
- Stages are not replayed on reconnect.

## Rooms (v0.9)

A **room** is a first-class routing dimension that lets one hub host multiple
isolated projects in a single window without cross-project context pollution.
Every agent is registered in exactly one room; the human is a super-user in
every room.

### Identity

- Agent room is captured on first `/agent-stream` connect for that agent
  (`&room=<label>` query param, mirrored into each MCP config as
  `CHATBRIDGE_ROOM=<label>`). Room is **immutable** for the lifetime of the
  agent's presence in the hub — reconnects with a different room arg are
  ignored.
- The human's room is `null` in the roster record, which the broadcast layer
  treats as "every room". There is no `CHATBRIDGE_ROOM` equivalent for the
  webview.
- Room labels follow the same charset + length rules as agent names
  (`[A-Za-z0-9_.-]` plus internal spaces, 1..=64 chars).

### Routing scope

For any event from sender `S` targeting room `R`:

```
recipients(event) =
    agents whose room == R           // same-room peers
  ∪ {human}                          // super-user
  ∪ ({event.to} if named peer)       // explicit cross-room
```

`target: "all"` from an agent expands to same-room peers + human. `target: "all"`
from the human requires an explicit `room` in the request body (otherwise "all"
is ambiguous across projects). Explicit `to: "<name>"` always delivers,
crossing rooms when needed — useful for pulling in a reviewer from another
project.

### Per-kind rules

| Kind | Same-room only? | Notes |
|---|---|---|
| `chat` (`/post`, `/send`) | Yes for `target: "all"`; No for named target | Sender's room tagged on entry. |
| `handoff` | Yes (from non-human) | 403 `cross-room handoff not permitted` otherwise. Human is super-user. |
| `interrupt` (single) | Yes (from non-human) | 403 `cross-room interrupt not permitted`. |
| `interrupt` (bulk) | Human-only | `{ from: <human>, rooms: [<labels>], text }`. Fans out one interrupt per non-human agent in each listed room. |
| `permission` request | Fan-out scoped to same room | Peers in other rooms never see the prompt. |
| `permission` verdict | Voter must be same-room or human | 403 `cross-room verdict not permitted` otherwise. |
| `nutshell` | One row per room | Edits propagate to same-room agents live + included in briefing on connect. |

### Nutshell per room

- Table schema: `nutshell(room TEXT PRIMARY KEY, text, version, updated_at_ms, updated_by)`.
- `GET /nutshell?room=<label>` is now required; no-arg returns 400.
- Empty sentinel returned when a room has no row: `{ room, text: "", version: 0, ... }`.
- Edit handoff: `context = { patch: "<text>", room: "<label>" }`. The accept
  path keys the write by that room (the human can target any room;
  non-human senders are restricted to their own).
- `nutshell.updated` SSE carries `room`; channel-bin forwards the update to
  same-room agents live (not just on next reconnect).

### Wire format

Every `/stream` payload and every `<channel>` tag forwarded by channel-bin
now includes a `room` field. The value is:

- The sender's room for agent-originated events.
- The target room for human-originated broadcasts (`/send` `room` body field).
- `null` for strictly global events (roster snapshots, presence).

Channel-bin re-validates `meta.room` against its configured `CHATBRIDGE_ROOM`
on every inbound event, dropping mismatches as defense-in-depth (mirrors the
upstream ["Gate inbound messages"](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)
pattern). Dropped events hit stderr with an explicit mismatch log so a hub
routing bug would show up as a surge, not silent context pollution.

### Handoff gate

`CHATBRIDGE_HANDOFF_GATE=<command>` in an agent's launch environment makes the bridge run the command (`/bin/sh -c`) before `send_handoff` posts to the hub. The command gets `{"tool_name":"mcp__chatbridge__send_handoff","tool_input":{...}}` on stdin, the shape of a Claude Code PreToolUse hook. Exit 2 blocks the handoff, and the command's stderr is the tool error the agent reads. Exit 0 lets it through. Any other result (another exit code, a start failure, no answer within 60 s) is a fault of the gate: the bridge logs it and the handoff goes on. No variable: nothing runs. Both harnesses use it, because plugin hooks do not run for chatbridge tools.

### HTTP

| Method | Path | Purpose |
|---|---|---|
| GET | `/room-default` | Returns `{ room: <CUBILOT_DEFAULT_ROOM> }`; read-auth. Used as fallback when an external-spawn channel-bin has no `CHATBRIDGE_ROOM`. |

### Pause / Resume

A UI affordance on top of the existing `interrupt` primitive — not a new
kind. The Pause button POSTs `/interrupts` with the bulk shape targeting
the selected room, canned text `"Pause — stop current task, hold state,
await resume."`. Resume does the same with the Resume text. Cooperative,
not preemptive — agents finish their current tool call before reading the
card. See [CLAUDE.md → hard rules](../CLAUDE.md) for why bulk targeting is
human-only.

### Agent pause (`POST /agents/<name>/pause`)

Separate from the interrupt-based Pause button above. The human sets it with
`{ "paused": true|false, "by": "<human name>" }`; in memory, per agent object.
While an agent is paused:

- **Its writes that reach others get `423 {"error":"agent is paused"}`:**
  `POST /post`, `/handoffs`, `/interrupts`, and the ticket routes create, claim,
  transition, assign, archive, notes and attachments. Not refused: the
  `ticket:done` approval request, permission requests and verdicts on its own
  requests (a running tool call must not get stuck), and handoff decline, handoff
  cancel and interrupt ack (they only reduce the agent's involvement). Handoff
  accept is refused with 423: taking work is intervening.
- **Nothing from agents reaches it as chat:** broadcasts and direct posts from other
  agents are skipped (`AgentRegistry.enqueueFor`).
- **Structured events still arrive but carry `"paused": true`** (handoff, interrupt, ticket
  kinds; not `permission.*`). The bridge must deliver a `paused` event as `context`,
  never `wake` or `steer`.
- **Only the human lifts it:** the toggle, or a direct human message to the agent.

---

## The briefing (onboarding notification)

When an agent's channel sidecar connects to `/agent-stream` for the first
time during a given hub process lifetime, the hub pushes a single briefing
event to that agent's queue **before** any chat or structured-message
replay. The briefing shape:

```json
{
  "type": "briefing",
  "tools": ["post","post_file","send_handoff","accept_handoff",
            "decline_handoff","cancel_handoff","send_interrupt","ack_interrupt"],
  "peers": [{ "name": "alice", "online": true }, { "name": "human", "online": true }],
  "attachments_dir": "/Users/<you>/cubilot-attachments",
  "human_name": "human",
  "nutshell": "...current nutshell text, or null...",
  "ts": "HH:MM:SS"
}
```

The channel sidecar renders it into a prose paragraph and forwards as a
`notifications/claude/channel` event with `meta.kind="briefing"`. Reconnects
within the same hub process do **not** trigger a new briefing; hub restart
does.

---

## Identity and trust model

Tokens are issued per running hub instance, written to
`~/Library/Application Support/Cubilot/hub.token` (mode `0600`), and
rotated on every app launch and settings reload. The channel-mode sidecar
reads the file on startup, attaches it to every POST, and re-reads on HTTP
401 to handle rotations transparently.

**Trust-on-self-assertion.** The `by` and `from` fields in mutating
requests are validated against the expected actor for each route (recipient
for accept/decline; sender or human for cancel) but are **not**
cryptographically bound to the token — any process holding `hub.token` can
claim any identity. This matches the trust model of the pre-existing
`/post` endpoint.

**The `system` actor.** The hub writes its own events with the actor `system`. Every mutating route refuses `system` as an actor (400). See "Launch ownership and the `system` actor" under the `stage` kind.

**Launch stream.** A holder of `hub.token` can also read `/launches/stream` and acknowledge launch requests. No per-role token exists. This is an accepted risk.

**Hardening target.** Per-sidecar cryptographic identity (one token per
channel-mode sidecar, bound to a specific agent name on issue, verified on
each request) is documented as the next security step. Out of scope for
v0.5.x.

---

## Storage

All handoff state lives in SQLite at
`~/Library/Application Support/Cubilot/ledger.db` (mode `0600`; WAL mode
with sidecar files `.ledger.db-wal` / `.ledger.db-shm` also mode `0600`).

Two tables:

- `events` — append-only. One row per state transition. Columns:
  `seq` (AUTOINCREMENT INTEGER PRIMARY KEY), `handoff_id`, `kind`, `actor`,
  `payload_json`, `at_ms`.
- `handoffs` — derived current state. One row per handoff. Columns mirror
  the snapshot fields above minus `version` (which is computed as
  `MAX(events.seq) WHERE handoff_id = ?` at read time).

**Invariant:** every state transition writes exactly one `events` row and
one `handoffs` row update, wrapped in a single SQLite transaction. Never
bypass the state-machine helpers.

**Schema versioning.** The `meta` table holds `schema_version` (currently
`1`). On startup the hub refuses to run if the ledger file reports a
version newer than it knows — no silent downgrades.

---

## Future kinds

Planned additions. All follow the same event-log-plus-derived-state model
and do not require a schema migration; each new kind adds its own
derived-state table alongside `handoffs`.

| Kind | Intent |
|---|---|
| `proposal` | "I'm about to change X — any objections?" with vote aggregation. |
| `question` | Targeted or open; first answer wins; bounded `answered` state. |
| `review_request` / `review_response` | Structured review with severity-tagged findings. |
| `status` | Non-blocking activity signal ("working on X, ~5 min") surfaced in the presence pill. |
| `decision` | Pinnable, searchable outcome of a discussion. |

None are implemented yet. The handoff pilot proves the pattern.

---

## Wire semantics (clarifications)

These are observable properties of the protocol that consumers often
assume something else about. Stated once here rather than sprinkled through
each kind:

- **Unicode canonicalization.** JSON string escapes in inbound payloads
  (`\uXXXX` form) are canonicalized to literal UTF-8 codepoints before the
  hub persists and broadcasts them. Semantic equality is preserved
  byte-for-byte at the codepoint level; byte-for-byte equality against the
  sender's pre-serialization wire form is not. Consumers wanting
  cross-agent hash integrity must re-serialize with an agreed canonical
  form (e.g. `json.dumps(..., ensure_ascii=False, separators=(",", ":"),
  sort_keys=True)`) before hashing. The hub does not compute or expose a
  canonical hash.
- **Handoff TTL clock.** `expires_at_ms` is set at hub-side creation time
  (when `POST /handoffs` commits), not at the agent's tool-call issuance.
  Permission-prompt latency between the tool call and the hub receiving the
  request does not eat into the TTL budget — which is correct for
  agent-driven senders where human gate latency is outside their control,
  but subtle enough to call out.
- **Race arbitration return shape.** Competing transitions against an
  already-terminal entity (e.g. `cancel_handoff` after `accept_handoff`
  won) return `MCP -32603 / 409 handoff already <status>`. Race loss is
  distinguishable from wire latency via the 409 — consumers can treat 409
  as "peer transitioned first" rather than retrying blindly.
- **Permission-gate serialization of parallel tool calls.** Claude Code's
  local permission UI queues tool-call approvals strictly serially.
  Multiple `send_handoff` calls emitted from a single turn are approved
  one at a time; the sender-side "burst" intent is lost even though the
  hub handles the eventual fan-out concurrently. Not a hub property —
  upstream behavior.
- **Effective `send_handoff.context` ceiling.** The hub enforces a 1 MiB
  JSON-body cap on `/handoffs`. Agent-side, the practical ceiling is well
  below that because the sender must Read the payload into context
  (Read tool: 256 KiB file-size cap AND 25k-token content cap) and re-emit
  it inline as a tool-call argument (bounded by output-token budget).
  Expect ~200 KiB ASCII / ~50 KiB unicode-heavy JSON as the effective
  sender ceiling. To ship payloads at the hub's nominal cap, a
  `context_file_ref` parameter would be needed (not implemented).
- **Pending-entity replay on reconnect.** When an agent connects to
  `/agent-stream`, the hub emits a briefing frame followed by every
  currently-pending `handoff.new`, `interrupt.new`, and `permission.new`
  addressed to or involving the agent (respecting room scope) with
  `meta.replay="true"`. Fresh sessions with no prior conversation context
  can discover their inbox this way — no `list_pending_*` query tool is
  needed. Reconciliation follows the `(id, version)` contract, so replay
  is idempotent.

---

# Terminal pane (v0.7) — out-of-band

The embedded terminal pane introduced in v0.7 is **not part of this protocol**. It's a shell-side surface with no hub involvement:

- The pane lives entirely in the Tauri shell + webview. No new HTTP routes on the hub, no new SSE event kinds, no ledger schema change.
- `claude` processes the pane spawns register with the hub via their own `channel-bin` sidecar, identical to claudes launched from a user's terminal. The hub sees them as normal `agent joined` events; it cannot distinguish Cubilot-pane agents from external ones.
- The tmux socket at `~/Library/Application Support/Cubilot/tmux.sock` is a multi-client shared socket. Anything that can speak tmux (the pane, or a user's external terminal via `tmux -S <sock> attach`) sees the same session state. This is tmux's native behavior; Cubilot doesn't implement any synchronization.

**Practical consequence for protocol design:** adding protocol messages that reference the terminal pane state (e.g., "send this slash-command to agent X") would need to cross the out-of-band boundary. Don't do that — the pane is deliberately segregated so that:

1. Chat/handoff/interrupt/nutshell semantics stay consistent whether the agent runs in the pane or a user's own terminal.
2. The pane can be disabled (header toggle) without affecting any protocol flow.
3. A user who prefers their own terminal never loses access to any coordination feature.

If a future release needs to coordinate claude sessions programmatically (e.g., "restart this agent"), the right protocol shape is a new message kind the agent acts on, not a pane-specific command. v0.8+ scope.

---

# Room transcript persistence (v0.10) — opt-in JSONL

Per-room durable chat history. Off by default; flipped on per room via the settings route. Lives at `~/Library/Application Support/Cubilot/transcripts/<hash8>-<sanitized>.jsonl` (active) plus `<hash8>-<sanitized>.<6-digit-seq>.jsonl` (rotated chunks). Active file rotates at 10,000 lines; rotated chunks are preserved until `clear-transcript`.

**Routes:**

- `GET /rooms/:room/settings` — current opt-in flag plus active-file stats and chunk list. Read-auth.
- `PUT /rooms/:room/settings` — body `{ "persist_transcript": boolean }`. Mutating-auth.
- `GET /rooms/:room/transcripts` — `{ active: { path, lines, sizeBytes }, chunks: [{ seq, path, sizeBytes }], totalBytes }`. Read-auth.
- `POST /rooms/:room/clear-transcript` — deletes active + every rotated chunk for the room, atomically filters chatLog. Mutating-auth.

**Line schema (JSONL):** `{"v": 1, ...Entry}`. The `v` field is mandatory; readers tolerate higher versions by skipping with one warning per file. Truncated final lines (crash mid-write) are silently dropped; mid-file parse errors throw.

**Hub restart hydration:** on startup, opted-in rooms have their **active chunk** tail-loaded into `chatLog` (rotated chunks are NOT loaded). Subsequent SSE replay on `/stream` covers the hydrated entries.

**SQLite invariant:** `room_settings` (added in ledger schema v8) holds the opt-in flag only; rotation size is a code-level constant (`ROTATION_LINES = 10_000`). Kinds (`handoff`, `interrupt`, `permission`, `nutshell`) remain exclusively in SQLite — the JSONL never carries kind state, only chat entries.
