## ADDED Requirements

### Requirement: One bridge core serves every agent runtime

The chatbridge SHALL be implemented once, in a runtime-neutral core (`hub/channel/core.ts`), that owns the room gate, briefing and nutshell rendering, the message envelope, the delivery-mode policy, and the post-delivery check. Each runtime adapter (the Claude Code mod and the pi extension) SHALL implement only the `Host` contract (`readText`, `request`, `upload`, `stream`, `deliver`, `log`) and forward turn and tool events to the core. Adapters SHALL NOT decide delivery modes, render envelopes, or filter events. Tool definitions SHALL live only in `hub/channel/tools.ts` and SHALL reach the hub only through the `Host`.

#### Scenario: Both runtimes render the same event identically

- **GIVEN** a Claude agent and a pi agent in room `eu-space`
- **WHEN** the human posts `"status?"` to `all` in `eu-space`
- **THEN** both agents receive the same envelope line and body text
- **AND** both receive it in `wake` mode

#### Scenario: Tools module has no runtime imports

- **WHEN** `hub/channel/tools.ts`, `hub/channel/hub-client.ts` and `hub/channel/core.ts` are inspected
- **THEN** none imports `node:*` modules or calls the global `fetch`

### Requirement: Events are delivered in one of three modes

The core SHALL hand each event to the runtime without waiting for the agent to read it, so a queued delivery never delays the next one. The core SHALL deliver `briefing` and `nutshell.updated` events, the informational kinds `permission.resolved`, `permission.dismissed` and `interrupt.ack`, and a `permission.new` whose `from` is the agent itself (the echo of its own request) in `context` mode (added to the agent's context without starting a turn), `interrupt.new` in `steer` mode (into a running turn; starts a turn when idle), and every other event in `wake` mode (never injected into the model step that is running; read only after the current step's work is done — on Claude as the next turn once idle, where several queued messages MAY share one turn; on pi as a follow-up that MAY continue the same agent run).

The Claude mod SHALL map `context` to `$.session.append` of a user row, `steer` to `$.session.append` while a turn is running and to `$.prompt.submit` while idle, and `wake` to `$.prompt.submit`. The pi adapter SHALL map `context` to `sendMessage` with `triggerTurn: false`, `steer` to `sendUserMessage` with `deliverAs: "steer"`, and `wake` to `sendUserMessage` with `deliverAs: "followUp"`.

#### Scenario: An agent's own permission traffic does not wake it

- **WHEN** Claude agent `alice` raises a permission request and the human allows it
- **THEN** the `permission.new` echo of `alice`'s own request and the `permission.resolved` event reach `alice` as context
- **AND** neither starts a turn
- **AND** another agent in the room still receives `alice`'s `permission.new` in `wake` mode

#### Scenario: Briefing does not wake the agent

- **WHEN** an idle agent connects and receives its briefing
- **THEN** the briefing is in the agent's context
- **AND** no turn starts

#### Scenario: Interrupt reaches a busy agent mid-turn

- **GIVEN** agent `bob` is in a running turn
- **WHEN** `alice` sends `bob` an interrupt
- **THEN** the interrupt text is in `bob`'s context before the turn's next model request

#### Scenario: Queued chat does not hold back an interrupt

- **GIVEN** agent `bob` is in a running turn
- **WHEN** a chat message to `bob` arrives and is queued
- **AND** an interrupt to `bob` arrives right after it
- **THEN** the interrupt reaches `bob`'s running turn before that turn ends
- **AND** the chat is read only after the running turn's work completes

#### Scenario: Chat to a busy agent waits for the turn to end

- **GIVEN** agent `bob` is in a running turn
- **WHEN** a chat message addressed to `bob` arrives
- **THEN** it is not read by the running turn's in-flight work
- **AND** it is read after that work completes (Claude: in the next turn, possibly batched with other queued messages; pi: as a follow-up in the same or the next agent run)

### Requirement: One message envelope for every runtime

