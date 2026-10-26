# Part 4a: agent column, per-agent reload and skill switches

Status: the human asked on 2026-10-24 for this part to be built. Ready to split into tickets.
Date: 2026-10-24. File paths refer to the working tree on that date. `ui/terminal.js`, `ui/index.html`, `ui/styles/terminal.css`, `src-tauri/src/pty.rs`, `src-tauri/src/factory.rs` and `hub/channel/*` have uncommitted stage-sessions work (Part 4). Build on top of it. Do not revert it.
Reader: the Orchestrator. Split this part into tickets. The section "Tickets" gives one ticket for each item, with acceptance criteria.
This part replaces T03 of Part 14 ([14-ui-redesign.md](14-ui-redesign.md)): the human designed the agent list himself. T03 and T09 of Part 14 no longer have to ship together, because the column opens sessions in the existing terminal pane.

## Source

- The human's note (2026-10-24), in clean form:
  1. Move the agent list from the right side of the terminal view to the left side of the window, so it shows in every view: terminal and ticket board.
  2. Remove the agents from the top bar. The left column replaces them.
  3. Each agent shows its name and the current actions. A new Reload button sits next to the current actions. It reloads the status and the skills of that one agent, so other agents are not disturbed.
  4. An agent opens to show its harness, its model × effort and its skills. Each skill has a checkbox. All skills are on by default. The human can turn off a skill.
- Mockup: the page "Agent column" on the human's claude.ai canvas. Agents cannot open it. This file is the specification.
- Images in `ui-redesign/` next to this file. Read them before you start:
  - `AgentColumn.png`: the full column with Worker1 open, one skill turned off and its Reload waiting.
  - `AgentRowStates.png`: each row state and each Reload button state.
- The design source of each image is the `.dc.html` file with the same name. Read it for sizes, spacing and colours. Do not copy its code.
- Sample data in the images: "opus × high" and the skill that is off. The skill names are the real ones in `factory/worker/skills` and `factory/shared/skills`.

## What exists today

| Function | Where |
|---|---|
| Agent chips in the top bar, with presence, a hover card and Remove for an offline agent | `#legend` in `ui/index.html`, `renderLegend()` and the pill card in `ui/features/roster.js`, `ui/features/pill-card.js` |
| "+ agent" (opens the spawn modal) | `#add-agent-btn` |
| Terminal tab rail on the right of the terminal pane: Shell tab, one tab for each agent, "+" | `.terminal-tabs`, `ensureShellTab()`, `ensureTab()` in `ui/terminal.js` |
| Current actions on an agent tab: Pause / Resume (`.pause-toggle`), Open editor at the agent's folder (`.open-editor`), Kill session (`.close-x`, `handleKill()`) | `ensureTab()`, `ui/terminal.js` |
| Needs-attention pulse (permission prompt seen in the terminal output) | `maybeFlagAttention()`, `ui/terminal.js` |
| Role, harness, model, provider and effort of each agent | `pty_roles` (Tauri), `pillCardFields()` |
| Skill folders given to a role agent at launch. Claude: `--plugin-dir` for the staged role plugin and the shared plugin. Pi: `--no-skills`, then `--skill` for the role skills folder and the shared skills folder. | `format_claude_command()`, `pi_role_flags()` in `src-tauri/src/pty.rs` |
| Hot reload of one agent, at once when idle and at the end of the run when busy. Claude runs `reload-plugins`. Pi runs `ctx.reload()`. The hub records the result. | `maybeReload()` in `hub/channel/core.ts`, `reload()` in `hub/channel/claude-mod/register.ts` and `hub/channel/pi-extension.ts`, `POST /factory/relink` and `POST /factory/applied` in `hub/features/factory.ts` |
| Reload settings (restarts the hub, all agents get a new briefing) | `#reload-btn` |

Today a hot reload starts only when a briefing carries a new factory version. Nothing starts a reload for one agent on request.

## Rules for this part

1. Obey `CLAUDE.md`. In particular:
   - The UI stays vanilla HTML, CSS and JS.
   - After a change in `hub/` or `hub/channel/`, run `./scripts/build-sidecars.sh`. After a change in `hub/channel/`, also run `./scripts/check-mod.sh`.
   - The bridge core owns policy. Put reload logic in `hub/channel/core.ts`, not in one adapter.
   - A change in `pty.rs` launch helpers needs an integration test in `tests/integration/pty-plumbing.test.ts` before it ships.
   - Hub mutating routes need the bearer token.
