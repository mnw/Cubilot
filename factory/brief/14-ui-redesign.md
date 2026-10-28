# Part 14: UI redesign (browser UI)

Status: ready to plan (decisions of the human, 2026-10-28). Build it directly after Part 12, on the UI that the hub serves to the browser and to the desktop window. The design work is done: the token system is in `design/system/`, and the mockups are in `design/mockups/` (Part 16, "Done before the council"). The first version of this part (mockup of 2026-10-22, IDs `m01` to `a07`) is replaced; it is in `factory/_to_delete/replaced-2026-10-28/` and in git history. Do not use it.
Reader: the Orchestrator. Split this part into tickets. The section "Tickets" gives the tickets with acceptance criteria.

## Source

- `design/mockups/cubilot-prototype.html`: every screen, desktop and phone, dark and light, in one page. Open it in a browser (Playwright). Each screen has an address after `#`, listed in `design/mockups/README.md`. The prototype bar picks Dark or Light and Desktop or Phone.
- `design/mockups/COVERAGE.md`: every feature of the current UI and the hub (112 rows), the element that shows it and the screen. This part is done when every row works in the built UI.
- `design/system/tokens.json` and `design/system/README.md`: the token system. Three themes, contrast of 4.5:1 or more for every text token, six font sizes.
- The canvas "Cubilot Browser UI" in claude.ai is private to the human. Agents read only the files in the repository.
- The data in the mockups is invented.

## Goal

One browser UI for the desktop window and for any browser, built so that the human acts at two moments: the Approve at the start and the test at delivery.

Navigation (the same on every screen):
1. **Top bar:** brand, room switcher (with "New room"), search (⌘K: tickets, requests, agents by id or name), LEAD select, Pause room with its state, Add agent, then icons for room instructions, factory map, project folder, settings, and the account.
2. **Section tabs:** Decisions (with its count), Requests, Flow, Dashboard, Room, Agents, Delivery. A breadcrumb at the right goes up one level.
3. **Links:** every id and name opens its screen (decision → ticket or request; ticket stage → agent session; request row → plan).
4. **Status bar:** agents online, hub port, `staging` commit and install, Session and Weekly usage.
5. **Phone:** the same screens in one column, a bottom bar (Decisions, Flow, Room, Agents, More), 44 px or more for every control, 16 px in every input.
6. **Addresses:** each screen and each open ticket, request or agent has its own URL, so the browser Back button and links work.

## Rules for this part

1. Obey `CLAUDE.md`. The UI stays vanilla HTML, CSS and JS. Do not add a framework, a bundler or a build step.
2. Tokens: the first ticket (T01) moves `design/system/tokens.json` into `ui/styles/tokens.css`. After T01, do not write a colour, font size, spacing or radius outside `tokens.css`. Put each new token in the correct layer (skin or structural).
3. Keep all three themes working: `default` (warm dark), `rose-pine-dawn` (light) and `rose-pine-moon`. The mockups show dark and light; Moon uses the same structure. Theme choice: System (default), Warm dark, Dawn light, Moon (Settings, Appearance).
4. Fonts: the bundled Inter (`--sans`), JetBrains Mono (`--mono`) and Fraunces (`--serif`, brand and nutshell only). Do not load a web font.
5. Font sizes: only `fs-sm` 12, `fs-base` 14, `fs-md` 16, `fs-lg` 18, `fs-xl` 22, `fs-2xl` 28 px, each multiplied by `--ui-font-scale` (`font_scale` in `config.yml`). The terminal stays 13 px (12 px on a phone), set in xterm.
6. Use real `<button>`, `<a>`, `<select>`, `<input>` and `<label>` elements. Every action works from the keyboard and has a visible focus.
6a. Accessibility target (decision 2026-10-28): WCAG 2.2 AA. Screen-reader checks (VoiceOver and NVDA) start with this part.
7. Put new pure logic in small modules that run in node, like `ui/features/pill-card.js`. Test them with `bun test` in `tests/unit/`.
8. In the desktop window, keep space for the macOS window buttons and the drag region (`titleBarStyle: Overlay`, `data-tauri-drag-region`) at the left of the top bar. In a browser, there is no such space.
9. After a change in `hub/`, run `./scripts/build-sidecars.sh`. Use `./scripts/install.sh` for app rebuilds.

## Keep: do not remove

Every row of `design/mockups/COVERAGE.md` stays, also the section "Kept from the current UI": the ticket traffic light (keep `lightOf()` without change), "Archive all done", the agent hover card, the needs-attention pulse, and the window buttons space. A ticket that removes one of them fails review.

