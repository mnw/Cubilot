## ADDED Requirements

### Requirement: The human and the agents have different tokens
The agent token SHALL stay in `<app data>/hub.token`. The desktop window SHALL get a separate human token that the shell gives the hub on stdin and the window through `get_hub_url`. The human token SHALL NOT be written to a file or put in a process environment. A browser SHALL be a human caller only with a valid session.

#### Scenario: Token file is the agent token
- **WHEN** the app starts
- **THEN** the token in `hub.token` differs from the token `get_hub_url` returns, and no file under `<app data>` holds the human token

### Requirement: A human action takes its identity from the caller
The hub SHALL refuse with 403 a request with the agent token whose body names `human_name` in `by`, `from`, `actor`, `voter`, `requester`, `agent` or `creator`. For a human caller the hub SHALL use `human_name` as the acting name of `by` and `from`, whatever they hold. Fields that name a target (for example `agent` on `/remove`) SHALL keep their value.

#### Scenario: Agent sends by the human (brief test 6)
- **WHEN** a request with the agent token and `by: <human_name>` reaches the Approve route of a request
- **THEN** the hub returns 403 and the request stays not approved

#### Scenario: Agent sends a chat as the human
- **WHEN** `POST /send` with the agent token has `from: <human_name>`
- **THEN** the hub returns 403 and no entry is written

### Requirement: Human-only routes refuse the agent token
The routes that only the human may call SHALL return 403 to the agent token, also without a `by` field: Approve, Allow and permission verdicts, decision answers, checkpoint create, radius lower below the rule, room settings, Pause room and agent pause, launch, kill and remove of agents and sessions, the launch stream and acks, settings writes, sign-in, devices and pairing. The arbiter's rulings and overrule SHALL get the same rule when they land.

#### Scenario: Remove agent with the agent token
- **WHEN** `POST /remove` arrives with the agent token
- **THEN** the hub returns 403 and the agent stays on the roster

#### Scenario: Pause with the agent token
- **WHEN** `POST /agents/w1/pause` arrives with the agent token
- **THEN** the hub returns 403

### Requirement: An agent token never opens the UI and a UI session never gets agent tools
The UI files, `/stream` and `/terminal/<agent>` SHALL return 403 to the agent token. `/agent-stream` SHALL return 403 to a human caller.

#### Scenario: Agent token on the UI stream
- **WHEN** `GET /stream?token=<agent token>` arrives
- **THEN** the hub returns 403

#### Scenario: Session on the agent stream
- **WHEN** a signed-in browser opens `/agent-stream?agent=x`
- **THEN** the hub returns 403 and `x` is not registered
