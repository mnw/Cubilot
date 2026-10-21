## RENAMED Requirements

- FROM: `### Requirement: Hub pushes a briefing notification on first agent connect`
- TO: `### Requirement: Hub pushes a briefing notification on first agent connect, scoped to the agent's room`

## MODIFIED Requirements

### Requirement: Hub pushes a briefing notification on first agent connect, scoped to the agent's room

The hub SHALL detect the first `/agent-stream` connection for a given agent name within a running hub process and push a single `briefing` event to that agent's queue before any chat or handoff events. "First connection" is defined per hub process (hub restart triggers a fresh briefing).

The briefing shape:
```json
{
  "type": "briefing",
  "room": "neb-2026",
  "tools": ["post", "post_file", "<the tool names of each registered kind>"],
  "peers": [{ "name": "qa", "online": true, "room": "neb-2026" }, { "name": "<human_name>", "online": true, "room": null }],
  "attachments_dir": "/Users/<user>/cubilot-attachments",
  "human_name": "human",
  "nutshell": "auth rework in progress" ,
  "ts": "14:22:03"
}
```

Fields specific to rooms:
- `room` is the connecting agent's room (never `null`; human does not receive briefings of this shape).
- `peers` lists only agents in the same room as the connecting agent, plus the human. Agents in other rooms are omitted.
- `nutshell` is the content of `nutshell(<agent's room>)`, or `null` if that room has no nutshell row yet.

#### Scenario: Briefing includes only same-room peers

- **GIVEN** agents `backend` and `qa` are in room `neb-2026`, agent `marketing` is in room `brand`, and the human is registered
- **WHEN** `backend` connects for the first time during this hub process
- **THEN** the briefing's `peers` lists `qa` (room `neb-2026`) and the human
- **AND** `marketing` is NOT listed

#### Scenario: Briefing nutshell is room-scoped

- **GIVEN** `nutshell('neb-2026').text = "auth rework in progress"` and `nutshell('brand').text = "Q3 launch prep"`
- **WHEN** agent `marketing` in room `brand` connects
- **THEN** its briefing's `nutshell` is `"Q3 launch prep"`
- **AND** does NOT include `"auth rework in progress"`

#### Scenario: Briefing when no nutshell for the agent's room

- **GIVEN** no row exists in `nutshell` for room `brand`
- **WHEN** a first agent in room `brand` connects
- **THEN** the briefing's `nutshell` field is `null`

#### Scenario: Briefing is delivered before any chat message

- **GIVEN** the hub has been running since its last start
- **AND** agent `alice` has not yet connected during this hub lifetime
- **WHEN** `alice`'s channel sidecar connects to `/agent-stream?agent=alice`
- **THEN** the very first event on the SSE stream (after the standard `: connected` preamble) is the `briefing` event
- **AND** any queued chat messages are delivered AFTER the briefing

#### Scenario: Reconnect within same hub process does not re-send briefing

- **GIVEN** `alice` already received a briefing during this hub process
- **WHEN** `alice` disconnects and reconnects
- **THEN** no new briefing is sent
- **AND** the usual replay (pending handoffs, etc.) proceeds as today

#### Scenario: Hub restart triggers a fresh briefing

- **GIVEN** `alice` received a briefing, then the hub restarted
- **WHEN** `alice` connects to the new hub
- **THEN** a fresh briefing is pushed

#### Scenario: Briefing lists the tools of every registered kind

- **WHEN** an agent receives its briefing
- **THEN** `tools` contains `post`, `post_file` and the tool names of each registered kind
- **AND** this includes `ack_permission` from the permission kind

## ADDED Requirements

### Requirement: Per-agent MCP config includes `CHATBRIDGE_ROOM`

The generated per-agent MCP config at `~/Library/Application Support/Cubilot/mcp-configs/<agent>.json` SHALL include `CHATBRIDGE_ROOM` in the `env` block of the chatbridge server entry, alongside the existing `CUBILOT_MODE` and `CHATBRIDGE_AGENT` keys. The value is the agent's room as chosen in the spawn modal (or the git-root basename fallback).

External-spawn agents (launched from the user's own terminal with a hand-edited `.mcp.json` that lacks `CHATBRIDGE_ROOM`) SHALL fall back to the hub's `CUBILOT_DEFAULT_ROOM` env at channel-bin startup. The fallback SHALL be fetched via a new read-auth endpoint `GET /room-default` returning `{ room: "<label>" }`.

#### Scenario: Spawn modal writes MCP config with room

- **GIVEN** the spawn modal's `Room` field is `"neb-2026"` and `Agent` is `"backend"`
- **WHEN** the spawn is executed
- **THEN** the file `mcp-configs/backend.json` contains `"CHATBRIDGE_ROOM": "neb-2026"` in the env block

#### Scenario: External-spawn falls back to default

- **GIVEN** a `.mcp.json` exists in the user's project dir with `CHATBRIDGE_AGENT=legacy` but no `CHATBRIDGE_ROOM`
- **AND** the hub has `CUBILOT_DEFAULT_ROOM=brand`
- **WHEN** claude spawns channel-bin
- **THEN** channel-bin queries `GET /room-default?token=...`
- **AND** registers with the hub as `agent=legacy, room=brand`
