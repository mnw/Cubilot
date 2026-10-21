## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Agents receive interrupts as channel notifications and expose `ack_interrupt`

**Reason**: MCP channel notifications are no longer the delivery path.
**Migration**: See "Agents receive interrupts in steer mode and expose `ack_interrupt`".