## Tickets

Each screen ticket has these criteria, in addition to its own:
- **Matches the mockup.** The Validator opens the built screen and the prototype screen (same address, same theme) with Playwright at 1440 px and at 390 px, and compares the screenshots. Blocking: a difference in layout, hierarchy, content, states or navigation, or a value outside the tokens. Suggestion: small visual differences.
- **Works.** Every COVERAGE.md row for the screen works against the live hub.
- **Accessible.** Keyboard path through all controls, visible focus, text contrast 4.5:1 or more measured in the three themes.

| Ticket | Scope | Screens | Radius |
|---|---|---|---|
| T01 | Tokens: move `design/system/tokens.json` into `ui/styles/tokens.css`; map the old `--fs-*` steps to the six sizes (see `design/system/README.md`). A check lists each value in `ui/` outside the tokens. | none | low |
| T02 | App shell: top bar, section tabs, breadcrumb, status bar, phone bottom bar and More, addresses for each screen, ⌘K search, the room switcher. | all | high (navigation of the whole UI) |
| T03 | Decisions: cards for choose, approve, allow, review; "Decided today without you" with Overrule. | `#decisions` | low |
| T04 | Requests and Request: start a request, list, plan view with Approve once and Send back. | `#requests`, `#request` | low |
| T05 | Flow and ticket: board with traffic lights, filters, Move to menu, Archive all done; the new and edit form; the Ticket screen. | `#flow`, `#ticket-new`, `#ticket` | high (replaces the board and the dialog of Part 15) |
| T06 | Room: chat, nutshell, filters, composer with target, mention and slash menus; the kind cards; pins; transcript controls. | `#room`, `#room-cards` | low |
| T07 | Agents and session: list, launch form, agent menu with MCP servers, Shell tab, finished sessions; the terminal over the hub (Part 12) with take control, hand back and the phone key strip. | `#agents`, `#session` | high (writes into live sessions) |
| T08 | Delivery: checks, decided without you, Accept or Send back. | `#delivery` | low |
| T09 | Settings: Appearance, Config and hub, Agents, Room, Cancel traces. The Security section comes with Part 12 sign-in. | `#app-settings` | low |
| T10 | Dialogs and toasts: factory room, nutshell editor, confirm, reason, MCP servers, launch command; toasts. | `#dialogs` | low |
| T11 | Dashboard shell: the layout, with "Waiting for you" and "Stuck" (no new data). The other panels come with Part 11. | `#dashboard` | low |
| T12 | Sign-in screens on the tokens, when Part 12 "Internet access and sign-in" exists. | `#sign-in`, `#sign-in-states` | high (security) |

## Hub work the screens need

Most screens show data the hub has today (checked against `hub/` on 2026-10-28). These elements need data or routes that do not exist yet. Each row names the part that delivers it. A screen ticket does not wait for a row it does not need: it shows the element when the data exists.

| Screen | Element | Delivered by |
|---|---|---|
| Decisions, Room, Ticket | Decision cards, questions with options, rulings, Overrule, "Decided without you" | Part 6 (`decision` Kind: `POST /decisions`, `/answer`, `/overrule`) |
| Request | Plan with radius source, features, scope changes since the Approve | Part 6 (P6-02, P6-03) |
| Delivery | Delivery report: done tickets, rulings, criteria edits, suite result, live-check steps | Part 6 (`GET /requests/<room>/<id>/delivery`, P6-08) |
| Delivery | FAILs and fixes per ticket, build time, cost, merge command | **H8** |
| Decisions, Room, Ticket | Read route for decisions with card kind, radius, time asked, waiting tickets, FAIL history; "Decided today without you" | **H7** |
| Delivery | The human's mark for each check (works or problem), note and screenshot | **H3** (this part) |
| Agents, Dashboard | Context % of each agent | Part 6 (P6-11) |
| Agents, Dashboard | Model pair and its source; first-pass rate per pair | Part 6 item 6 (model routing) |
| Flow, Dashboard | Stalls, slots, stuck items | Part 6 items 9 and 10 (flow report, stop rules) |
| Dashboard | Roadmap, milestones, burn-up, quality, cost, queue, graphs | Part 11 (section "Mockups") |
| Session | Terminal stream over the hub, take control, hand back, held messages | Part 12 |
| Sign in, Settings Security | Sign-in, sessions, devices, step-up, sign-in log | Part 12 |
| Ticket, Decisions, Dashboard | "Why it failed", trace, failures, check a diagnosis, results per tier (`#why-it-failed`) | OpenSpec change `stage-diagnosis` |
| Requests | List of requests with status, tickets done of total, high radius count, updated time | **H1** |
| Ticket | Code: branch head, on `staging` or not, files and lines changed, link to the diff | **H2** |
| Header | Search (⌘K) over tickets, requests and agents by id or name | **H4** |
| Room | Reply to a message (a reference to the earlier message) | **H5** |
| Room | Filters "To you and from you", "Questions only", and the count of hidden agent messages | UI only (T06), from the message fields |
| Room | Pins | UI only: `ui/features/pins.js` exists but is not loaded in `index.html` (T06) |
| Settings | Theme "System" (follow the operating system) | UI only (T09); `config.yml` `theme` gets the value `system` |
| Settings | Default model for new agents | **H6** |

