# Acceptance matrix — chatbridge-claude-mod

Live-room checks derived from the specs. Deterministic tests (core: task 2.7; mod: task 5.6; hub route: task 4.2) cover what live timing cannot prove; the traceability table at the end maps every runtime scenario to a row or a test.

## Rules

- **Build.** Installed from the branch with `./scripts/install.sh`, run only by Architect after announcing it. Subjects are spawned with that build: **C** = Claude agent on the mod, **P** = pi agent. Tester1 drives C rows, Tester2 drives P rows. **(H)** marks a human action.
- **Room.** `MX` unless stated. Room labels follow `AGENT_NAME_RE` (letters, digits, `_ . -`, inner spaces); no brackets or quotes.
- **Human sender.** The webview's `/send` stamps `from: "you"`; envelopes show `from="you"` for human messages.
- **Hub reads.** `H() { printf 'Authorization: Bearer %s\n' "$(cat ~/Library/Application\ Support/A2AChannel/hub.token)" | curl -s -H @- "$(cat ~/Library/Application\ Support/A2AChannel/hub.url)$1"; }` — the header goes in on stdin: a `$(cat …)` inside a `-H` argument is expanded by the shell into curl's argv, which is exactly the exposure M23 checks for. Every hub write in these rows follows the same pattern. Permission evidence always uses `H "/permissions?status=all"` (the route defaults to `pending`).
- **Timestamps.** Run boundaries and message positions come from the subject's session file, not from estimates: C — `~/.claude/projects/<cwd-slug>/<session>.jsonl` (`timestamp` per row); P — the pi session file for that agent. Hub-side times come from entry `ts`.
- **Controlled busy run.** Where a row needs the subject "busy", the subject is told: `run the shell command: sleep 45 && echo A-done, then post exactly "A-done" to you`. On C, `sleep` must already be session-approved (row P0). The run is bounded by the command, not by model speed. On Claude Code 2.1.287 the Bash tool refuses a foreground leading `sleep N`; use `python3 -c "import time; time.sleep(45)" && echo A-done` instead (same 45 s bound).
- **Verdicts.** PASS, FAIL, or **NOT RUN** when the branch under test was not exercised (e.g. the model posted when the row needed it not to). NOT RUN is never reported as PASS. Evidence is posted raw; a FAIL includes the observed output.
- **Gates.** Stage 3 (task 3.5): rows marked **S3** with P subjects only. Stage 8 (task 8.1): every row.

## Setup rows

