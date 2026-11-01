## MODIFIED Requirements

### Requirement: The webview renders each agent's tmux session in a right-side pane

The webview SHALL provide a vertically-tabbed right-side pane (`xterm.js`-backed) with one tab per active tmux session. Tabs are ordered by agent name. Opening a tab SHALL open the hub's terminal WebSocket `/terminal/<agent>`; the xterm renders the raw PTY bytes in real time. The tab SHALL be read-only until the human uses "Take control"; then keystrokes in the pane SHALL go to the hub as input frames, which the hub writes to the PTY as raw bytes. The pane SHALL work the same in the desktop window and in a browser.

The right pane SHALL be opt-in: a header toggle persists the choice in `localStorage`. Default state is off (chat-only) so existing users don't see a UI change on upgrade.

#### Scenario: User enables the terminal pane

- **WHEN** the user clicks the terminal toggle in the header
- **THEN** the right-side pane appears with one tab per active tmux session
- **AND** selecting a tab opens `/terminal/<agent>` and begins streaming output
- **AND** localStorage stores `cubilot_terminal_enabled=true`

#### Scenario: Typing in the pane sends to the session

- **GIVEN** the user has selected the `alice` tab and has taken control
- **WHEN** the user types `/model` + Enter
- **THEN** the bytes `/model\r` reach the `alice` PTY as raw bytes
- **AND** the session's output echoes the command and Claude's response streams back into the xterm

#### Scenario: Typing before Take control

- **GIVEN** the user has selected the `alice` tab and has not taken control
- **WHEN** the user types `x`
- **THEN** nothing reaches the `alice` session and the pane shows that it is read-only

### Requirement: PTY plumbing primitives have integration test coverage

The hub's terminal layer SHALL maintain integration test coverage over the three PTY plumbing primitives that it uses for agent and shell tab sessions:

1. **Locale resolution** — the function that resolves UTF-8 locale from the current process env, with fallback to `en_US.UTF-8` when the inherited locale is blank, `C`, or non-UTF-8. This is the primitive that prevents claude's capability probe from downgrading to ASCII output when the hub inherits an empty locale from launchd.
2. **Existing-session reconfiguration** — the function that runs `tmux set-option remain-on-exit off` plus a SIGWINCH dimension resize cycle on an attach client, so claude samples correct 80×24 dimensions at startup.
3. **Attach-and-stream** — the function that opens a PTY on `tmux attach` for one viewer and streams its bytes to the terminal WebSocket. Used by agent tabs, shell tabs and reconnects after a hub restart.

Tests SHALL exercise these primitives through the hub's code and the `tmux` binary. The integration test suite MUST run on `bun test` and MUST NOT require a running Tauri shell.

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
- **WHEN** the hub creates a detached tmux session with 80×24 dimensions
- **AND** attaches via `tmux attach-session` with `-e LANG=en_US.UTF-8`
- **THEN** the attach client is connected
- **AND** bytes written to the attach PTY appear in the session's output buffer
- **AND** bytes from the session are readable from the PTY

#### Scenario: Existing-session reconfiguration clears remain-on-exit

- **GIVEN** an existing tmux session with `remain-on-exit on`
- **WHEN** the session-reconfiguration primitive is called with that session's name
- **THEN** `tmux show-option -g -t <session> remain-on-exit` reports `off`

#### Scenario: Session lifecycle — create, kill, confirm gone

- **GIVEN** a tmux session created by the hub
- **WHEN** the hub kills it
- **THEN** `tmux has-session -t <name>` returns a non-zero exit code within 500 ms
- **AND** a new session of the same name can be created without collision

#### Scenario: Regression guard — tmux raw-PTY mode vs tmux -C

- **GIVEN** a tmux session attached via the attach-and-stream primitive
- **WHEN** a test writes interactive keystrokes (e.g., arrow keys, `\r`) to the PTY
- **THEN** the bytes propagate as raw bytes, NOT as tmux control-mode commands
- **AND** no `%output`, `%begin`, `%end` tmux control-mode framing appears in the output stream

This scenario guards against the v0.6 regression class where `tmux -C` was substituted for raw PTY and broke interactive input forwarding. It stays unless the terminal transport test (capability `terminal-transport-test`) picks control mode and the human changes the hard rule.