2. Use the tokens in `ui/styles/tokens.css`. Do not write a colour value outside `tokens.css`.
3. All three themes must work.
4. Use real `<button>`, `<input type="checkbox">` and `<label>` elements. Every action must work from the keyboard. Icon buttons have an `aria-label`. Text contrast must be 4.5:1 or more.
5. Do not commit. The human commits.

## Tickets

### C1. Agent column on the left

Priority: Highest. Radius: high (replaces two navigation surfaces). Files: `ui/index.html`, `ui/terminal.js`, `ui/features/roster.js`, `ui/styles/layout.css`, `ui/styles/terminal.css`.
Image: `AgentColumn.png`.

1. Add a `<nav aria-label="Agents">` at the left of `#app-body`, 300 px wide. It shows in every view: chat only, chat with terminal, chat with board.
2. From top to bottom:
   - A header: "Agents", the online count ("6/6 online") and a "+" button that opens the spawn modal.
   - The Shell row. It opens the shell tab, as today.
   - The human: dot, name, "you". No actions.
   - A rule, then one row for each agent.
3. Move the agent tabs from `.terminal-tabs` into this column. Keep the tab state machine (`tabs`, `ensureTab()`, `focusTab()`, `setTabState()`) and its listeners. Only the place of the element changes.
4. A click on an agent name opens its session in the right pane. When the terminal pane is closed, it opens. When the board shows, the terminal replaces it (the `cubilot:right-pane` rule stays).
5. The column filters by the selected room, as the legend and the tabs do today.
6. Remove the vertical tab rail from the terminal pane. The terminal gets its width back.

Acceptance criteria:
1. The column shows in the chat view, the terminal view and the board view.
2. Every function of the old tab rail works from the column: open a session, the Shell tab, needs-attention.
3. Auto-attach at launch works as before.

### C2. Remove the agent chips from the top bar

Priority: High. Radius: low. Files: `ui/index.html`, `ui/features/roster.js`, `ui/styles/header.css`.

1. Remove `#legend` and "+ agent" from the header. The "+" in the column header replaces "+ agent".
2. Keep the room lead select in the header.
3. Remove for an offline agent moves to its row in the column (C3).
4. The hover card is no longer needed. The open row (C4) shows the same data.
5. Keep `applyRoster()`. It now updates the column.

Acceptance criteria:
1. The header has no agent chips.
2. An offline agent can still be removed.

### C3. Agent row and its actions

Priority: High. Radius: low. Files: `ui/terminal.js`, `ui/styles/terminal.css`.
Image: `AgentRowStates.png`.

