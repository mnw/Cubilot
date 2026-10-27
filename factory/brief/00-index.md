# Implementation brief: Cubilot (index)

Scope: roles, rebrand, toolchain, dashboard, mutation testing, context checkpoints, browser access, Linux, review patterns, sessions, client delivery, setup. Councils for SEO and for accessibility.

Status: research and design only. This brief does not change app code.
Date: 2026-10-16. Line numbers refer to the working tree on that date, with the uncommitted ticket-kind work.

**Migration: done** on 2026-10-21. The source of the code is in `../../MIGRATION.md`.

## Goal

The app has the name Cubilot (Part 1, done). The app must also launch any agent with a factory role, and must launch a full factory team in one action. A role gives the agent its instructions, its model, its tool limits and only its own skills. The role definitions and skills are in `factory/` (see `README.md`).

The brief has sixteen parts. The numbers follow the build order (decision 2026-10-19). Each part is one file in this folder:
1. [01-rebrand.md](01-rebrand.md): Rebrand to Cubilot (done). The names in use, the open items, and how to retire the previous app.
2. [02-factory-roles.md](02-factory-roles.md): Factory roles (done): launch agents with a role. First, use a launch script, before the app work.
3. [03-ticket-grouping-checkpoints.md](03-ticket-grouping-checkpoints.md): Ticket grouping (done): requests, `blocked_by` and the `draft` status. The context checkpoints stay an idea.
4. [04-sessions.md](04-sessions.md): Visible sessions (in test): no sub-agents, and one new session for each ticket stage. First, use a ticket runner outside the app.
4a. [04a-agent-column.md](04a-agent-column.md): Agent column (done). The agents move to a left column in every view, with Reload for one agent and a switch for each skill. The human asked for it on 2026-10-24, so that Part 4 can be tested. Design note for the skill switches: [04a-c6-design.md](04a-c6-design.md).
5. [05-delivery-backup.md](05-delivery-backup.md): Internal remote, clean delivery to the client, backups and recovery. You can set up the hourly backup at once.
6. [06-warp-patterns.md](06-warp-patterns.md): Patterns from the Warp cloud factory: triage states, a spec stage, the `review.json` format, the trust boundary, follow-up reviews. Also model routing for Workers (item 6), and the Orchestrator checkpoint (item 7, build it first). Build Part 6 before Part 5 (decision 2026-10-26).
7. [07-toolchain.md](07-toolchain.md): Toolchain: the app installs and gives each agent Graphify, ripgrep, fd and Serena.
8. [08-setup-admin.md](08-setup-admin.md): Setup and admin screen: install, sign in, add projects, check and update.
9. [09-a11y-council.md](09-a11y-council.md): Accessibility and usability council. It builds the council form. It works on live pages, code, documents and Figma designs.
10. [10-seo-council.md](10-seo-council.md): SEO council: the same council form, for SEO, AEO and GEO.
11. [11-dashboard.md](11-dashboard.md): Progress dashboard: what waits for the human, what is stuck, flow, quality and cost.
12. [12-hub-first-linux.md](12-hub-first-linux.md): Hub-first architecture, browser access and Linux hosting (idea).
13. [13-mutation-testing.md](13-mutation-testing.md): Mutation testing: advisory first, opt-in for each project. Last, because of its risk.
14. [14-ui-redesign.md](14-ui-redesign.md): UI redesign (refined warm terminal). One agent rail, one title bar and a compact chat log. One tab bar for the right pane, clearer ticket cards and an Agent roster view.
15. [15-ticket-card-dialog.md](15-ticket-card-dialog.md): Ticket card and ticket dialog redesign (done). It replaces T11, T12 and T13 of Part 14.

## How to use these files

- Each part is complete in its file. It names other parts as "Part N". Find Part N in the list above.
- Build order: the parts in their number order, with one exception. Part 6 comes before Part 5 (decision 2026-10-26). Part 6 makes the work of the agents more reliable. Part 5 is a local item that can wait. Parts 2 and 4 have a fast path outside the app: a launch script and a ticket runner. You can set up the hourly backup of Part 5 at once.
- Why this order: Parts 1 to 5 make a working factory with fresh sessions and safe delivery. Parts 6 to 10 add the review format, the toolchain, the setup screen and the two councils. Parts 11 to 13 are improvements, the Linux move, and the part with the most risk.
- The order of Parts 1 and 2 changed on 2026-10-21: the rebrand is now first.
