# Implementation brief: Cubilot (index)

Scope: roles, rebrand, toolchain, dashboard, mutation testing, context checkpoints, browser access, Linux, review patterns, sessions, client delivery, setup. Councils for SEO and for accessibility.

Status: research and design only. This brief does not change app code.
Date: 2026-10-16. Line numbers refer to the working tree on that date, with the uncommitted ticket-kind work.

**Migration: done** on 2026-10-21. The source of the code is in `../../MIGRATION.md`.

## Goal

The app has the name Cubilot (Part 1, done). The app must also launch any agent with a factory role, and must launch a full factory team in one action. A role gives the agent its instructions, its model, its tool limits and only its own skills. The role definitions and skills are in `factory/` (see `README.md`).

The brief has eighteen parts. The numbers follow the build order (decision 2026-10-19). Each part is one file in this folder:
1. [01-rebrand.md](01-rebrand.md): Rebrand to Cubilot (done). The names in use, the open items, and how to retire the previous app.
2. [02-factory-roles.md](02-factory-roles.md): Factory roles (done): launch agents with a role. First, use a launch script, before the app work.
3. [03-ticket-grouping-checkpoints.md](03-ticket-grouping-checkpoints.md): Ticket grouping (done): requests, `blocked_by` and the `draft` status. The context checkpoints stay an idea.
4. [04-sessions.md](04-sessions.md): Visible sessions: no sub-agents, and one new session for each ticket stage. Done (2026-10-28): stage sessions, spec review and the context pack are archived. Stage diagnosis is proposed (`openspec/changes/stage-diagnosis`) and is built later, after Part 6 items 7 and 11.
4a. [04a-agent-column.md](04a-agent-column.md): Agent column (done). The agents move to a left column in every view, with Reload for one agent and a switch for each skill. The human asked for it on 2026-10-24, so that Part 4 can be tested. Design note for the skill switches: [04a-c6-design.md](04a-c6-design.md).
5. [05-delivery-backup.md](05-delivery-backup.md): Internal remote, clean delivery to the client, backups and recovery. You can set up the hourly backup at once.
6. [06-warp-patterns.md](06-warp-patterns.md): Patterns from the Warp cloud factory: triage states, a spec stage, the `review.json` format, the trust boundary, follow-up reviews. Also model routing for Workers (item 6), the Orchestrator checkpoint (item 7, build it first), and process guards from real use on 2026-10-27: a plan check before spec review (item 8), a flow report (item 9) and the stop rules in the hub (item 10). Item 11 (decision 2026-10-27) limits the human to the start of a request and the delivery; an arbiter stage decides between them. Item 15 (decision 2026-10-29): a waiting or failed ticket stops only itself; blockers clear on merge into staging; spec FAILs count per ticket. Item 16 (decision 2026-10-29): plans for parallel work; a blocker only when code is needed, contract tickets first, merge behind a switch. Order inside the part: 16 and 15, then 11 and 7, then 8, 9, 10, 6, then 1 to 5. Build Part 6 before Part 5 (decision 2026-10-26).
7. [07-toolchain.md](07-toolchain.md): Toolchain: the app installs and gives each agent Graphify, ripgrep, fd and Serena.
8. [08-setup-admin.md](08-setup-admin.md): Setup and admin screen: install, sign in, add projects, check and update.
9. [09-a11y-council.md](09-a11y-council.md): Accessibility and usability council (councils come at the end of the build order, decision 2026-10-28). It builds the council form. It works on live pages, code, documents and Figma designs.
10. [10-seo-council.md](10-seo-council.md): SEO council: the same council form, for SEO, AEO and GEO.
11. [11-dashboard.md](11-dashboard.md): Progress dashboard: what waits for the human, what is stuck, flow, quality and cost.
12. [12-hub-first-linux.md](12-hub-first-linux.md): Hub-first architecture, browser access, sign-in for internet access (decision 2026-10-28) and Linux hosting (planned). Build it directly after Part 6 (decision 2026-10-27).
13. [13-mutation-testing.md](13-mutation-testing.md): Mutation testing: advisory first, opt-in for each project. The last part before the councils, because of its risk.
14. [14-ui-redesign.md](14-ui-redesign.md): UI redesign of the browser UI. Build it directly after Part 12 (decisions 2026-10-28). The specification is the mockups in `design/mockups/` and the tokens in `design/system/`, made with the human on 2026-10-28: top bar, section tabs, every screen on desktop and phone, dark and light.
15. [15-ticket-card-dialog.md](15-ticket-card-dialog.md): Ticket card and ticket dialog redesign (done). It replaces T11, T12 and T13 of Part 14.
16. [16-design.md](16-design.md): Design council (decisions 2026-10-28): capture, two members on two models, chair; called by hub rules and Jev; OpenPencil. At the end, with the other councils, after Part 9. The design team step is folded into it: the token system and the Part 14 mockups are done.
17. [17-plan-council.md](17-plan-council.md): Plan council (needs work: first draft, not ready to plan, 2026-10-28): two members on two models (Claude opus, OpenAI `openai-codex` on Pi) write the plan of each human request blind; code compares them; the arbiter decides conflicts; the human approves one merged plan. At the end of the build order, after Part 10.
18. [18-lean-flow.md](18-lean-flow.md): Lean flow (decision 2026-10-29). No spec review per ticket; the code is judged, not the plan. One Approve per request, blockers only for code and cleared on merge into staging, edits keep the status, high radius means two Validators instead of a human Allow. Measured cause in the ledger. Build it first.
19. [19-arbiter.md](19-arbiter.md): Arbiter (moved out of Part 6, decision 2026-10-30). A stage that decides the next step after a second review FAIL. Built only if the 1-week measure of Part 18 shows enough second FAILs waiting for the human.
20. [20-test-throughput.md](20-test-throughput.md): Test throughput (decision 2026-10-30). Low tickets run the affected tests, high tickets keep the full suite; one staging suite per batch with a bisect; no duplicate staging run; measure, then faster tests and maybe two suites at once. First after Part 6.
21. [21-retrospective.md](21-retrospective.md): Weekly retrospective, the self-improvement loop (decision 2026-10-30). Code collects a week of evidence; one read-only stage checks earlier improvements (keep or revert) and proposes at most 3 changes with a target measure; the human approves. After Part 20.

