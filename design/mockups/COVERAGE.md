# Coverage: every feature and its screen

89 features from `ui/` and the hub routes (staging a0a89b1, 2026-10-28), plus sign-in (Part 12) and the dashboard (Part 11). Each feature has an element in the mockups. Part 14 is done when every row works in the built UI.

Screen names are the prototype screens (`cubilot-prototype.html`, prototype bar, "Screen"). Light and phone versions exist for the screens that list them in README.md.

## Sign-in (Part 12)

| Feature | Element | Screen |
|---|---|---|
| Sign in with a passkey | Sign-in page | Login |
| Password and TOTP code fallback | Fallback state | SignInStates |
| Recovery codes | Save codes state · Settings Security | SignInStates, Settings |
| First run: owner account with setup code | First-run state | SignInStates |
| Lock after 5 failures | Locked state | SignInStates |
| Step-up for risky actions | Confirm it is you dialog | SignInStates |
| Sessions and devices, sign out others, pair a phone | Security section | Settings |
| Sign-in log | Security section | Settings |

## Rooms

| Feature | Element | Screen |
|---|---|---|
| Switch room | Room switcher # cubilot ▾ | Room (open state) |
| New factory room (name, folder, workers, testers) | + New room · New factory room dialog | Dialogs, Agents |
| Pause room / resume room | Pause room + state | every desktop header |
| Room lead (triages unassigned) | LEAD Orchestrator ▾ · Settings Lead | header, Settings |
| Nutshell: read, propose edit | Nutshell bar · Edit dialog | Room, Dialogs |
| Persist transcript, auto-summary | Toggles | Room, RoomCards, Settings |
| Archive transcript, start fresh | Archive transcript… button | RoomCards, Settings |
| Room settings: stage timeout, role limits | Room # cubilot section | Settings |
| Cancel traces: list, clear | Cancel traces section · Flow footer link | Settings, Flow |

## Chat

| Feature | Element | Screen |
|---|---|---|
| Send to orchestrator, an agent or All | @ target menu | RoomCards |
| Interrupt an agent | ⚠ Interrupt … in the target menu · reason dialog | RoomCards, Dialogs |
| @ mentions | Mention popover | RoomCards |
| Slash commands to an agent session (47) | / command popover | RoomCards |
| Emoji | ☺ button | Room, RoomCards |
| Attach file / paste image | 📎 button · attachment chip | Room, RoomCards |
| Key hints, Shift+Tab modes | Hint row under the composer | Room |
| Copy message, pin, reply | Hover toolbar on a message | RoomCards |
| Pinned messages, unpin | Pinned bar | RoomCards |
| Image in a message | Image tile, open full size | RoomCards |
| Filter: to/from you, all agents, questions | Filter chips | Room |
| Orchestrator question with options | Question card A/B | Room, Decisions |

## Kinds in chat

| Feature | Element | Screen |
|---|---|---|
| Handoff: accept, decline, cancel | Handoff card · decline reason dialog | RoomCards, Dialogs |
| Permission: allow, deny, dismiss | Permission card | RoomCards |
| Interrupt: acknowledge | Interrupt card | RoomCards |
| Stage: result, watch, report | Stage card | RoomCards |

## Decisions

| Feature | Element | Screen |
|---|---|---|
| Decisions waiting for you | Decision cards, counts per type | Decisions |
| Plan approval | Approve plan card · Request page | Decisions, Request |
| Ticket approval (Allow merge) | Allow card | Decisions |
| Third review / queue | Review card | Decisions |
| Decided without you, overrule | List with Overrule | Decisions, Delivery, Ticket |

## Requests

| Feature | Element | Screen |
|---|---|---|
| Start a request | Start a request box | Requests |
| List requests by status | Requests table | Requests |
| Plan: tickets, radius, waits for, checks | Request page | Request |
| Approve once / send back with a note | Your decision panel | Request |

## Tickets