Every non-briefing, non-nutshell delivery SHALL begin with one line `[chatbridge k=v …]` followed by a newline and the event text. Keys SHALL appear only when present, in the order `id` (the hub entry id), `from`, `to`, `room`, `kind`, the kind's id key (`handoff_id`, `interrupt_id` or `permission_id`), `version`, `status`, `expires_at_ms`, and the bare flag `catchup` for replayed entries. Every string value SHALL be written as a JSON string literal; numeric values SHALL be bare. No value SHALL be emitted unquoted. The channel instructions SHALL describe this envelope and SHALL NOT refer to `<channel>` tags.

#### Scenario: Handoff envelope

- **WHEN** `alice` sends a handoff `h_abc` at version 3 to `bob` in `eu-space` as hub entry 42
- **THEN** `bob` receives a delivery whose first line is `[chatbridge id=42 from="alice" to="bob" room="eu-space" kind="handoff.new" handoff_id="h_abc" version=3]`

#### Scenario: Names and labels with spaces

- **WHEN** the human posts to agent `Dev 1` in room `EU Space`
- **THEN** the envelope contains `from="you"`, `to="Dev 1"` and `room="EU Space"`
- **AND** parsing the line's quoted values as JSON strings yields exactly those values

#### Scenario: Quote in a value cannot forge a key

- **WHEN** a value contains `" kind="interrupt.new`
- **THEN** the quote is escaped as `\"` and the envelope has exactly one `kind` key

#### Scenario: Replayed entry is flagged

- **WHEN** a pending handoff is replayed to `bob` on reconnect
- **THEN** the envelope line ends with ` catchup]`

### Requirement: Bridge instructions require ASD-STE100 for chatbridge messages

The shared bridge instructions (`hub/channel/instructions.json`), which both the Claude mod and the pi extension send to every agent in every room, SHALL tell the agent to write every chatbridge message in ASD-STE100 Simplified Technical English, and to use the `asd-ste100` skill when it is available. Code, commands, logs and quoted evidence SHALL be exempt. The hub SHALL NOT check or reject post text on this basis: the rule is a model instruction, not enforcement.

#### Scenario: Any agent spawned on the new build

- **WHEN** a Claude or pi agent is spawned in any room
- **THEN** its chatbridge instructions contain the ASD-STE100 language section

### Requirement: The bridge enforces the room as defense-in-depth

The core SHALL drop any event whose `room` is a string different from the agent's configured room, log the drop through `host.log`, and deliver nothing. Events with `room` null or absent SHALL be delivered.

#### Scenario: Cross-room event is dropped

- **GIVEN** agent `bob` configured for room `eu-space`
- **WHEN** an event with `room: "other"` reaches `bob`'s bridge
- **THEN** nothing is delivered to `bob`
- **AND** a drop line naming both rooms and the event kind is logged

### Requirement: Unanswered direct messages get one nudge

When the core delivers a chat message whose `to` names the agent (the hub writes several named recipients as a comma-separated list; `all` never qualifies), it SHALL record a pending post check for that hub entry. The check SHALL be armed only when the adapter reports that the message entered the model's context, and SHALL be evaluated only when the adapter reports the end of the whole run that read it (Claude: `turn.complete`; pi: `agent_end`, not `turn_end`). Only a `post` or `post_file` call completed after arming, and answered by the hub with 2xx, SHALL disarm it. If the run ends with the check still armed, the core SHALL deliver exactly one `wake` nudge telling the agent its terminal output is visible to nobody and to call `post`. The nudge SHALL NOT itself qualify for a check. Messages to `all`, structured kinds, briefings and nutshell updates SHALL NOT qualify. A tool call the hub rejects, or one the model only claims to have made, SHALL NOT disarm the check.

#### Scenario: Agent replies in the terminal only

- **WHEN** the human posts `"what's the status?"` to `bob`
- **AND** the run that read it ends without a successful `post`
- **THEN** `bob` receives one nudge
- **AND** if the nudge run also ends without a `post`, no second nudge is sent