1. A row, left to right: a chevron button (opens and closes the details, `aria-expanded`), the status dot, the name (mono, the agent's colour), then the actions.
2. Actions, left to right: Pause or Resume, Open editor, Reload (C5), a 4 px gap, Kill session. Kill is last, away from Reload.
3. Pause or Resume shows on every row. The other actions show on hover, on keyboard focus and on the selected row, as today. Hide them with `visibility: hidden`, so they stay in the Tab order of a focused row.
4. Dot and label for each state:
   - Online: filled `--green`.
   - Paused: `--amber` ring, the label "paused", and Resume instead of Pause.
   - Needs attention: filled `--red` with the existing pulse, the label "needs you", and a red-tinted row.
   - Offline: `--text-dim` ring, the label "offline", and Remove (the existing `/remove` call) instead of the actions.
5. The selected row has the `--bg-elev` ground and a `--line` border.

Acceptance criteria:
1. Each state in `AgentRowStates.png` shows for the matching agent state.
2. Keyboard path: Tab to a row, then to each action. Enter on the name opens the session.

### C4. Open row: harness, model × effort, skills

Priority: Medium. Radius: low. Files: `ui/terminal.js`, `ui/styles/terminal.css`.
Image: `AgentColumn.png` (Worker1).

1. The chevron opens a details area under the row:
   - Harness: `claude · Claude Code` or `pi · pi.dev`.
   - Model × effort: from `pty_roles` (`model`, `effort`). Show "-" when a value is not known, as the pill card does.
   - Skills (C6).
2. Save which rows are open, for each agent, in `localStorage`. Wrap each read and write in `try`/`catch`.
3. An agent with no role shows "No role: the agent loads your own Claude or Pi skills." and no checkboxes.

Acceptance criteria:
1. The values match the pill card values of today for a claude agent and a pi agent.
2. An open row stays open after a reload of the window.

### C5. Reload one agent

Priority: High. Radius: high (bridge, hub and app). Files: `hub/channel/core.ts`, `hub/features/factory.ts` (or a new feature), `ui/terminal.js`, tests.
Image: the Reload states in `AgentRowStates.png`.

The Reload button reloads one agent only. It must not restart the hub. It must not change any other agent.

1. **Hub.** Add a human-only route, for example `POST /agents/:name/reload`. It sends a reload request to that agent only (`cap.sse.emit(entry, { kind: "to-agents", agents: [name] })`).
2. **Bridge core.** On that request, mark "check needed" and run the existing `maybeReload()` path. It reloads at once when the agent is idle, and at the end of the run when it is busy. Add a way to reload with the same factory version when only the skill choice changed (C6). Keep the existing failure rules (two failures for one version stop the retries).
3. **Status.** The same click also reads the agent's state again: presence, pause, `pty_roles` and the factory record (`.applied`, `.pending`). The row shows the new values.
4. **Button states** (`AgentRowStates.png`):
   - Ready: neutral icon.
   - Change waits: amber icon with a dot. A skill was turned on or off and is not loaded yet.
   - Reloading: amber, disabled, label "Reloading… (waits for the end of a run)".
   - Failed: red icon, label "Reload failed. Click to try again."
5. An agent with no factory link (`noLink`, no role) only reads its status again.

Acceptance criteria:
1. Reload on Worker1 reloads Worker1. No other agent gets a reload or a new briefing.
2. A busy agent reloads after its run ends, not during the run.
3. A failed reload shows the Failed state. A second click tries again.
4. Unit tests in `tests/unit/bridge-core.test.ts` cover the request on an idle agent and on a busy agent.

### C6. Skill switches for each agent

Priority: Medium. Radius: high (launch command and staged folders). Files: `src-tauri/src/factory.rs`, `src-tauri/src/pty.rs`, a new Tauri command, `ui/terminal.js`, tests.
Image: `AgentColumn.png`.
Start with a short design note in the ticket. The human approves it before the code work.

1. **List.** Show the skills of the agent's staged role folder and of the shared folder, in two groups: "Role · <role>" and "Shared". One checkbox for each skill. Add a Tauri command that returns the list for one agent (the app already resolves these folders in `factory.rs` and `pty.rs`).
2. **Default.** Every skill is on.
3. **Store.** Keep the skills that are off for each agent, for example in `<factory dir>/agents/<hex>.skills-off` (JSON list, mode 0600), next to the existing `.applied` and `.pending` records. Keep it when the agent is killed and launched again with the same name, unless the human answers open question 3 differently.
4. **Apply.** A change waits for that agent's Reload (C5). After the reload, the agent must see only the skills that are on:
   - Pi: the `--skill` paths must point to a folder that holds only the skills that are on (for example a per-agent folder of links).
   - Claude: the role plugin that `--plugin-dir` loads must hold only the skills that are on (for example a per-agent copy or link folder of the role plugin).
   - A new launch of the agent uses the same choice.
5. **UI.**
   - The count "18 of 19 on" and a "Turn all on" button.
   - A skill that is off but still loaded shows "off on reload" next to its name.
   - A strip at the bottom of the open row: "N change(s) wait for Reload" and a "Reload <agent>" button.
   - Long skill names truncate with an ellipsis. The full name is in a `title`.

Acceptance criteria:
1. Turn off one skill of a Pi agent and click Reload. The agent no longer lists that skill. Other agents of the same role still have it.
2. The same for a Claude agent.
3. The choice survives an app restart.
4. "Turn all on" and Reload give the agent all its skills again.
5. An integration test covers the launch command with one skill off, for both harnesses.

## Build order

1. C1 and C2 together.
2. C3, then C4.
3. C5.
4. C6, after the human approves its design note.

## Tests

1. Unit tests for C5 in the bridge core.
2. Integration tests for the new hub route and for the launch command in C6.
3. Manual checks, in all three themes:
   - the column in the chat view, the terminal view and the board view
   - each row state in `AgentRowStates.png`
   - Reload on an idle agent and on a busy agent, while another agent works (it must not be disturbed)
   - one skill off and back on, for a Claude agent and a Pi agent

## Open questions for the human

1. "Reload status": does status mean anything more than presence, pause, role data and the factory version?
2. Skill switches for one agent (as drawn), or for a whole role (every worker)?
3. When an agent is killed and launched again with the same name, should its skill choice stay?
4. Stage sessions (Part 4) add one session for each ticket stage. Should the column group them under their role agent, or list them as normal rows?

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
