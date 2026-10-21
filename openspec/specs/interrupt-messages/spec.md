# interrupt-messages Specification

## Purpose
TBD - created by archiving change v06-roadmap. Update Purpose after archive.

## Requirements

### Requirement: `interrupt` is a new typed message kind stored in the ledger

The ledger SHALL gain an `interrupts` table keyed by interrupt ID (`i_[0-9a-f]{16}`). Each row stores `{id, from_agent, to_agent, text, status, created_at_ms, acknowledged_at_ms, acknowledged_by}`. Status is one of `"pending"` or `"acknowledged"`; `"acknowledged"` is terminal.

Interrupts SHALL be written via the same event-log pattern as handoffs: one row in the `events` table plus one row/update in `interrupts`, wrapped in a single SQLite transaction.

#### Scenario: Create persists atomically

- **GIVEN** the ledger is enabled
- **WHEN** the hub accepts `POST /interrupts` with `{from: "alice", to: "bob", text: "stop, re-read the spec"}`
- **THEN** exactly one row is inserted into `events` with `kind="interrupt.new"`
- **AND** exactly one row is inserted into `interrupts` with `status="pending"`
- **AND** both writes are in the same transaction (rollback on either failure)

### Requirement: HTTP routes for interrupts mirror handoff conventions and enforce room scope

`POST /interrupts` SHALL create a new interrupt (Bearer auth required, 256 KiB body cap). Two body shapes are accepted:

1. **Single-recipient**: `{ from, to, text }` — the recipient MUST be in the sender's room, UNLESS the sender is the human (who is in every room). A cross-room attempt by a non-human sender returns HTTP 403 `{"error": "cross-room interrupt not permitted"}`. The human may address any agent in any room.
2. **Bulk-by-room**: `{ from, rooms: [<label>...], text }` — only accepted when `from` equals the human_name (only the human may bulk-address rooms). Each listed room generates one interrupt per non-human agent in that room. The response lists the generated interrupt IDs grouped by room.

`POST /interrupts/:id/ack` SHALL transition an interrupt to `acknowledged`. `by` must match `to_agent` or the human name. The acker does not need to be in the same room as the interrupt's originator (the human may ack anywhere; the recipient agent is by definition in the right room).

`GET /interrupts?status=&for=&room=&limit=` SHALL list interrupts; the new `room` filter narrows results to interrupts whose recipient agent was in the given room at ack time.

The terminal-state policy is unchanged: same-status retry → 200 idempotent, different-status retry → 409 conflict, not-recipient → 403, not-found → 404.

#### Scenario: Cross-room interrupt rejected for non-human sender

- **GIVEN** agent `backend` is in room `neb-2026` and agent `marketing` is in room `brand`
- **WHEN** `backend` POSTs `/interrupts` with `{from: "backend", to: "marketing", text: "..."}`
- **THEN** the response is 403 `{"error": "cross-room interrupt not permitted"}`
- **AND** no ledger row is written

#### Scenario: Human crosses rooms freely

- **WHEN** the human POSTs `/interrupts` with `{from: "<human_name>", to: "marketing", text: "..."}` regardless of marketing's room
- **THEN** the interrupt is created normally

#### Scenario: Bulk shape rejects non-human sender

- **WHEN** agent `backend` POSTs `/interrupts` with `{from: "backend", rooms: ["neb-2026"], text: "..."}`
- **THEN** the response is 403 `{"error": "bulk interrupt restricted to human"}`

#### Scenario: Bulk shape fans out per agent

- **GIVEN** room `neb-2026` contains agents `backend` and `qa`
- **WHEN** the human POSTs `/interrupts` with `{from: "<human_name>", rooms: ["neb-2026"], text: "Pause..."}`
- **THEN** two interrupts are created, one addressed to `backend`, one to `qa`
- **AND** each has its own ID, ledger row, and `interrupt.new` event

#### Scenario: Recipient acks a pending interrupt

- **GIVEN** interrupt `i_abc…` has `status="pending"` and `to_agent="bob"`
- **WHEN** `POST /interrupts/i_abc.../ack` arrives with `{by: "bob"}`
- **THEN** the response is 200 with `{snapshot: {..., status: "acknowledged", ...}}`
- **AND** a `events.kind="interrupt.ack"` row is written
- **AND** an SSE event `interrupt.ack` is broadcast to the UI

#### Scenario: Non-recipient cannot ack