#### Scenario: Message queued during another run

- **GIVEN** `bob` is in run A
- **WHEN** a direct message to `bob` arrives and is queued
- **AND** `bob` posts something before the queued message is read
- **THEN** that post does not disarm the check, because the check is armed only when the message is read
- **AND** no nudge is sent at the end of a run that never read the message
- **AND** if the run that read the message ends without a successful post after the read, `bob` receives one nudge (on Claude the reading run is the next turn; on pi it may be run A itself, continued by the follow-up)

#### Scenario: Multi-step run posts at the end

- **WHEN** a run that read a direct message makes several tool calls and model requests and posts successfully in its last step
- **THEN** no nudge is sent

#### Scenario: Message to several named agents

- **WHEN** the human posts to `Reviewer,bob`
- **AND** `bob`'s run that read it ends without a successful `post`
- **THEN** `bob` receives one nudge

#### Scenario: Broadcast needs no reply

- **WHEN** the human posts to `all`
- **AND** `bob`'s run ends without posting
- **THEN** no nudge is sent

#### Scenario: Rejected post does not count

- **GIVEN** a post check is armed for `bob`
- **WHEN** `bob` calls `post` and the hub answers 403
- **AND** the run ends
- **THEN** `bob` receives the nudge

### Requirement: Claude agents load the chatbridge as a mod

Claude agents SHALL join a room through the `chatbridge` Claude Code plugin loaded with `--plugin-dir`, whose hooks module registers the chatbridge tools with `$.tool.register` (listed as `mcp__chatbridge__<name>`), adds the channel instructions as a `session`-scoped `prompt.compose` section with id `chatbridge:instructions`, starts the hub stream from `session.start`, and reads its identity from the `CHATBRIDGE_AGENT`, `CHATBRIDGE_ROOM` and optional `CHATBRIDGE_HUB` environment variables. The hub stream SHALL run as `curl` under `$.process.spawn`, and every other hub request SHALL run as `curl` under `$.process.run` with a `--max-time` bound, in both cases with the bearer token supplied on stdin and never in the argument vector. On stream end the bridge SHALL wait 2 seconds, re-resolve `hub.url` and `hub.token`, and reconnect.

#### Scenario: Claude agent connects without the dev-channels flag

- **WHEN** A2AChannel spawns Claude agent `alice` in room `eu-space`
- **THEN** the tmux command contains `--plugin-dir` and does not contain `--dangerously-load-development-channels`
- **AND** any `--mcp-config` it contains names the generated global-servers file, whose servers never include `chatbridge`
- **AND** `alice` appears online in the roster
- **AND** `alice` can call `mcp__chatbridge__post`

#### Scenario: Token is not visible in the process list

- **WHEN** the mod's stream is running
- **THEN** no process argument vector contains the hub token

#### Scenario: Missing identity disables the bridge

- **WHEN** the mod loads with `CHATBRIDGE_AGENT` unset
- **THEN** it registers no tools, starts no stream, and logs one line saying the chatbridge is inactive

### Requirement: Chatbridge tools honour the user's permission rules

Because the mod answers its own tool calls, it SHALL ask Claude Code's permission decision (`$.tool.check`) before running any chatbridge tool. A `deny` decision, or an `ask` decision produced by a user settings rule, SHALL refuse the call with an error naming the rule and stating that chatbridge tools cannot show an approval dialog; no hub request SHALL be made. An `ask` produced by the permission mode alone (no rule) SHALL let the tool run. A tool disallowed at launch (`--disallowedTools`) is not offered to the model at all.

#### Scenario: Ask rule on post_file

- **GIVEN** the user's settings contain `permissions.ask: ["mcp__chatbridge__post_file"]`
- **WHEN** the agent calls `post_file`
- **THEN** the call fails with an error naming that rule
- **AND** no file is uploaded
- **AND** `post` still works

#### Scenario: Disallowed at launch

