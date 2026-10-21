## ADDED Requirements

### Requirement: Bridge delivers the briefing as context

The bridge core SHALL recognize `type="briefing"` events on the agent stream and deliver them in `context` mode, rendered once in the core for every runtime as a human-readable paragraph summarizing the agent's identity and room, the human's name, online and offline peers, the tool inventory, the attachments path, and the room's nutshell, in plain prose so the model can absorb it without parsing JSON.

The bridge SHALL NOT expose the briefing as a chat message and SHALL NOT start a turn for it.

#### Scenario: Agent sees the briefing in its context

- **WHEN** the briefing arrives at the bridge of an idle agent
- **THEN** the agent's context contains a readable paragraph: tools available, who else is in the room, where attachments live, and the current nutshell (if any)
- **AND** no turn starts

#### Scenario: Same briefing text on both runtimes

- **WHEN** a Claude agent and a pi agent connect to the same room
- **THEN** both receive briefing text produced by the same core function

## REMOVED Requirements

### Requirement: Channel sidecar forwards the briefing as a structured MCP notification

**Reason**: The MCP channel sidecar is removed; both runtimes now run the bridge core in-process.
**Migration**: See "Bridge delivers the briefing as context" in this capability.
