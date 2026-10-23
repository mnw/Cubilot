# Part 14: UI redesign (refined warm terminal)

Status: ready to plan. The human chose to include every proposal on the mockup. Some tickets wait for an answer from the human (see "Open questions").
Date: 2026-10-22. File paths and line numbers refer to the working tree on that date (`main`, 4 commits ahead of `origin/main`).
Reader: the Orchestrator. Split this part into tickets. The section "Tickets" gives one ticket for each item, with acceptance criteria.

## Source

- Mockup: the canvas "Cubilot redesign" on claude.ai (https://claude.ai/code/artifact/cfd84347-b98b-4ba5-b519-8e6931f635b9). It has three screens: "Room + agent session", "Room + ticket board" and "Agent roster". The canvas is private to the human. Agents cannot open it. This file is the specification.
- Reference copies of the three screens are in `ui-redesign/` next to this file: `Main.dc.html`, `Board.dc.html`, `Agents.dc.html`. Read them for sizes, spacing and layout. Do not copy their code. They are design files with inline styles, not app code.
- Each proposal on the canvas has a sticky note with an ID: `m01` to `m16` (session screen), `b01` to `b08` (board screen), `a01` to `a07` (roster screen). This brief uses the same IDs.
- Some mockup data is invented. On the roster screen, the context and cost values are sample values, except for `t-hr-pi`.

## Goal

Make the main window calmer and easier to scan. Keep every function that exists today.

1. One agent list in a left rail replaces the roster pills in the header and the tab rail in the terminal pane.
2. The header, the nutshell row and the transcript row become one title bar.
3. The chat becomes a compact log.
4. The right pane gets one tab bar for agent sessions, the shell and the board.
5. Ticket cards become easier to scan. The traffic light stays.
6. A new Agent roster view shows all agents side by side.

## Rules for this part

1. Obey `CLAUDE.md`. The UI stays vanilla HTML, CSS and JS. Do not add a framework, a bundler or a build step.
2. Use the tokens in `ui/styles/tokens.css`. Do not write a colour value outside `tokens.css`. Put each new token in the correct layer (skin or structural).
3. Keep all three themes working: `default`, `rose-pine-dawn` and `rose-pine-moon`. Check each changed screen in each theme.
4. The mockup uses the font IBM Plex Sans. Use the bundled `--sans` (Inter) and `--mono` (JetBrains Mono) instead. Do not load a web font.
5. Use the `--fs-*` steps for font sizes, so the `font_scale` setting in `config.yml` keeps working.
6. Use real `<button>`, `<a>`, `<select>`, `<input>` and `<label>` elements. Every action must work from the keyboard. Text contrast must be 4.5:1 or more.
7. Put new pure logic in small modules that run in node, like `ui/features/pill-card.js`. Test them with `bun test` in `tests/unit/`.
8. Do not commit. The human commits.
9. After a change in `hub/`, run `./scripts/build-sidecars.sh`. Use `./scripts/install.sh` for app rebuilds.

## Keep: do not remove

The mockup does not show these functions. They stay. A ticket that removes one of them fails review.

| Function | Where it is now |
|---|---|
| Ticket traffic light. The human requires it. Keep `lightOf()` without change: red = waiting for the human, orange = an agent works on it, green = no one works on it, no light for done and cancelled. | `ui/kinds/ticket.js:619-634`, `ui/styles/kinds.css:442-447` |
| Titlebar buttons: Claude launch command, global MCP servers, settings (`config.yml`), role skills folder, Reload settings | `.titlebar` in `ui/index.html` |
| Space for the macOS window buttons, and the drag region (`titleBarStyle: Overlay`, `data-tauri-drag-region`) | `.titlebar` |
| Room switcher with "All rooms" | `#room-display`, `ui/features/rooms.js` |
| New factory room, Pause room, Resume room | `#factory-room-btn`, `#pause-room-btn`, `#resume-room-btn` |
| Room lead select | `#ticket-lead` |
| Nutshell text and its Edit button (a handoff proposal) | `#nutshell`, `ui/features/nutshell.js` |
| Transcript controls: persist toggle, size meta, "Archive & reset", auto-summarise toggle and its meta | `#room-persistence`, `ui/features/room-persistence.js` |
| Agent hover card: role, harness, model, provider, effort | `ui/features/pill-card.js`, `ui/features/roster.js` |
| Remove button on an offline agent | `.legend-remove` in `roster.js` |
| Pause and resume for each agent, and the needs-attention pulse | `ui/terminal.js:278-400`, `ui/terminal.js:625-640` |
| Shell tab, and the "+" tab that launches an agent | `ui/terminal.js` |
| Splitter between the chat and the right pane, with the saved split | `#splitter`, `ui/terminal.js` |
| Message copy buttons, attachments, markdown, and the kind cards (handoff, interrupt, permission) | `ui/features/messages.js`, `ui/kinds/` |
| Composer: target menu, attach, mention popover, slash popover, key hints | `ui/features/composer.js`, `mentions.js`, `slash-command.js` |
| Board: Filters panel, "Archive all done", drag and drop, "+" in each column, ticket dialog, notes, approval line, acceptance criteria, external ref, archived tag | `ui/kinds/ticket.js` |
| Footer: hub status, Session usage, Weekly usage | `.app-footer`, `ui/features/usage.js` |

## Mockup errors: read before you plan

Some proposals on the mockup do not match the code. Use the correction in this table.

| ID | The mockup shows | Fact in the code | Do this |
|---|---|---|---|
| m15 | Session output as blocks: a collapsed briefing, tool rows, thinking lines | The session pane is xterm.js on a raw PTY. It shows the agent's own TUI. Cubilot does not parse it. | Do not build m15. The xterm theme already follows the tokens. |
| m14 | Context %, tokens, cost and working folder in the session header | `pty_roles` gives role, harness, model, provider and effort. It has no working folder. No source gives context % or tokens. Cost for each agent exists only for Pi, in Part 11. | Show the known fields. Leave out context % and tokens. Show cost only when Part 11 supplies it. |
| m16 | A separate input bar below the session | There is no separate input. The xterm prompt is the input. | Do not add an input bar. Add a hint in the session header: "Keys go to the terminal, not the room." |
| m02 | Status dots for running, waiting and idle | The UI knows online, offline, paused and needs-attention. It does not know running or waiting. | Show the four known states (ticket T03). Running and waiting go to the backlog (ticket H2). |
| m03 | A rooms list as a new function | Rooms exist: the room switcher, "All rooms" and New factory room. | Treat m03 as a change. The list must include "All rooms". |
| m07 | Sender colour by role | The hub gives each agent a colour from a hash of its name. | Use the role colour when `pty_roles` gives a role. Else use the hub colour. |
| m13 | Tabs for sessions and the board | The right pane shows the board or the terminal, never both. The `cubilot:right-pane` event controls this. | Keep the event. The tab bar replaces `#board-toggle-btn` and `#terminal-toggle-btn`. |
| b07 | The chat is 420 px wide while the board shows | The splitter sets the width, and the app saves the split. | Keep the splitter. Save one split for the board and one for the terminal. |
| b05 | Ticket type ("CODE") and ID ("8.3a") as fields | Tickets have no type field and no ID code. They are text in the title, for example `[code] 8.3a Hot reload: …`. | Parse a leading `[tag]` and a leading ID token from the title, for display only. Show the full title when the parse fails. No hub change. |
| b06 | The status line "Validator waits on Tester2's report" | Tickets have no reviewer field. | Build the line from status, assignee and approval only (ticket T13). |
| b02 | "Archive all done" is missing | It is in the Done column header. | Keep it. Collapse a column only when it is empty, so the button shows when Done has tickets. |
| none | The titlebar icon buttons are missing | They exist (see "Keep"). | Keep them in the new title bar. |

## Design tokens

Most mockup colours match existing tokens. Use the token, not the mockup value.

| Use in the mockup | Mockup value | Token |
|---|---|---|
| Window ground | #15120E | `--bg` |
| Left rail, terminal ground, footer | #17140F, #110F0B | `--bg-inset` |
| Cards, composer, chips | #1E1A15 | `--bg-raised` |
| Selected row, active chip | #2A241D | `--bg-elev` |
| Hover | #2C261F | `--bg-hover` |
| Borders | #2A241D, #362F27 | `--line-soft`, `--line` |
| Main text | #EEE7DB | `--text` |
| Secondary text | #B4A893 | `--text-muted` |
| Meta text: times, counts, section labels | #978B78 | `--text-meta` (new, change 1) |
| Accent: Send, active tab, primary button | #E8834F | `--orange` |
| Running, warning | #E2B350 | `--amber` |
| Online, success | #93BC78 | `--green` |
| Danger, high radius | #E57A6B | `--red-strong` |

Token changes:

1. **Meta text.** `--text-dim` (#6b5d51) on `--bg` has a contrast of about 2.6:1. That fails 4.5:1. Add the skin token `--text-meta`. Set it to #978B78 in the default theme (about 5:1). Set it to the `--text-muted` value in the two Rosé Pine blocks. Use it for times, counts and section labels. Do not change `--text-dim`, because other rules use it.
2. **Role colours.** Add these skin tokens. Each one points to an existing accent, so the themes need no new values.
   - `--role-lead: var(--orange)` for `orchestrator`
   - `--role-worker: var(--amber)` for `worker`
   - `--role-tester: var(--teal)` for `tester`
   - `--role-review: var(--purple)` for `validator` and `reviewer`
   - `--role-other: var(--blue)` for every other role in `factory/` (writer, editor, a11y, seo)
   An agent with no role keeps its hub colour.
3. **Sizes.** Add `--size-56` (chat time column) and `--size-248` (left rail width) to the structural layer. `--size-44` (pane tab bar) and `--size-48` (title bar) exist.
4. **Radius.** The mockup uses 10 px on cards. Keep `--radius-lg` (6 px). Do not add a radius token.

## Window layout

Left to right: the left rail (248 px), the chat (flexible), the splitter, the right pane (flexible). The title bar (48 px) is above all of them. The footer is below all of them. The right pane is closed when no tab shows, as today.

## Tickets

Each ticket gives the sticky IDs it covers, a suggested priority and blast radius, the files, the specification and the acceptance criteria.

### T01. Add the new tokens

Stickies: none. Priority: Highest. Radius: low.
Files: `ui/styles/tokens.css`.

1. Add `--text-meta`, the five role tokens, `--size-56` and `--size-248` (see "Design tokens").
2. Set `--text-meta` in the `rose-pine-dawn` and `rose-pine-moon` blocks.

Acceptance criteria:
1. The new tokens exist in the correct layer.
2. Each theme block sets `--text-meta`.
3. No other file changes.

### T02. One title bar

Stickies: m04, m05, m06. Priority: High. Radius: high (window drag region).
Files: `ui/index.html`, `ui/styles/header.css`, `ui/styles/layout.css`, `ui/features/nutshell.js`, `ui/features/room-persistence.js`.

1. Merge `.titlebar`, `<header>`, `#nutshell` and `#room-persistence` into one bar. The bar is 48 px high.
2. Order, left to right: space for the macOS window buttons, brand mark, selected room (ticket T04), nutshell, flexible space, transcript pill, lead select, Pause room, Resume room, New factory room, "+ agent", then the five titlebar icon buttons.
3. Keep `data-tauri-drag-region` on the bar.
4. Nutshell: one line with an ellipsis. The label "Nutshell" stays. Show the full text in a `title` attribute. The Edit button opens the existing editor.
5. Transcript pill: when persistence is off, show an amber pill "Transcript not saved". When it is on, show a neutral pill "Transcript saved" with the size from `rp-meta`.
6. A click on the pill opens a popover with the existing controls: persist toggle, size meta, "Archive & reset", auto-summarise toggle and summary meta.
7. Hide the pill and the nutshell with "All rooms", as the rows hide today.

Acceptance criteria:
1. The `#nutshell` row and the `#room-persistence` row are gone. Their controls work from the bar.
2. The window drags from empty space in the bar.
3. All five titlebar buttons work.
4. At a window width of 1024 px, no item overlaps. The nutshell text truncates first.

### T03. Left rail: agent list

Stickies: m01, m02. Priority: High. Radius: high (replaces two navigation surfaces).
Files: `ui/index.html`, `ui/features/roster.js`, `ui/terminal.js`, `ui/styles/layout.css`, new `ui/styles/rail.css`, new pure module for grouping.
Ship T03 and T09 together. Without T09, the user has no way to open a session.

1. Add a `<nav>` at the left of `#app-body`. Width `--size-248`. Ground `--bg-inset`. It has two sections: Rooms (T04) and Agents.
2. The agent list replaces `#legend` in the header and the terminal tab rail (`.terminal-tabs`).
3. The human is first, with the label "you".
4. Group the other agents by the role from `pty_roles`: Lead (orchestrator), Build (worker), Test (tester), Review (validator, reviewer), Write (writer, editor), Other (other roles and no role).
5. Each row has a status dot, the name (mono, role colour), one line of activity, and a harness tag (`cc` for claude, `pi` for pi).
6. Status dot: online = filled `--green`. Offline = hollow `--text-dim`. Paused = hollow `--amber` ring. Needs attention = filled `--red` with the existing pulse.
7. Activity line: the title of the agent's ticket with status `claimed` or `in_progress`, when one exists. Else "Paused", "Offline" or "Online". The ticket module loads tickets only when the board opens (`load()` in `ticket.js`). Load the tickets of the selected room once for the rail, or show only the state. With "All rooms", show only the state.
8. Row buttons show on hover and on keyboard focus: Pause or Resume (existing), Remove (offline agents only, existing).
9. The hover card (`pillCardFields`) stays. It shows on hover and on focus, as today.
10. A click on a row opens that agent's session tab in the right pane (T09).
11. At the bottom of the rail: "Manage agents" (opens T14) and "+" (opens the spawn modal).
12. The rail filters by the selected room, as the legend does today.

Acceptance criteria:
1. The header has no roster pills. The terminal pane has no vertical tab rail.
2. Every function of the old pills and old tabs works from the rail: hover card, remove, pause, resume, needs-attention, open session.
3. A pi agent shows `pi`. A claude agent shows `cc`.
4. Tab reaches each row and its buttons. Enter on a row opens the session.
5. A unit test covers the grouping function (role to group).

### T04. Left rail: rooms

Stickies: m03. Priority: Medium. Radius: low.
Files: `ui/features/rooms.js`, the rail markup from T03.

1. List "All rooms", then each room with its agent count.
2. A click selects the room. It sets the same state as the room switcher (`SELECTED_ROOM`).
3. "+" next to the heading opens the New factory room modal.
4. The title bar shows the selected room name. Its menu stays as a second way to switch (open question 6).

Acceptance criteria:
1. A room selected in the rail and a room selected in the title bar give the same state.
2. "All rooms" works as today.

### T05. Chat as a compact log

Stickies: m07, m09, m11. Priority: High. Radius: low.
Files: `ui/features/messages.js`, `ui/styles/chat.css`.

1. Each message is one row. The left column (`--size-56`, mono, `--text-meta`) holds the time.
2. The right column holds a header line and the body. The header line has the sender name (mono, weight 600, colour by T01 change 2) and "→ recipient" in `--text-meta`.
3. Remove the avatar circle and the bubble background.
4. When the sender is the room lead, show a small "lead" tag. Give the row the `--bg-raised` ground. The lead is the value that `ticket.js` reads from `GET /rooms/:room/lead`.
5. Show system entries as a centred line with a rule on each side, in `--text-meta`.
6. Inline code: mono, `--bg-elev` ground.
7. Keep the copy buttons, attachments, markdown and kind cards. Kind cards keep their design inside the right column.

Acceptance criteria:
1. Every message type renders: agent, human, system, attachment, handoff, interrupt, permission.
2. Dedup by `data-msg-id`, `trimMessages()` and scroll to the end work as before.

### T06. One row for one message to several agents

Stickies: m08. Priority: Low. Radius: low.
Files: `ui/features/messages.js`, new pure module.

1. A message can have the same `from` and the same `text` as the message directly before it, and a different `to`. When it arrives within 5 seconds of that message, add its recipient to the earlier row. Use `ts`. When `ts` is empty, use the arrival time.
2. Show "→ a, b" and a tag "×2" (the count of recipients).
3. Keep every message `id` on the row (`data-msg-ids`).
4. Do not merge across another message.

Acceptance criteria:
1. Two identical messages to two agents show as one row with "×2".
2. A unit test covers the merge rule, including the 5-second limit and a message in between.

### T07. Chat filters

Stickies: m10. Priority: Low. Radius: low.
Files: `ui/features/messages.js`, `ui/styles/chat.css`.
Wait for open question 3 before you start.

1. Add a segmented control above the log: All, To me, Hide system.
2. "To me" shows messages with `to` equal to the human, and messages that mention the human.
3. "Hide system" hides messages from `system`.
4. Save the choice for each room in `localStorage`. Wrap each read and write in `try`/`catch`.

Acceptance criteria:
1. Each filter shows the correct messages.
2. The choice stays after a reload.

### T08. Composer target chip

Stickies: m12. Priority: Low. Radius: low.
Files: `ui/index.html`, `ui/features/composer.js`, `ui/styles/composer.css`, `ui/features/emoji.js`.

1. The target display shows a chip: "to" in `--text-meta`, then the target in `--text`. The default target reads "room".
2. Keep the `#target` select and its menu.
3. Remove `#emoji-btn`, `#emoji-popover` and the `emoji.js` script only after the human agrees (open question 1).
4. Keep the key hints.

Acceptance criteria:
1. Targets, mentions, slash commands, attach and Send work as before.

### T09. Right pane tab bar

Stickies: m13, b07. Priority: High. Radius: high (terminal pane plumbing).
Files: `ui/terminal.js`, `ui/kinds/ticket.js`, `ui/index.html`, `ui/styles/terminal.css`, `ui/styles/layout.css`.
Ship T09 with T03.

1. Add one tab bar at the top of the right pane. Height `--size-44`.
2. Tabs, left to right: open agent sessions, Shell, Board, Agents (T14 adds this tab, or a full view, see open question 5).
3. An agent tab opens from the left rail. Do not change what the close action does to a tmux session today.
4. The Board tab replaces `#board-toggle-btn`. The session tabs replace `#terminal-toggle-btn`.
5. Add a button at the right end of the bar that closes the pane.
6. Keep the `cubilot:right-pane` event. The board and the terminal still never show together.
7. Save one split for the terminal and one split for the board.
8. Active tab: `--text` and a 2 px `--orange` line at the bottom. Other tabs: `--text-meta`.

Acceptance criteria:
1. The pane switches between a session, Shell and Board. An xterm does not lose its content when you switch.
2. Auto-attach at launch works as before.
3. Each pane kind keeps its own split after a reload.

### T10. Session header

Stickies: m14, m16. Priority: Medium. Radius: low.
Files: `ui/terminal.js`, `ui/styles/terminal.css`.

1. Add a header above the xterm of an agent session. The Shell tab has no header.
2. Row 1: status dot, agent name (mono, `--fs-3xl`, role colour), state text, then "harness · model · effort" from `pty_roles`. At the right: Interrupt, Pause or Resume, Pop out.
3. Row 2 (mono, `--text-meta`): role, factory version and applied time (needs H1), and the hint "Keys go to the terminal, not the room."
4. Interrupt opens a small input. It sends an interrupt as the human through the existing interrupt kind (`POST /interrupts`, 500 characters maximum). Check the route rules for a sender that is the human first.
5. Pause and Resume use the existing pause function for each agent.
6. Pop out opens the session in its own window. This needs new Rust work. Build it only after the human agrees (open question 4).
7. Do not show context %, tokens or cost (see "Mockup errors").

Acceptance criteria:
1. The header shows the correct values for a claude agent and for a pi agent.
2. Interrupt creates an interrupt card in the chat.
3. The xterm keeps its fit after the header is added.

### T11. Board columns and header

Replaced by Part 15 ([15-ticket-card-dialog.md](15-ticket-card-dialog.md)). Build Part 15 instead.

Stickies: b01, b02, b08. Priority: Medium. Radius: low.
Files: `ui/kinds/ticket.js` (`render()`), `ui/styles/kinds.css`, `ui/index.html` (`#ticket-filters`).

1. A column with no visible ticket collapses to a 44 px strip. The strip shows the count, a vertical label and "+".
2. A collapsed column stays a drop target. Use the same `dragover` and `drop` code as today.
3. A column with tickets has full width. The Done column header keeps "Archive all done".
4. The Cancelled column ("Show cancelled") obeys the same rule.
5. Board header: the title "Tickets", then "#room · N open", the Filters button (existing panel) and a "New ticket" button. "New ticket" calls `openNew()` for Queued.

Acceptance criteria:
1. A drag onto a collapsed column moves the ticket.
2. "Archive all done (n)" shows when Done has tickets.
3. The Filters panel and its summary work as before.

### T12. Ticket card layout

Replaced by Part 15 ([15-ticket-card-dialog.md](15-ticket-card-dialog.md)). Build Part 15 instead.

Stickies: b03, b04, b05. Priority: Medium. Radius: low.
Files: `ui/kinds/ticket.js` (`cardHtml()`, `fieldsHtml()`), `ui/styles/kinds.css`, new pure module for title parsing.

1. Top row (mono, `--fs-xs`): the type tag from a leading `[tag]` in upper case, the ID token, and the priority at the right. Use `--amber` for the tag `code` and `--text-muted` for other tags.
2. Priority: four bars and the label. Highest = 4 filled bars, High = 3, Medium = 2, Low = 1, Lowest = 0.
3. Title: `--fs-2xl`, weight 500. Text in brackets at the end of the title moves to a second line in `--text-muted`.
4. Meta row: assignee (circle with the initial, and the name in role colour), "high radius" in `--red-strong` when the radius is high, note count, attachment count, external ref, archived tag.
5. Keep the acceptance criteria `<details>`, the approval line and the notes.
6. Footer row: the status line (T13) at the left, the traffic light at the right. Keep `lightHtml()` and `lightOf()` without change. The colour of the unlit lights waits for open question 2.
7. "Move to", "Assignee" and "Cancel" show only when the card has hover or keyboard focus (`:hover`, `:focus-within`). Hide them with `visibility: hidden`, not `display: none`. The card has `tabindex="0"`, so focus on the card shows them, and Tab then reaches them.
8. The ticket dialog keeps all actions.

Acceptance criteria:
1. `lightOf()` gives the same result as before for every status.
2. Unit tests cover the title parse (with and without a tag, ID and brackets) and the priority bars.
3. Keyboard path: card, then "Move to", then "Assignee", then "Cancel".

### T13. Card status line

Replaced by Part 15 ([15-ticket-card-dialog.md](15-ticket-card-dialog.md)). Build Part 15 instead.

Stickies: b06. Priority: Low. Radius: low.
Files: new pure module, `ui/kinds/ticket.js`.

Build the line from ticket fields only. Use the first rule that matches:

1. Approval pending: "Waiting for your approval".
2. The assignee is the human: "Assigned to you".
3. Status `claimed` or `in_progress`: "<assignee> is working on it".
4. Status `in_review`: "Waiting for a check".
5. Status `queued` with an assignee: "Assigned to <assignee>".
6. Status `queued` with no assignee: "Unassigned".
7. Status `done` or `cancelled`: no line.

Acceptance criteria:
1. A unit test covers each rule.
2. The line never disagrees with the traffic light.

### H1. Hub: read the factory version of each agent

Stickies: a02, a03. Priority: Medium. Radius: high (hub route).
Files: `hub/features/factory.ts`, `CLAUDE.md` (list of read routes), new integration test.

1. Add `GET /factory/agents`. It is a read route. It accepts the bearer header or `?token=`, like `/agents`.
2. Response: `{ version, agents: [{ agent, linked, applied, applied_at_ms, pending }] }`.
3. `version` is `CUBILOT_FACTORY_VERSION`. `applied_at_ms` is the modified time of `<hex>.applied`. `pending` is the content of `<hex>.pending`, or `null`.
4. Map each hex key to an agent name with `agentKey()` over the roster names. Leave out a key that matches no name.
5. With no factory dir, return `{ version: "", agents: [] }`.
6. Run `./scripts/build-sidecars.sh`.

Acceptance criteria:
1. An integration test with a temporary factory dir gets the correct records.
2. A request with no token gets HTTP 401.

### T14. Agent roster view

Stickies: a01, a02, a03, a04, a05, a06, a07. Priority: Low. Radius: low.
Files: new `ui/features/agents-view.js`, new `ui/styles/agents-view.css`, `ui/index.html`.
Needs H1. Wait for open question 5 before you start.

1. "Manage agents" in the left rail opens the view. It fills the area to the right of the rail. A "Back" link returns to the room.
2. Summary strip: Online (online count of total, from the roster), Factory version (H1), Pending reloads (count of agents with `pending`, H1), Hub port (from the hub URL).
3. Buttons: "Reload settings" (the same action as `#reload-btn`) and "Add agent" (the spawn modal).
4. Filter: All, With role, No role. The mockup says "Probes". The app has no probe concept, so use "No role".
5. Table columns: Agent (dot and name), Role, Runtime (harness · model), Now (the activity line from T03), Factory (version and applied time from H1), Cost, actions.
6. Cost: show the Pi cost from Part 11 when it exists. Else show "—". Do not add a Context column (no source).
7. Actions: a "Session" link that opens the session tab, and a "⋯" menu with Pause or Resume, and Remove (offline agents only).
8. Update the view on roster, presence, pause and ticket events.

Acceptance criteria:
1. The table lists every agent in the selected room, or in all rooms with "All rooms".
2. Pending reloads shows a count above 0 after `POST /factory/relink` and 0 after `POST /factory/applied`.
3. The table scrolls sideways in a narrow window. The page does not.

### H2. Backlog: running and waiting states

Stickies: m02. Not part of this build.

The UI cannot tell if an agent is running a turn or waiting. The bridge core already knows: it sets a local `busy` flag in `onRunStart()` and clears it in `onRunEnd()` (`hub/channel/core.ts:221`, `:421-424`). This works for both harnesses. The flag does not reach the hub. A future ticket can report it to the hub and add it to the roster. Part 11 needs the same signal for its "busy or idle" field. Do this work once, for both parts.

## Build order

1. T01.
2. T02, then T03 with T09, then T04.
3. T05, T06, T07, T08.
4. T10.
5. T11, T12, T13.
6. H1, then T14.
7. H2 later, with Part 11.

## Overlap with other parts

- Part 11 (dashboard) has an "Agents" panel and a "Cost" panel. T14 shows the same data. Build T14 so that Part 11 can use it, or move T14 into Part 11 (open question 5).
- Part 11 also needs H2.

## Tests

1. Unit tests: role grouping (T03), message merge (T06), title parse and priority bars (T12), status line (T13), and `lightOf()` for each status (T12).
2. Integration test: `GET /factory/agents` (H1).
3. Manual checks for each ticket:
   - all three themes
   - window widths of 1024 px and 1440 px
   - the keyboard path through the changed controls
   - drag and drop onto a collapsed column (T11)
   - the needs-attention pulse on a rail row (T03)
   - "Reload settings" from the title bar and from the roster view (T02, T14)

## Open questions for the human

1. m12: remove the emoji button? It removes a function that works today.
2. b04: keep the grey unlit lights of the traffic light, or use the dimmed red, amber and green of the mockup?
3. m10: keep the "To me" filter or the pins strip (`ui/features/pins.js`, not loaded in `index.html` yet)? Keep one of them.
4. m14: build "Pop out" for a session window? It needs Rust work.
5. a01: make the Agent roster its own view, or a part of the Part 11 dashboard?
6. m03: keep the room menu in the title bar as well as the room list in the rail?

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