| Feature | Element | Screen |
|---|---|---|
| Board by column | Flow columns with counts | Flow |
| New ticket (per column or global) | + in column · + New ticket · form | Flow, TicketForm |
| Title, criteria editor (bold, list, checklist, code) | Criteria editor toolbar | TicketForm |
| Radius with reason, priority, assignee, ref, request | Form fields · Properties | TicketForm, Ticket |
| Blockers: search, add, remove | Waits for chips | TicketForm, Ticket chain |
| Attachments: add, replace, remove | Attachments | TicketForm, Ticket |
| Move to column, assign, archive, cancel | ⋯ menu · Actions | Flow, Ticket |
| Claim / reassign | reassign link | Ticket |
| Notes and rulings | Rulings list · Add note | Ticket |
| Copy ticket id | Copy button · menu | Ticket, Flow |
| Filters: id, radius, request, priority, archived, cancelled | Filters popover · active chips | Flow |
| Stages and criteria status | Stages, Criteria | Ticket |
| Code: branch head, on staging, diff | Code panel | Ticket |

## Agents

| Feature | Element | Screen |
|---|---|---|
| Launch agent: name, role or none, Claude or Pi | Launch form | Agents |
| Model grid with filter | Model tiles | Agents |
| Folder, room, new / continue / resume session | Launch form | Agents |
| Room role limit notice | Amber line | Agents, header Add agent |
| Live sessions with context % | Sessions list | Agents, Session |
| Live terminal, read-only, take control, hand back | Terminal + control bar · phone key strip | Session, SessionPhone |
| Side by side sessions | Layout toggle | Session |
| Scratch shell | Shell tab | Agents |
| Reload status, relaunch to apply | Agent ⋯ menu | Agents |
| Pause one agent | Agent ⋯ menu | Agents |
| Open editor at agent, skills folder | Agent ⋯ menu | Agents |
| MCP servers per agent, turn all on | MCP submenu | Agents |
| Kill session, remove agent | Agent ⋯ menu (confirm) | Agents |
| Finished sessions (544) | Finished list | Agents |
| Launch command | Launch command dialog | Agents, Dialogs, Settings |

## Dashboard (Part 11)

| Feature | Element | Screen |
|---|---|---|
| Roadmap: brief parts in build order | Roadmap track: done, building, planned, councils | Dashboard |
| Milestones of the active openspec change (tasks.md sections) with waits-for links | Milestone graph, progress per milestone | Dashboard |
| Burn-up: tasks done against scope, projected finish | Burn-up chart and tiles | Dashboard |
| Other changes: draft and archived | Change rows with milestone bars | Dashboard |
| Waiting for you, stuck, flow, quality, cost, agents with harness and model | Factory health panels | Dashboard |
| Model pairs first-pass rate and cost (Jev decision) | Model pairs panel | Dashboard |
| Stage queue, graph freshness | Queue and graphs panel | Dashboard |

## Delivery

| Feature | Element | Screen |
|---|---|---|
| Delivery report: stats, checks | Delivery page | Delivery |
| Mark check works / problem, note, screenshot | Check rows | Delivery |
| Accept or send back | Your verdict | Delivery |
| Stage metrics | Stat tiles · link | Delivery, Flow |

## App and hub

| Feature | Element | Screen |
|---|---|---|
| Theme | Theme switch | Settings |
| Text size, fonts | Text size, font fields | Settings |
| config.yml, apply and restart hub | Config and hub | Settings, toast |
| Global MCP servers | Edit… dialog | Settings, Dialogs |
| Hub status, agents online | Status bar · Settings Hub | every desktop footer |
| Usage: session cost, weekly | Status bar | every desktop footer |
| Search ⌘K | Search box | header |
| Launch result | Toasts | Dialogs |

## Kept from the current UI

| Feature | Element | Screen |
|---|---|---|
| Ticket traffic light: red waits for the human, orange an agent works, green no one works, no light for done and cancelled (`lightOf()`, `ui/kinds/ticket.js`) | Light on each card | Flow |
| Archive all done | Button in the Done column | Flow |
| Agent hover card: role, harness, model, provider, effort (`ui/features/pill-card.js`) | Agent rows show harness and model; the full card opens on hover | Agents, Dashboard |
| Needs-attention pulse on an agent | Amber dot and state on the agent row | Agents, Session |
| macOS window buttons and drag region when the UI runs in the desktop window | Space at the left of the top bar (desktop app only) | every desktop screen |