| ID | Runtime | Steps | Expected | Evidence |
|---|---|---|---|---|
| P0 | C | In the test project, create `.claude/settings.local.json` with `{"permissions":{"defaultMode":"default"}}` (the user's global `defaultMode` is `auto`, which suppresses most dialogs). Spawn `c1` in `MX` there. Ask it to run `printf mx > /tmp/a2a-mx-probe-$RANDOM`. Then ask it to run `sleep 1` and **(H)** answer the local dialog with "don't ask again" for `sleep` | The `printf` call raises a permission request (hub shows a `permission.new` for `c1`); `sleep` is session-approved afterwards. If `printf` is auto-approved, pick another harmless write under `/tmp` that asks, and record it as the **probe command** for M15–M18 and M20 | `H "/permissions?status=all"` showing the request; the chosen probe command |
| P1 | C | Dropped (11:18): the `__TAURI__.core.invoke` hook did not register a known keystroke, and xterm `onData` also carries automatic terminal-protocol replies (DA/DSR), so an empty-write assertion is the wrong check | — | — |

## Rows

| ID | Gate | Runtime | Spec | Steps | Expected | Evidence |
|---|---|---|---|---|---|---|
| M1 | | C | terminal-projection; runtime "loads as a mod" | Spawn `c1` in `MX` from the app | (a) the pane start command has `--plugin-dir`, no `--dangerously-load-development-channels`, any `--mcp-config` names `mcp-configs/global.json`; (b) no dev-channels prompt in the pane; (c) `c1` online; (d) **no unsolicited interactive input**: the only `pty_write` callers left in `ui/` are user-driven (keystroke/`onData` incl. protocol replies, Shift+Enter, the confirmed `/exit`, slash sends) — evidenced by the 7.2 diff and a caller audit, not a live trace. Verdict rule: M1 is reported NOT RUN for a live no-unsolicited-input observation, with (a)–(d) listed as separate sub-results; acceptance treats (d)'s code audit as an explicit, agreed exception | `tmux … list-panes -F '#{pane_start_command}' -t c1`; pane capture; `H /agents`; `grep -rn "ptyWrite(" ui/` with context; 7.2 diff |
| M2 | S3 | both | onboarding "briefing as context" | Spawn the subject; leave idle 30 s | Briefing in context; no run starts | Session file: no assistant row after spawn; then ask "what room are you in and who is online?" → correct |
| M3 | S3 | both | runtime "three modes" (context) | Subject idle; spawn and kill another agent in `MX` | Re-brief arrives as context; no run starts | Session file before/after: no assistant row |
| M4 | S3 | both | runtime "same rendering"; envelope; "broadcast needs no reply" | **(H)** post `status?` to `all` | Envelope line + body delivered; a run starts; **no nudge** whether or not it posts | First line from the session file; session file shows no nudge |
| M5 | S3 | both | runtime "one nudge" (happy path) | **(H)** post `reply with exactly: ok` to the subject | Subject posts `ok`; no nudge | Room log; session file |
| M6 | S3 | both | runtime "agent replies in the terminal only" | **(H)** post to the subject: `do not call any tool; answer in plain text only: what is 2+2?` | If the subject called `post` anyway → **NOT RUN** (covered by task 2.7). Otherwise exactly one nudge after the run; if the nudge run also does not post, no second nudge | Session file: run end, nudge row (count = 1) |
| M7 | S3 | both | runtime "message queued during another run" | Start the controlled busy run; at +10 s **(H)** post to the subject: `reply with exactly: B-<your name>` | Run A ends with the `A-done` post and **no nudge**; the queued message is read only after run A's in-flight work (C: next turn; P: may be the same agent run) and its reply `B-<name>` is posted after that read; no nudge. If no successful post follows the read → exactly one nudge at the end of the run that read it | Session file timestamps for: run A start/end, `A-done` post, queued message read, run B start/end, `B-…` post, any nudge |
| M8 | S3 | both | interrupt-messages "steer" | Start the controlled busy run; at +10 s send an interrupt `post exactly: interrupted, then continue` | Interrupt row inside run A (before its end); subject can `ack_interrupt` | Session file position; `H "/interrupts?status=all"` shows `acknowledged` |
| M9 | S3 | both | runtime "queued chat does not hold back an interrupt" | Start the controlled busy run; at +10 s post a direct chat `reply with exactly: chat-ok`, then within 1 s an interrupt `post exactly: int-ok` | Interrupt row inside run A, before the chat; chat read only after run A's in-flight work (C: next turn; P: follow-up, same or next agent run) | Session file timestamps for both rows and run boundaries |
| M10 | S3 | P | handoff kind; envelope | `p1` sends a handoff to `p2`; `p2` accepts. `p2` sends one to `p1`; `p1` declines with a reason | States transition; envelopes carry `kind`, `handoff_id`, `version`; both sides see updates | `H "/handoffs?status=all"`; delivery first lines |
| M11 | S3 | both | envelope `catchup` | Create a pending handoff to the subject; kill its pane; respawn it | Pending handoff replayed with ` catchup]` | Delivery first line |
| M12 | S3 | both | attachment-upload | Subject runs `post_file` on (a) an allowed `.md`, (b) a `.zip`, (c) `/nonexistent.pdf` | (a) card with attachment, peers get `[attachment: <path>]`; (b) tool error naming the allowlist, no attachment entry (a follow-up text post by the agent, e.g. after a nudge, is allowed); use a non-empty file — Bun drops a 0-byte part's filename; (c) read error, no `/upload` request | Room log; tool output; `hub.log` for (c) |
| M13 | S3 | both | envelope escaping | Spawn subject `Dev 1` in room `EU Space`; **(H)** post to it | `from="you"`, `to="Dev 1"`, `room="EU Space"`; the quoted values parse with `JSON.parse` | Delivery first line; `bun -e` parse output. Bracket/quote cases: task 2.7 |
| M14 | S3 | both | hub routing (bridge gate itself: task 2.7) | Subject in `MX`; **(H)** post to `all` in room `MY` | Subject receives nothing | Session file: nothing new |
| M15 | | C | runtime "human allows from the webview" | `c1` runs the probe command; **(H)** Allow on the card | Tool runs; the local dialog closes without a local answer | `H "/permissions?status=all"` shows `allowed`; pane capture |
| M16 | | C | same, deny | As M15; **(H)** Deny | Tool refused; the local dialog closes without a local answer | `H "/permissions?status=all"` shows `denied`; session file |
| M17 | | C | runtime "nobody answers in the room" | As M15; nobody acts | Request `dismissed` after ~60 s; no pending card; Claude's local dialog is showing (from the start on 2.1.296, after the wait on 2.1.287) | Timestamps; `H "/permissions?status=all"` |
| M18 | | C | runtime "lone agent, nobody watching the webview" | A subject alone in its own room (e.g. `t3` spawned in room `SOLO`), only the human; **(H)** uses only the terminal pane; trigger the probe command; answer locally | Local dialog within ~60 s + dismiss round-trip; local answer works; no pending request | Timestamps; `H "/permissions?status=pending"` empty |
| M19 | | C | runtime "verdict wins the race" | unit only | — | task 5.6 output |
| M20 | | C | runtime "hub down" | Variant (Reviewer-approved, no app quit): launch a throwaway Claude on its own tmux socket with the staged mod and `CHATBRIDGE_HUB=http://127.0.0.1:9` (unreachable; keep USER/LOGNAME so Claude can log in), `--permission-mode default`, `--debug-file`; type a Bash request that needs approval | Local dialog within a few seconds (no 60 s wait); debug shows "permission relay failed: hub unreachable" and the PermissionRequest hook settling in tens of ms | pane capture + debug log |
| M21 | S3 | both | hub-discovery "converges after restart" | Quit and relaunch A2AChannel | Subject online within ~5 s of hub start without respawn; a `post` succeeds | `H /agents`; the post |
| M22 | | C | hub-discovery "launch template"; "explicit override" | (a) Run the modal's launch line in Terminal.app. (b) Start a standalone hub with the app's token, since the bridge always reads the token from `hub.token`: `A2A_TOKEN="$(cat ~/Library/Application\ Support/A2AChannel/hub.token)" PORT=8099 bun run hub/hub.ts` (env, not argv); run the launch line with a **fresh agent name** (not the one from (a)), prefixed with `CHATBRIDGE_HUB=http://127.0.0.1:8099` | (a) Agent joins the app's room; the line has no hub URL or token. (b) Agent appears in the standalone hub's `/agents` and **not** in the app hub's | Modal text; `H /agents`; `curl` of the standalone hub's `/agents` |
| M23 | | C, P | runtime "token not visible" | While subjects are connected and one runs M12(a), run a script that reads the token itself, so the token never enters any argv: `bun -e 'const fs=require("fs"),cp=require("child_process"),os=require("os");const t=fs.readFileSync(os.homedir()+"/Library/Application Support/A2AChannel/hub.token","utf8").trim();const ps=cp.execFileSync("ps",["-axo","args"]).toString();console.log(ps.includes(t)?"FOUND":"absent")'` | Prints `absent` | Script output |
| M24 | | C | runtime "missing identity" | Run `claude --debug --plugin-dir <mod>` without `CHATBRIDGE_AGENT` | One "chatbridge inactive" line; no tools; no roster entry | Debug log line; `H /agents` |
| M25 | S3 | both | terminal-projection | Respawn with session mode `continue`, then `resume` | Reconnects; briefing as context; tools work | `H /agents`; one post |
| M26 | | C+P | cross-runtime parity | One C and one P subject in `MX`: M4–M9 each, and M10 with C→P accept and P→C decline | Same observable behaviour on both runtimes | Side-by-side results per row |
| M27 | S3 | both | runtime "three modes" (`nutshell.updated` context) | Subject idle; **(H)** edit the room nutshell | Update in context; no run starts | Session file: no assistant row; ask the subject for the nutshell → new text |
| M28 | S3 | both | runtime "three modes" (idle steer) | Subject idle; send an interrupt `post exactly: idle-int` | A run starts and posts `idle-int` | Session file; room log |
| M30 | | C | runtime "loads as a mod"; spike result 1 | Spawn a C subject in a never-trusted folder; **(H)** accept the trust prompt | The bridge connects within 10 s of acceptance: agent online, briefing in context. Repeat 3 times with fresh folders | `H /agents` after each; `claude --debug-file` showing `hooks module chatbridge… loaded` |
| M31 | S3 | both | runtime "an agent's own permission traffic does not wake it"; three modes | (a) C: subject `c1` idle; it runs the probe command in a run you start, and **(H)** allows it on the card; after its run ends, wait 30 s. (b) **(H)** send an interrupt to the idle subject; it acks; wait 30 s. (c) With a second subject idle in `MX`, repeat (a) | (a) No new run starts for `c1` from its own `permission.new` or `permission.resolved`. (b) No run starts from the `interrupt.ack`. (c) The second subject IS woken by `c1`'s `permission.new`. P rows run (b) only (pi raises no permission requests) | Session-file run boundaries vs event timestamps from `H "/permissions?status=all"` and `H "/interrupts?status=all"` |
| M32 | S3 | both | runtime "loads as a mod"; pi adapter `session_start` restart | With the subject idle and connected: C — `touch ~/Library/Application\ Support/A2AChannel/chatbridge-mod/hooks/register.js` (the plugin-dir watch reloads the module); P — run pi's `/reload`. Then **(H)** post one direct message `reply with exactly: once` | After the reload the hub shows exactly one stream connection for the subject; the message is delivered once (one user row, one `once` post) | `H /presence` before and after; session file rows; room log |
| M33 | S3 | both | pi FIFO text matching; runtime "unanswered direct messages" | Start the controlled busy run; at +10 s **(H)** post the identical direct text `reply with exactly: twin` twice, 1 s apart | Both messages are delivered and read; after a post that follows the reads, no nudge. If no post follows, exactly one nudge | Session file: two identical user rows, run boundaries, posts, nudge count |
| M34 | | both | runtime post check across hub restart (unit: 2.7 reused-id tests) | Start the controlled busy run; at +10 s **(H)** post a direct message `reply with exactly: before`; immediately quit and relaunch A2AChannel; after the subject reconnects, **(H)** post `reply with exactly: after` | Every delivered message is read once; each read run that ends without a following post gets exactly one nudge; no nudge for a message that was answered; no duplicate delivery after reconnect | Session file rows with timestamps; room log; hub entry ids before/after (they restart) |
| M35 | | C | runtime "global MCP servers still reach Claude agents" | Spawn `c1` with the user's global MCP config as-is; in its pane run `/mcp` | The user's global servers are present (connected, or in their usual pre-existing state); no legacy chatbridge MCP transport/config is present (no `chatbridge` entry in `global.json`, no `--mcp-config` carrying it). The mod's own in-process tool server, registered by `$.tool.register`, does appear under the name `chatbridge` and is expected | `/mcp` pane capture; `cat mcp-configs/global.json \| jq '.mcpServers \| keys'` |
| M36 | | C | runtime "chatbridge tools honour the user's permission rules" | (a) In the test project's `.claude/settings.local.json` add `"ask": ["mcp__chatbridge__post_file"]` under `permissions`; spawn `c1`; ask it to `post_file` a `.md` and then `post` `ok`. (b) Remove the rule; repeat | (a) `post_file` fails naming the rule, no new file in the attachments dir, `post` succeeds. (b) `post_file` succeeds | Pane capture; `ls -la <attachments_dir>` before/after |
| M37 | | C | runtime "interrupt reaches a busy agent mid-turn" across a mod reload | Start the controlled busy run on `c1`; at +5 s `touch ~/Library/Application\ Support/A2AChannel/chatbridge-mod/hooks/register.js` (plugin-dir watch reloads the module mid-turn); at +10 s send an interrupt `post exactly: reload-int` | The interrupt reaches the running turn (appended, not queued as a new prompt): `reload-int` is posted before run A ends; exactly one stream connection afterwards | Session-file run boundaries and interrupt row position; `H /presence` |
| M29 | | hub | runtime "hub long-poll wait" | Standalone hub; task 4.2 curl script: no auth → 401; bad id → 400; unknown → 404; `timeout_ms=0` → immediate; verdict during wait → early return; timeout → `pending`; `timeout_ms=999999` → capped; dismiss after verdict → 409 | All as stated | Script output |

## Traceability

| Spec scenario (`chatbridge-runtime` unless noted) | Live row | Deterministic test |
|---|---|---|
| Both runtimes render the same event identically | M4, M26 | 2.7 envelope |
| Tools module has no runtime imports | — | 2.8 grep |
| Briefing does not wake the agent (also agent-onboarding) | M2, M3 | 2.7 mode table |
| An agent's own permission traffic does not wake it | M31 | 2.7 modeFor policy test |
| Interrupt reaches a busy agent mid-turn (also interrupt-messages) | M8 | 2.7 mode table; 5.6 steer while busy |
| Idle interrupt starts a run | M28 | 5.6 |
| `nutshell.updated` does not wake | M27 | 2.7 mode table |
| Queued chat does not hold back an interrupt | M9 | 2.7 chat-then-interrupt; 5.6 deliver resolves before turn |
| Chat to a busy agent waits for the turn to end | M7, M9 | 2.7 |
| Handoff envelope / replayed entry | M10, M11 | 2.7 key order, `catchup` |
| Names and labels with spaces | M13 | 2.7 |
| Quote in a value cannot forge a key | — | 2.7 (names cannot contain quotes live) |
| Cross-room event is dropped | M14 (hub routing only) | 2.7 injected cross-room event |
| Agent replies in the terminal only | M6 | 2.7 nudge once |
| Message queued during another run | M7 | 2.7 |
| Multi-step run posts at the end | M7 (run A) | 2.7 |
| Broadcast needs no reply | M4 | 2.7 |
| Rejected post does not count | — | 2.7 (403 from fake host) |
| Claude agent connects without the dev-channels flag (also terminal-projection) | M1, M30 | 6.4 pty-plumbing; 7.4 grep |
| Token is not visible in the process list | M23 | — |
| Missing identity disables the bridge | M24 | — |
| Human allows / denies from the webview | M15, M16 | 5.6 allow, deny |
| Nobody answers in the room | M17 | 5.6 timeout + dismiss 2xx |
| Lone agent, nobody watching the webview | M18 | — |
| Verdict wins the race with the dismiss | M19 (unit only) | 5.6 dismiss 409 + re-read |
| Dismiss fails and request still pending | — | 5.6 |
| Hub hangs | — | 5.6 POST times out |
| Hub down | M20 | 5.6 |
| Hub long-poll wait (verdict, timeout, 0, 400, 404, auth, cap) | M29 | 4.2, 4.4 |
| Adapter restart on reload (both runtimes) | M32, M37 (reload mid-turn, Claude) | 2.7 lifecycle (stop drops buffered frames) |
| Identical texts pending at once (pi matching) | M33 (repeated body only — live posts get distinct envelope ids, so this row does not prove FIFO matching) | `tests/unit/pi-read-matcher.test.ts` (byte-identical texts, FIFO) |
| Post check across hub restart (reused ids) | M34 | 2.7 reused-id tests |
| post_file upload / disallowed / missing (attachment-upload-by-agent) | M12 | — |
| Bridge discovers hub / converges / explicit override (hub-discovery) | M21, M22(b) | — |
| Launch template carries no hub URL (hub-discovery) | M22 | — |
| Chatbridge tools honour the user's permission rules | M36 | 5.6 tool-permission tests |
| Global MCP servers still reach Claude agents | M35 | Rust unit tests (6.3 follow-up) |
| Unknown mode `A2A_MODE=channel` | — | 7.4 grep + `A2A_MODE=channel a2a-bin` exits with the unknown-mode error |

**Out of scope:** pause-agent WIP; pi permission relay (non-goal); many concurrent permission waits (ceiling documented in task 4.1).