## How to use these files

- Each part is complete in its file. It names other parts as "Part N". Find Part N in the list above.
- Build order: the parts in their number order, with these exceptions. Part 6 comes before Part 5 (decision 2026-10-26). Part 12 comes directly after Part 6, before Part 5 (decision 2026-10-27): the desktop app approach limits the factory, and Parts 7, 8, 11 and 14 must be built on the hub-served UI from the start. Part 18 (lean flow, decision 2026-10-29) comes first and wins over older parts where they disagree. The order is 18, 1, 2, 3, 4, 6, 20, 21, 12, 14, 5, 7, 8, 11, 13, then the councils: 9, 16, 10, 17. Part 19 (arbiter) waits for the Part 18 measure. The councils come last (decision 2026-10-28): they are the right direction, but they need much code and testing. The design team step (16a) is folded into Part 16: the token system and the mockups for Part 14 are done (`design/system/`, `design/mockups/`). Part 16 (design council) comes with the other councils at the end, after Part 9, which builds the council form (decisions 2026-10-28). Part 14 follows Part 12, so the redesign is done once, on the browser UI. Part 6 makes the work of the agents more reliable. Part 5 is a local item that can wait. Parts 2 and 4 have a fast path outside the app: a launch script and a ticket runner. You can set up the hourly backup of Part 5 at once.
- Why this order: Parts 1 to 5 make a working factory with fresh sessions and safe delivery. Parts 6 to 10 add the review format, the toolchain, the setup screen and the two councils. Part 12 makes the UI reachable from a browser and the hub able to run on Linux. Parts 11 and 13 are improvements and the part with the most risk.
- The order of Parts 1 and 2 changed on 2026-10-21: the rebrand is now first.
