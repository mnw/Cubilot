## MODIFIED Requirements

### Requirement: Cubilot bundles tmux and orchestrates one session per agent

A static tmux binary for `aarch64-apple-darwin` SHALL be bundled under `src-tauri/resources/tmux` and packaged into `Cubilot.app/Contents/Resources/`. Cubilot SHALL invoke the bundled tmux binary against its shared socket to start a detached session named `<agent-name>` in a user-chosen working directory. For a Claude agent the session's command SHALL be `CHATBRIDGE_AGENT='<name>' CHATBRIDGE_ROOM='<room>' claude [--continue|--resume] --plugin-dir '<bundled chatbridge mod>' --allowed-tools '<chatbridge tools>'`; it SHALL NOT include `--dangerously-load-development-channels`, and it SHALL include `--mcp-config '<generated global-servers file>'` only when the user has global MCP servers (never the chatbridge). For a pi agent the command is unchanged.

Session names SHALL match the agent name exactly (validated against the hub's `AGENT_NAME_RE`). The session is created in detached mode; Cubilot does not attach as a controlling client at spawn time.

#### Scenario: New terminal session for a Claude agent

- **GIVEN** no tmux session named `alice` exists
- **WHEN** the user spawns Claude agent `alice` in room `eu-space`
- **THEN** Cubilot spawns the bundled tmux binary with `new-session -d -s alice` targeting its socket
- **AND** tmux runs a command containing `CHATBRIDGE_AGENT='alice'`, `CHATBRIDGE_ROOM='eu-space'` and `--plugin-dir`
- **AND** the command does not contain `--dangerously-load-development-channels`
- **AND** any `--mcp-config` it contains names the generated global-servers file
- **AND** Cubilot does NOT kill the session when the app exits

#### Scenario: No confirm prompt to dismiss

- **WHEN** a Claude agent's session starts
- **THEN** Cubilot sends no keystrokes to the session on the agent's behalf

#### Scenario: Agent name invalid for session creation

- **WHEN** the user attempts to open a terminal for an agent whose name contains `/` or `:`
- **THEN** Cubilot refuses with an error
- **AND** no tmux invocation occurs