- **GIVEN** interrupt `i_abc…` has `to_agent="bob"`
- **WHEN** `POST /interrupts/i_abc.../ack` arrives with `{by: "alice"}`
- **THEN** the response is 403 with `{error: "not the recipient"}`
- **AND** no events or status changes occur

#### Scenario: Ack of already-acknowledged interrupt is idempotent

- **GIVEN** interrupt `i_abc…` has `status="acknowledged"` and `acknowledged_by="bob"`
- **WHEN** `POST /interrupts/i_abc.../ack` arrives with `{by: "bob"}`
- **THEN** the response is 200 with `{snapshot: ..., idempotent: true}`
- **AND** no new events are written

### Requirement: UI renders interrupts as high-visibility cards

The webview SHALL render interrupts as cards distinct from handoff cards — larger, red-accented border, and sticky to the top of the message area until acknowledged. When the human is the recipient, the card SHALL display an "Acknowledge" button that calls `POST /interrupts/:id/ack` with `by=HUMAN_NAME`. The human MAY also compose interrupts via a header button or `@` command.

#### Scenario: Human acknowledges via UI

- **GIVEN** an interrupt targeting the human is displayed in the UI
- **WHEN** the human clicks "Acknowledge"
- **THEN** a POST to `/interrupts/:id/ack` is sent with `{by: HUMAN_NAME}`
- **AND** on success, the card transitions to a muted "acknowledged" state and un-sticks from the top

### Requirement: Interrupts are a coordination primitive, not a hard preemption

Interrupts SHALL NOT preempt or cancel an agent's in-flight LLM turn. The hub SHALL NOT assume any behavioral guarantee from recipient agents beyond "the notification is delivered." The coordination value derives from:

- The distinct channel notification kind (`interrupt.new`) that agents can be prompted to react to.
- The visible, persistent UI card that prevents the human from missing the signal.
- The acknowledgement protocol that lets senders track whether the message was seen.

The README and the onboarding briefing SHALL state this explicitly — interrupts depend on cooperative agents.

#### Scenario: Agent ignores interrupt

- **GIVEN** an interrupt is delivered to agent `bob`
- **WHEN** `bob`'s model does not call `ack_interrupt`
- **THEN** the interrupt stays `pending` until the sender's patience runs out
- **AND** the hub takes no action beyond delivery

### Requirement: Agents receive interrupts in steer mode and expose `ack_interrupt`

The bridge core SHALL deliver `interrupt.new` events arriving via `/agent-stream` in `steer` mode, with an envelope carrying `from`, `kind` (`"interrupt.new"`) and `interrupt_id`, followed by the interrupt text. The bridge SHALL expose a tool `ack_interrupt(interrupt_id)` that POSTs to `/interrupts/:id/ack`.

Agents SHALL also expose `send_interrupt(to, text)` to initiate interrupts toward peers or the human. Payload cap: 500 chars for `text`.

#### Scenario: Agent receives and acknowledges

- **GIVEN** agent `bob` is connected to `/agent-stream`
- **WHEN** `alice` sends an interrupt to `bob`
- **THEN** `bob` receives a delivery whose first line is `[chatbridge id=<n> from="alice" to="bob" room="<room>" kind="interrupt.new" interrupt_id="i_..."]` followed by the text
- **AND** `bob` can call `ack_interrupt({interrupt_id: "i_..."})`
- **AND** the hub transitions the interrupt to `acknowledged`

#### Scenario: Interrupt lands in a running turn

- **GIVEN** `bob` is mid-turn
- **WHEN** `alice` sends `bob` an interrupt
- **THEN** the interrupt is in `bob`'s context before the turn's next model request

### Requirement: Interrupt SSE events carry the room attribute

Every `interrupt.new`, `interrupt.ack`, and `interrupt.*` event broadcast on `/stream` SHALL include a top-level `room` field equal to the recipient agent's room (for single-recipient interrupts) or the target room (for bulk shape). This allows the UI room switcher to filter interrupt cards without needing to cross-reference the roster.

Channel-bin forwarding interrupts to a claude session SHALL pass `room` as a `<channel>` meta attribute, enabling channel-bin's room-gate (see `rooms` capability) to reject cross-room leakage as defense-in-depth.

#### Scenario: Interrupt events tagged with room

- **WHEN** an interrupt is created for agent `qa` in room `neb-2026`
- **THEN** the `/stream` SSE payload includes `"room": "neb-2026"`
- **AND** the `/agent-stream` forwarding to `qa` includes the same `room` attribute
