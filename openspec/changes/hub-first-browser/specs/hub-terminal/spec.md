## ADDED Requirements

### Requirement: The hub owns the tmux sessions
The hub SHALL create, list, check and kill the agent and shell tmux sessions on `<app data>/tmux.sock`. A new session SHALL use `new-session -d -x 80 -y 24`, the command as ONE `$SHELL -ic` argv element, `LANG` and `LC_ALL` set to a UTF-8 locale on `new-session` and on `attach`, and `remain-on-exit off`. The hub SHALL NOT kill a session when it exits. A session name SHALL match the agent name rule; an invalid name SHALL be refused before any tmux call.

#### Scenario: Blank locale
- **GIVEN** the hub's env has empty `LANG` and `LC_ALL`
- **WHEN** the hub creates session `w1`
- **THEN** the `new-session` call carries `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8`

#### Scenario: Hub exit keeps sessions
- **GIVEN** session `w1` runs
- **WHEN** the hub process ends
- **THEN** `tmux has-session -t =w1` succeeds

#### Scenario: Invalid name
- **WHEN** a launch names session `a/b`
- **THEN** the hub refuses it with 400 and makes no tmux call

### Requirement: The hub executes its own launch queue
The hub SHALL run each `launch`, `close` and `input` request of its launch queue itself and record the same ack it records today. A Claude launch SHALL carry `--plugin-dir <staged mod>`, `--allowed-tools <chatbridge tools>` and `--settings <path>`, and `CUBILOT_STAGE_ID` only for a stage session. The shell SHALL NOT read `/launches/stream`.

#### Scenario: Stage launch
- **WHEN** the hub queues a Validator stage launch
- **THEN** a tmux session with the stage's session name runs a command with `--plugin-dir`, `--allowed-tools`, `--settings` and `CUBILOT_STAGE_ID=<stage id>`, and the launch is acked

#### Scenario: Input to one session
- **WHEN** the hub queues `input {session: "orch", text: "/clear"}`
- **THEN** the text reaches session `orch` and no other session

### Requirement: Turn capture is one hub primitive
The hub SHALL provide the turn capture, the tap read, the capture read and the geometry heal that `pty.rs` provides today, with the same results. The turn capture SHALL be the single TUI capture primitive.

#### Scenario: Turn capture
- **GIVEN** session `w1` prints a reply and returns to its prompt
- **WHEN** the UI asks for a turn capture of `w1` with input `/cost`
- **THEN** the hub returns the text printed between the input and the prompt

### Requirement: The terminal stream is a WebSocket
The hub SHALL serve `GET /terminal/<agent>` as a WebSocket to a human caller. Output SHALL be binary frames of the raw PTY bytes. A viewer SHALL be read-only by default and SHALL NOT change the session size. Input or resize from a read-only viewer SHALL be dropped and answered with `read-only`. An agent caller SHALL get 403.

#### Scenario: Read-only viewer
- **GIVEN** a viewer opened `/terminal/w1` and did not take control
- **WHEN** it sends input `ls\r`
- **THEN** the session receives nothing and the viewer gets `{"t":"error","e":"read-only"}`

#### Scenario: Phone does not resize
- **GIVEN** the desktop viewer has control at 120×40
- **WHEN** a read-only phone viewer opens `/terminal/w1` at 40×20
- **THEN** the session stays 120×40

### Requirement: Take control and Hand back
A viewer SHALL get input and size with "Take control". One viewer SHALL have control of an agent at a time; a second Take control SHALL move control and tell the first viewer. "Hand back", or the close of the controller's socket, SHALL end control.

#### Scenario: Control moves
- **GIVEN** viewer A has control of `w1`
- **WHEN** viewer B takes control
- **THEN** B's input reaches `w1`, and A gets `{"t":"control","by":"other"}` and is read-only

### Requirement: The hub holds entries for an agent under human control
While the human has control of an agent, the hub SHALL hold every new entry for that agent (messages, handoffs, interrupts, ticket events) and SHALL deliver them in order at Hand back. `/agents` and `/presence` SHALL show the held count. A held list SHALL drop its oldest entry at the queue cap.

#### Scenario: Held message
- **GIVEN** the human has control of `w1`
- **WHEN** agent `orch` sends a message to `w1`
- **THEN** `w1` gets nothing, and `/agents` shows `held: 1` for `w1`
- **WHEN** the human hands back
- **THEN** `w1` gets the message and `held` is 0

### Requirement: The composer's slash mode writes through the hub
The hub SHALL accept one-shot input for an agent's PTY from a human caller (the chat composer in slash mode) without Take control. A session caller SHALL get 403 `remote input off` while terminal input from sessions is off. An agent caller SHALL get 403.

#### Scenario: Slash command from the composer
- **WHEN** the human sends `/cost` to `w1` from the composer in the desktop window
- **THEN** `/cost\r` reaches the `w1` PTY once
