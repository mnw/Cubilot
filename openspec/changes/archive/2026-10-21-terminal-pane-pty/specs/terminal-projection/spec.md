## ADDED Requirements

### Requirement: Agents enter the terminal pane via explicit or reactive creation

The UI SHALL support two entry paths for an agent to appear as a tab in the terminal pane:

1. **Explicit:** a `+ New agent` control in the tab strip opens a modal requesting an agent name (validated against `AGENT_NAME_RE`) and a working directory (native directory picker). On submit, Cubilot generates the per-agent MCP config (per the MCP config requirement below), spawns the tmux session with `--mcp-config <path>`, allocates the PTY, and the tab renders claude's startup.
2. **Reactive:** when the hub's roster gains a new agent (because a `channel-bin` sidecar registered from a `claude` session the user started outside Cubilot), the UI SHALL add a tab for that agent in an `external` state. The tab is display-only: no xterm is mounted and no PTY is owned by Cubilot.

An agent MAY transition between states:

- `external` → `live` when the user explicitly launches a session inside Cubilot for that agent name (this spawns a new tmux session; the user is responsible for quitting any previously-running external claude to avoid channel-bin collisions).
- `live` → tab-removed when the session is killed (via the tab × control, via external `tmux kill-session`, via claude `/exit`, or because claude crashes). There is no intermediate `dead` state; `pty://exit/<agent>` fires and the UI removes the tab. If the agent remains in the hub roster after, the next reconcile re-surfaces it as `external`.

#### Scenario: Explicit agent creation

- **GIVEN** the roster is empty (only the human)
- **WHEN** the user clicks `+ New agent`, enters name `alice`, picks cwd `/code/project-alice`
- **THEN** Cubilot writes the per-agent MCP config at `~/Library/Application Support/Cubilot/mcp-configs/alice.json`
- **AND** a tmux session named `alice` is created on the shared socket with claude as its first command
- **AND** a tab for `alice` appears in the pane in the `live` state with an xterm attached to the PTY
- **AND** within a few seconds `channel-bin` (spawned by claude via `.mcp.json`) registers `alice` with the hub and the legend pill turns online

#### Scenario: Reactive agent creation

- **GIVEN** the user has a pre-existing `.mcp.json` in `/code/project-bob` with `CHATBRIDGE_AGENT=bob` and runs `claude` from Terminal.app in that directory
- **WHEN** `channel-bin` registers `bob` with the hub
- **THEN** the hub broadcasts a roster update
- **AND** a tab for `bob` appears in the terminal pane in the `external` state
- **AND** the tab shows a status line indicating the agent is running outside Cubilot
- **AND** no xterm is mounted for that tab and Cubilot does NOT own a PTY for `bob`

### Requirement: Terminal pane state reconciles with tmux's actual session set

The UI SHALL reconcile its tab strip against `pty_list()` on each of: pane toggle (off→on), every 5 seconds while the pane is visible, and after any `pty_kill` or `pty_spawn` completes. Tabs for sessions that no longer exist in tmux SHALL be removed; sessions present in tmux but absent from the UI SHALL appear as tabs.

The tab strip SHALL also merge the hub's `knownAgents` roster so agents whose tmux session has not been launched yet appear as tabs with a "Launch" affordance.

#### Scenario: External kill is reflected in the UI

- **GIVEN** the `alice` tab is visible
- **WHEN** the user runs `bundled-tmux -S <sock> kill-session -t alice` from Terminal.app
- **THEN** within 5 seconds the UI detects `alice` is gone from `pty_list()`
- **AND** the tab is removed (or transitions to the "Launch" state if `alice` is still in `knownAgents`)

#### Scenario: Roster member with no terminal session

- **GIVEN** the hub's roster contains `bob` but no tmux session exists for `bob`
- **WHEN** the user opens the terminal pane
- **THEN** a `bob` tab appears with a "Launch" button
- **AND** clicking "Launch" invokes `pty_spawn(agent="bob", cwd=<chosen>)` and the tab switches to the attached state
