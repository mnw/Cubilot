# terminal-projection Specification

## Purpose
TBD - created by archiving change v06-roadmap. Update Purpose after archive.

## Requirements

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

### Requirement: The webview renders each agent's tmux session in a right-side pane

The webview SHALL provide a vertically-tabbed right-side pane (`xterm.js`-backed) with one tab per active tmux session. Tabs are ordered by agent name. Opening a tab attaches to the session via `tmux -C attach-session -t <agent>` (control mode); the xterm renders output in real time, and keystrokes in the terminal pane are forwarded as `send-keys -t <agent> -l <input>` to the session.

The right pane SHALL be opt-in: a header toggle persists the choice in `localStorage`. Default state is off (chat-only) so existing users don't see a UI change on upgrade.

#### Scenario: User enables the terminal pane

- **WHEN** the user clicks the terminal toggle in the header
- **THEN** the right-side pane appears with one tab per active tmux session
- **AND** selecting a tab attaches to that session and begins streaming output
- **AND** localStorage stores `cubilot_terminal_enabled=true`

#### Scenario: Typing in the pane sends to the session

- **GIVEN** the user has selected the `alice` tab
- **WHEN** the user types `/model` + Enter
- **THEN** `send-keys -t alice -l "/model" Enter` is issued against the tmux socket
- **AND** the session's output echoes the command and Claude's response streams back into the xterm

### Requirement: tmux sessions survive Cubilot restart

tmux sessions are long-lived by design. Cubilot SHALL NOT terminate sessions on app exit, crash, or SIGTERM. On next launch, the webview SHALL query `tmux list-sessions` against the shared socket and populate the tab bar from the result.

#### Scenario: App quit and relaunch preserves the session

- **GIVEN** a tmux session named `alice` is running claude
- **WHEN** the user quits Cubilot and relaunches it
- **THEN** `alice` still exists in tmux
- **AND** enabling the terminal pane shows `alice` as an active tab
- **AND** attaching resumes the session's running claude process with its full scrollback intact

### Requirement: User can still `tmux attach` from their own terminal

The shared socket at `~/.config/Cubilot/tmux.sock` SHALL be documented in the README as a supported attachment point. A user running `tmux -S ~/.config/Cubilot/tmux.sock attach -t <agent>` in their own Terminal.app SHALL be able to interact with the same session concurrently with the Cubilot webview pane.

Multi-client input behavior SHALL follow tmux's native semantics (both clients can type; documented caveat: interactive prompts should be answered from one client at a time).

#### Scenario: External attach works alongside webview attach

- **GIVEN** Cubilot's pane is attached to the `alice` session
- **WHEN** the user runs `tmux -S ~/.config/Cubilot/tmux.sock attach -t alice` in Terminal.app
- **THEN** both clients see identical output
- **AND** keystrokes from either client reach the session's stdin

### Requirement: Explicit kill control per session

Each tab in the right pane SHALL expose an `×` control that, on click, issues `tmux kill-session -t <agent>` and removes the tab. Confirmation is required (custom dialog, not browser `confirm()`).

#### Scenario: User kills a session

- **GIVEN** tab `alice` is visible
- **WHEN** the user clicks the `×` and confirms
- **THEN** `tmux kill-session -t alice` runs
- **AND** the tab disappears from the pane
- **AND** any external `tmux attach -t alice` is disconnected

### Requirement: xterm.js is bundled, not fetched

The `xterm.js` library (ESM single-file build) and its default CSS SHALL be checked into the repository under `ui/vendor/` and loaded by `ui/index.html` via relative paths. No CDN, no bundler. Version pinned and documented in `ui/vendor/README.md`.

#### Scenario: Terminal pane works offline

- **GIVEN** the machine has no network connectivity
- **WHEN** the user opens Cubilot and enables the terminal pane
- **THEN** xterm loads from the local bundle
- **AND** the pane renders and functions identically to the online case

### Requirement: PTY plumbing primitives have integration test coverage

The Rust terminal-projection layer SHALL maintain integration test coverage over the three PTY plumbing primitives that `src-tauri/src/pty.rs` uses for agent and shell tab sessions:

1. **Locale resolution** — the function that resolves UTF-8 locale from the current process env, with fallback to `en_US.UTF-8` when the inherited locale is blank, `C`, or non-UTF-8. This is the primitive that prevents claude's capability probe from downgrading to ASCII output when macOS GUI apps inherit an empty locale from launchd.
2. **Existing-session reconfiguration** — the function that runs `tmux set-option remain-on-exit off` plus a SIGWINCH dimension resize cycle on an attach client, so claude samples correct 80×24 dimensions at startup.
3. **Attach-and-stream** — the function that pairs a PTY master with a Tauri output channel, spawns a reader task, and registers the session in the PtyRegistry. Used by spawn, shell-tab spawn, and attach-on-restart.