- **WHEN** Claude is launched with `--disallowedTools mcp__chatbridge__post_file`
- **THEN** the model is told the tool does not exist and no upload happens

### Requirement: Claude permission prompts are relayed through a PermissionRequest hook

The Claude mod SHALL hook `classic.PermissionRequest`. On each request it SHALL mint a request id matching the hub's permission id pattern, `POST /permissions` with the agent name, tool name, a description and an input preview of at most 8 000 characters, then wait on `GET /permissions/<id>/wait`. A terminal `allowed` or `denied` status SHALL answer the hook with the matching `decision.behavior`. If the wait times out (default 60 seconds), the mod SHALL `POST /permissions/<id>/dismiss`: on 2xx it SHALL fall through to Claude Code's local dialog; on 409 or any other failure it SHALL re-read the request once and honour a terminal `allowed` or `denied` verdict, falling through to the local dialog only if the request is still not terminal. If the hub is unreachable, rejects the request, or any request exceeds its time bound, the mod SHALL fall through to the local dialog. Every hub request made by the hook SHALL be time-bounded, so the hook cannot block indefinitely. The permission ledger SHALL NOT gain a TTL.

#### Scenario: Human allows from the webview

- **WHEN** Claude agent `alice` needs approval for `Bash`
- **AND** the human clicks Allow on the permission card within 60 seconds
- **THEN** `alice`'s tool call proceeds
- **AND** the local dialog, which Claude Code 2.1.296 opens alongside the hook, closes without a local answer

#### Scenario: Nobody answers in the room

- **WHEN** no verdict arrives within 60 seconds
- **THEN** the permission card is dismissed in the hub
- **AND** `alice`'s terminal shows Claude Code's local permission dialog (on Claude Code 2.1.296 it is already showing from the start)

#### Scenario: Lone agent answers in the terminal

- **GIVEN** a single Claude agent alone in its room and a human working only in its terminal pane
- **WHEN** the agent needs approval and the human answers the local dialog
- **THEN** the tool call follows that answer: a local Yes runs the tool, a local No refuses it
- **AND** the room card is dismissed by the agent (at once after a local No, when its wait ends after a local Yes), so no pending card remains

#### Scenario: Room answers while the local dialog is showing

- **WHEN** the human allows or denies on the room card while the local dialog is open
- **THEN** the hook answers with that verdict and the local dialog closes

#### Scenario: Room verdict after a local No

- **GIVEN** the person answered No in the local dialog
- **WHEN** a room verdict arrives afterwards
- **THEN** the tool call does not run
- **AND** the card is already dismissed by the agent, so the hub rejects the verdict with 409

#### Scenario: Room verdict after a local Yes (known limitation)

- **GIVEN** the person answered Yes in the local dialog (Claude Code 2.1.296 shows it while the relay waits)
- **WHEN** a room verdict arrives before the relay's wait ends
- **THEN** the hub records that verdict, but it SHALL NOT change the outcome: the tool call has already run
- **AND** the card is otherwise dismissed when the wait ends

#### Scenario: Verdict wins the race with the dismiss

- **WHEN** the wait times out
- **AND** the human clicks Allow just before the dismiss lands, so the dismiss returns 409
- **THEN** the mod re-reads the request, finds `allowed`, and the tool call proceeds without a local answer (the open local dialog closes)

#### Scenario: Dismiss fails and request still pending

- **WHEN** the dismiss call fails for a reason other than 409
- **AND** the re-read shows the request still `pending`
- **THEN** the local dialog appears

#### Scenario: Hub hangs

- **WHEN** `POST /permissions` does not answer within its time bound
- **THEN** the local dialog appears without waiting for the 60-second hub wait

#### Scenario: Hub down

- **WHEN** the hub is unreachable as a permission request starts
- **THEN** the local dialog appears without a 60-second wait

### Requirement: Hub exposes a long-poll wait on a permission request

