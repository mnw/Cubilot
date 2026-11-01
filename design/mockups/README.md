# Cubilot browser UI mockups (2026-10-28)

The specification of Part 14 (`factory/brief/14-ui-redesign.md`). Made with the human in claude.ai design artifacts; see Part 16, "Done before the council".

## Files

- `cubilot-prototype.html`: one self-contained page with every screen. Open it in a browser. The prototype bar (bottom right) picks the screen, Dark or Light, and Desktop or Phone. Links and tabs work; actions show a short message. Each screen has its own address after `#` (below), so a test can open it directly.
- `COVERAGE.md`: every feature of the current UI and the hub, the element that shows it, and the screen. Part 14 is done when every row works in the built UI.
- Tokens: `../system/tokens.json` and `../system/README.md`.

## Screens

| Screen | Address | Phone | Shows |
|---|---|---|---|
| Sign in | `#sign-in` | yes | passkey sign-in, password and code fallback (Part 12) |
| Sign-in states | `#sign-in-states` | no | first run, recovery codes, fallback, lock, step-up |
| Decisions | `#decisions` | yes | what waits for the human; decided without you, with Overrule |
| Requests | `#requests` | yes | start a request; list by status |
| Request | `#request` | yes | the plan to approve: tickets, radius, waits for, delivery checks |
| Flow | `#flow` | yes | board by column with traffic lights, filters, Move to menu |
| New ticket form | `#ticket-new` | yes | create and edit a ticket |
| Ticket | `#ticket` | yes | stages, criteria, rulings, notes, properties, code, chain, actions |
| Dashboard | `#dashboard` | yes | roadmap, milestones of the active openspec change, burn-up, factory health (Part 11) |
| Room | `#room` | yes | chat with the Orchestrator, nutshell, filters, composer |
| Room · cards and menus | `#room-cards` | no | handoff, permission, interrupt, stage and image cards; pins; target, slash and mention menus |
| Agents | `#agents` | yes | launch form, agent menu with MCP servers, Shell tab, finished sessions |
| Agent session | `#session` | yes | live terminal (xterm over the hub), take control, hand back; phone key strip |
| Delivery | `#delivery` | yes | the human's checks, decided without you, Accept or Send back |
| Settings | `#app-settings` | no | security, appearance, config and hub, agents, room, cancel traces |
| Stage diagnosis | `#why-it-failed` | yes | Why it failed on a ticket, trace, failures and Check a diagnosis on Decisions, results per tier (Part 4) |
| Mutation result | `#mutation` | no | score, threshold, survivors with bands, on the Ticket screen (Part 13) |
| Deliver to client | `#deliver` | no | Deliver step, leak gate, approval, push (Part 5) |
| Admin | `#admin` | no | checks (Doctor), components, accounts, projects, backup, updates (Parts 5, 7, 8) |
| Setup 0 · start | `#setup` | no | new factory or restore (Part 8) |
| Setup 1 · components | `#setup-components` | no | components with size and status |
| Setup 3 · install | `#setup-install` | no | status per step, Retry and Skip, live log |
| Setup 4 · accounts | `#setup-accounts` | no | sign-ins in a terminal pane, backup password once |
| Dialogs and toasts | `#dialogs` | no | factory room, nutshell editor, confirm, reason, MCP servers, launch command, toasts |
| Coverage | `#coverage` | no | the table in COVERAGE.md |

## Rules for readers

- The data in the screens is invented. The dashboard says "example state".
- Do not copy the markup into `ui/`. It is a design file with inline styles. Build with `ui/styles/tokens.css` and the rules of Part 14.
- Screens without a phone version open as one column on a phone; dialogs open as a full-height sheet.