Tests MAY exercise these primitives via the `tmux` binary and the test harness directly — they are NOT required to drive pty.rs through a Tauri runtime. The tests cover the PTY / tmux contract that each primitive builds on.

The integration test suite MUST run on `bun test` and MUST NOT require a running Tauri shell.

#### Scenario: Locale resolution with UTF-8 environment

- **GIVEN** the process env has `LANG=en_US.UTF-8` and no `LC_ALL`
- **WHEN** the locale-resolution primitive is called
- **THEN** the return value is `"en_US.UTF-8"`

#### Scenario: Locale resolution with blank environment

- **GIVEN** the process env has empty `LANG` and empty `LC_ALL` (matching the macOS GUI app launchd inheritance case)
- **WHEN** the locale-resolution primitive is called
- **THEN** the return value is `"en_US.UTF-8"`
- **AND** the return value is used to set `LANG` / `LC_ALL` for the child tmux session

#### Scenario: Locale resolution rejects non-UTF-8 locale

- **GIVEN** the process env has `LANG=C`
- **WHEN** the locale-resolution primitive is called
- **THEN** the return value is `"en_US.UTF-8"` (NOT `"C"`)

#### Scenario: tmux session creates and accepts attach

- **GIVEN** a hermetic tmux socket at a PID-scoped path
- **WHEN** the test harness creates a detached tmux session with 80×24 dimensions
- **AND** attaches via `tmux attach-session` with `-e LANG=en_US.UTF-8`
- **THEN** the attach client is connected
- **AND** bytes written to the attach PTY appear in the session's output buffer
- **AND** bytes from the session are readable from the PTY master

#### Scenario: Existing-session reconfiguration clears remain-on-exit

- **GIVEN** an existing tmux session with `remain-on-exit on`
- **WHEN** the session-reconfiguration primitive is called with that session's name
- **THEN** `tmux show-option -g -t <session> remain-on-exit` reports `off`

#### Scenario: Session lifecycle — create, kill, confirm gone

- **GIVEN** a tmux session created by the test harness
- **WHEN** the harness sends `tmux kill-session -t <name>`
- **THEN** `tmux has-session -t <name>` returns a non-zero exit code within 500 ms
- **AND** the PtyRegistry entry (if one was registered) is reclaimable for the same name without collision

#### Scenario: Regression guard — tmux raw-PTY mode vs tmux -C

- **GIVEN** a tmux session attached via the attach-and-stream primitive
- **WHEN** a test writes interactive keystrokes (e.g., arrow keys, `\r`) to the PTY master
- **THEN** the bytes propagate as raw bytes, NOT as tmux control-mode commands
- **AND** no `%output`, `%begin`, `%end` tmux control-mode framing appears in the output stream

This scenario specifically guards against the v0.6 regression class where `tmux -C` was substituted for raw PTY and broke interactive input forwarding. The raw-PTY mode is documented as a hard rule in `CLAUDE.md` and reinforced here at spec level.

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

### Requirement: Agent PTY accepts writes from the chat composer in slash mode

In addition to keystrokes typed inside the focused xterm tab, an agent's PTY master SHALL accept byte writes originating from the chat composer when the composer is in slash mode and addressing that agent. The mechanism is the existing `pty_write(agent: String, b64: String)` Tauri command at `src-tauri/src/pty.rs`. No new Tauri command is introduced.

The PTY does not distinguish input by origin: bytes written from the composer are indistinguishable from bytes typed in the xterm. tmux's normal multi-client semantics apply (concurrent input from multiple sources is supported).

#### Scenario: Composer slash send writes bytes that the xterm immediately echoes
- **GIVEN** the user has the `builder` xterm tab visible and the room composer focused
- **WHEN** the user sends `/clear @builder` from the composer
- **THEN** the `builder` xterm tab shows the typed `/clear` command being processed by claude
- **AND** the bytes were delivered via `pty_write(agent="builder", b64=base64("/clear\r"))`

#### Scenario: External-state agent rejects composer slash sends
- **GIVEN** an agent `bob` is in `external` state (Cubilot does not own its PTY)
- **WHEN** the user attempts `/clear @bob` from the composer
- **THEN** the composer's `@`-popover did not list `bob` as a valid target
- **AND** no `pty_write` invocation for `bob` occurs