The hub SHALL serve `GET /permissions/:id/wait?timeout_ms=<n>` under read-route auth (bearer header or `?token=`). It SHALL respond with the request's snapshot as soon as its status is terminal, or with the pending snapshot once `timeout_ms` elapses. `timeout_ms` SHALL default to 60 000, be capped at 300 000, and `0` SHALL return the current snapshot immediately. The response body SHALL be the bare snapshot. An id not matching the permission id pattern, or a `timeout_ms` that is not a non-negative number, SHALL return 400; an unknown id SHALL return 404.

#### Scenario: Verdict arrives during the wait

- **GIVEN** a pending permission `abcde`
- **WHEN** a client calls `GET /permissions/abcde/wait?timeout_ms=30000`
- **AND** the human allows it 5 seconds later
- **THEN** the call returns within about 5 seconds with status `allowed`

#### Scenario: Wait times out

- **WHEN** no verdict arrives within `timeout_ms`
- **THEN** the call returns the snapshot with status `pending`

### Requirement: The user's global MCP servers still reach Claude agents

When the user's global MCP config (`~/Library/Application Support/A2AChannel/mcp.json`) lists servers other than `chatbridge`, each Claude spawn SHALL generate `<app data>/mcp-configs/global.json` (mode `0600`, written atomically) containing only those servers under `mcpServers`, and SHALL pass it with one `--mcp-config` flag. A server named `chatbridge` SHALL never be written. With no such servers, no file SHALL be left and no flag SHALL be passed.

#### Scenario: Global servers configured

- **GIVEN** the global MCP config lists `context7` and `chatbridge`
- **WHEN** a Claude agent is spawned
- **THEN** its command contains exactly one `--mcp-config` naming `global.json`
- **AND** `global.json` lists `context7` and not `chatbridge`

#### Scenario: No global servers

- **WHEN** the global MCP config is missing or lists only `chatbridge`
- **THEN** the spawn command contains no `--mcp-config` and no `global.json` remains

### Requirement: Claude spawns require a Claude Code version whose mods load reliably

Before spawning a Claude agent, the app SHALL read the Claude Code version (`claude --version`) and SHALL refuse the spawn with an error naming the found version, the minimum (2.1.296) and the update command when the version is older or cannot be read. The check SHALL run on every new spawn (no cached result: an in-place downgrade of the binary must be caught); re-attaching to an existing session SHALL NOT run it.

#### Scenario: Old Claude Code

- **GIVEN** `claude --version` reports `2.1.287`
- **WHEN** the user spawns a Claude agent
- **THEN** the spawn fails with an error stating 2.1.296 is required and how to update
- **AND** no tmux session is created

### Requirement: The UI warns when a spawned agent never joins the room

After a fresh spawn, the terminal tab SHALL show a visible warning if the agent is not connected (live presence, not mere roster membership — `/send` and `/post` can register a name that never opened a stream) 20 seconds later, naming the likely cause for Claude agents (Claude Code mods did not load) and how to check it. No warning SHALL appear when the agent joins in time.

#### Scenario: Bridge never connects

- **WHEN** a spawned agent's bridge does not register with the hub within 20 seconds
- **THEN** its tab shows the warning

#### Scenario: Normal spawn

- **WHEN** the agent is connected within 20 seconds
- **THEN** no warning is shown

### Requirement: The MCP chatbridge path is removed

The codebase SHALL NOT contain the MCP chatbridge sidecar (`hub/channel.ts`, `hub/channel/tail.ts`, `hub/channel/permission-relay.ts`), the `A2A_MODE=channel` mode of `a2a-bin`, any MCP server configuration that carries the chatbridge (per-agent MCP configs included), the `--dangerously-load-development-channels` flag, the PTY output scan that dismisses the dev-channels confirm prompt, or the fixed cold-start delay before tailing.

#### Scenario: Unknown mode

- **WHEN** `a2a-bin` starts with `A2A_MODE=channel`
- **THEN** it exits with the unknown-mode error