Hub tickets of this part (radius low unless stated):
- **H1** `GET /rooms/<room>/requests`: each request with origin, status (draft, waiting for Approve, building, ready for test, merged), tickets done of total, high-radius count, last event time.
- **H2** `GET /tickets/<id>/code`: branch, head commit, merged into `staging` or not, files and lines changed (from git in the room's project). Read-only.
- **H3** `POST /requests/<room>/<id>/delivery/checks` (human only): the mark for one check (`works` or `problem`), a note, and attachments; a `problem` adds the note to the ticket of that check and reopens it. Radius high (human-only route, moves tickets).
- **H4** `GET /search?q=`: tickets, requests and agents of the rooms the caller can see, by id prefix or name.
- **H5** Message reference: an optional `reply_to` (message id) on `POST /send`; the chat shows the quoted line.
- **H6** `default_model` in `config.yml`, read by the launch form.
- **H7** `GET /rooms/<room>/decisions?state=&since=` (Part 6 has only POST routes for decisions). Each row: id, card kind (choose, approve, review; derived from `decider`, `reason` and the request state), ticket or request, the radius of that ticket or request, time asked (event `ts`), the tickets that wait on it (from `blocked_by`), `block`, a summary (`text`, or `block` for a human decision), `options` with the recommended one (the cost of an option goes in its effect text, no new field), `facts`, the FAIL history (handoff ids with their finding counts, not only `fail_count`), `decider`, state. `state=applied&since=<start of day>` gives "Decided today without you". Source: the Orchestrator's comparison of 2026-10-28 (staging 763395b).
- **H8** Additions to the delivery report `GET /requests/<room>/<id>/delivery` (Part 6, P6-08): for each ticket the FAIL handoffs with their findings and the fix commit; build time (first claim to last done); cost (Claude stage tokens from the stage metrics; Pi stages show "no data"); the merge command for `staging` into `main`; the decision id on each ruling row, if Part 6 does not add it.

## Build order

1. T01, and H1 to H8 in parallel (hub only).
2. T02.
3. T03 to T10, in parallel within the room slots. T05 and T07 first, because the human uses them most.
4. T11.
5. T12, after the sign-in of Part 12.

## Overlap with other parts

- Part 11 (dashboard) fills the panels of T11: roadmap, milestones from `openspec/changes`, burn-up, flow, quality, cost, agents, model pairs, queue and graphs.
- Part 12 builds the terminal stream, the sign-in and the sessions; this part builds their screens.
- Part 15 (ticket card and dialog, done) is replaced by T05.
- These screens are designed but are built by their own part, on the browser UI, after this part: stage diagnosis (`#why-it-failed`, Part 4), Deliver to client (`#deliver`, Part 5), setup and admin (`#setup`, `#setup-components`, `#setup-install`, `#setup-accounts`, `#admin`, Parts 7 and 8), mutation result (`#mutation`, Part 13). Each part names them in its section "Mockups".
- Parts 9, 10, 16 and 17 (councils) list the screens that are not designed yet.

## Tests

1. Unit tests for each new pure module (routing, the traffic light mapping, the font-size mapping of T01).
2. For each screen ticket: the Validator's screenshot comparison at 1440 px and 390 px, dark and light, plus Moon once.
3. Keyboard and screen reader: the path through each screen with VoiceOver and with NVDA.
4. Contrast: measure every text in each screen in the three themes. No text that gives information is below 4.5:1. Record the measurements.
5. COVERAGE.md: a checklist run against the live hub; every row is checked.
6. H1 to H8: an integration test for each route (H3 also: an agent token gets 403, and a `problem` mark reopens the ticket with the note).

## Open questions for the human

1. More than one human account (Part 12, open question 4)? The answer changes Settings and the sign-in screens.
2. Keep Moon as a third theme in the theme switch?

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
