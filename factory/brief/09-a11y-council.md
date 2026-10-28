# Part 9: accessibility and usability council

Status: decision 2026-10-19. At the end of the build order (decision 2026-10-28): the councils are the right direction, but they need much code and testing, so they come after everything else. It is the first council part. It builds the council form and the call rule ("Calling a council"). The design council (Part 16), the SEO council (Part 10) and the plan council (Part 17) use the same form.

## Goal

The factory reviews accessibility and usability as a council, on live pages, components, documents, and Figma designs before they are built. The standard is WCAG 2.2 level AA, and EN 301 549 for EU projects. Two members on different model families analyse the same evidence. A chair compares their reports, and merges the list of checks that only a human can do.

## Role and seats

The role file is `factory/a11y/a11y.md`. The seats are in `factory/a11y/council.yaml`:

| Seat | Harness and model | Tools | Job |
|---|---|---|---|
| `a11y-capture` | Claude Code, sonnet | Accessibility Agents MCP, Playwright MCP, Figma MCP | Runs the tools and writes the evidence pack. Does not analyse. |
| `a11y-claude` | Claude Code, sonnet | Accessibility Agents MCP (for example `check_contrast`) | Member |
| `a11y-openai` | Pi, OpenAI | Accessibility Agents MCP, through Pi's `mcp.json` (Part 7) | Member |
| `a11y-chair` | Claude Code, opus | none | Compares the reports, merges the manual checks |

The flow is the same as Part 10: capture, two members at the same time without access to the other report, chair, Orchestrator.

## Tools

| Tool | What it gives | Where it runs |
|---|---|---|
| Accessibility Agents MCP server (`a11y/suite/accessibility-agents/mcp-server/`, MIT) | `run_axe_scan`: axe-core through `@axe-core/playwright`, the same rule engine as the axe DevTools extension. Also keyboard, contrast and viewport scans, contrast and color-blindness checks, reading level, PDF and Office scans, veraPDF. | Local. The app installs its npm packages and a Chromium for Playwright into `<app data>/toolchain/` (Part 7). |
| Playwright MCP | Accessibility tree snapshots, screenshots, states | Local |
| Figma MCP | `get_metadata`, `get_variable_defs`, `get_screenshot`, `get_design_context` for the frames in scope | Figma's MCP server, with the human's Figma account |
| veraPDF (optional) | PDF/UA validation | Local, needs Java |
| Deque Axe MCP Server (optional) | Axe analysis and remediation through Deque's Axe Platform | Needs an Axe DevTools for Web license. Deque's page does not say what data goes to its platform. Use it only after you read Deque's data terms and the client contract allows it. |

The axe DevTools browser extension stays the human's tool. The council's manual-check list says where the human must use it, for example the guided tests and states that a scan cannot reach.

## Skills

Five factory skills in `factory/a11y/skills/`. Each routes to specialist skills that stay unchanged in `factory/a11y/suite/`:
- `a11y-web-audit`: 15 Accessibility Agents specialists (keyboard, ARIA, forms, dialogs, live regions, headings and alt text, contrast, tables, charts, media, language, mobile, cross-page patterns).
- `a11y-design-review`: Figma checks for contrast, target size (24 by 24 CSS pixels), states, color-only meaning, reflow, text spacing and annotations. Also design-system, contrast, cognitive and heuristic lanes.
- `usability-review`: Nielsen's heuristics and a cognitive walkthrough (mastepanoski, MIT), and cognitive accessibility.
- `a11y-documents`: PDF/UA, Word, Excel, PowerPoint.
- `a11y-compliance`: EN 301 549 and European Accessibility Act mapping, and an EU model accessibility statement.

The Accessibility Agents routers "dispatch" specialists to sub-agents. The factory skills tell the agent to read each specialist itself (Part 4, no sub-agents).

Not used: `mgifford/accessibility-skills`, because its license is AGPL-3.0. The human can install it as a personal skill.

## Limits

1. Automated tools find only part of the accessibility issues. The council result always has a list of manual checks. Examples: screen readers (NVDA, JAWS, VoiceOver), real keyboard use, 400 % zoom, text spacing, and the main user tasks. The council never states conformance. Only the human can, after the manual checks.
2. Pages behind a log-in need a test account from the human. Else they are a gap in the evidence.
3. Figma files, documents and pages are client data. They stay local or in the client's own Figma account. The setting `external_data_policy` (Part 10, open question 2) applies here too.

## Calling a council: by code and Jev, not by the Orchestrator (decision 2026-10-28)

This applies to every council: accessibility (this part), design (Part 16), SEO (Part 10), plan (Part 17), and any later council.

A council can be called at any point of the work. The call must be deterministic, and it is not the Orchestrator's decision. The Orchestrator cannot call, skip or cancel a council. It sees the call and its result. The human can always call a council by hand.

1. **Call points.** The hub checks the council rules at fixed events:
   - a request is created (plan council);
   - a plan is ready for the start Approve;
   - a ticket reaches `in_review` (after the Tester);
   - all tickets of a request are done (before the delivery report);
   - a release, and a time interval set for each project (for example SEO after each release, accessibility every 30 days).
2. **Facts, built by code.** For each call point the hub computes numbers and flags only, no ticket text and no code:
   - the origin of the request (human or factory) and its number of tickets;
   - the radius of each ticket, and the areas the tickets change: UI files and templates, public routes and page metadata, content, permissions, a new Kind;
   - the size of the change (files and lines) and the number of spec requirements;
   - the earlier FAIL counts of the request;
   - the project type (for example a European Commission project with ECL) and the days since the last run of each council.
3. **Step A: fixed rules.** Each council has rules in `config.yml` that say "call", "skip" or "unsure", for example:
   - design: call when the project has no token system, a request adds a screen, or UI changes without an approved design (Part 16);
   - accessibility: call when a ticket changes UI files or templates of a public project;
   - SEO: call when public routes, page metadata or content change, and after each release;
   - plan: call for a request with origin human that has a high-radius ticket, a new Kind, or more than a set number of tickets.
4. **Step B: Jev.** After step A has run for at least 50 calls of one council, the hub asks Jev one typed question for each "unsure" result: "call" or "skip", with a probability. Jev gets only the facts of item 2. Code applies the limits: a rule that says "call" always wins; Jev cannot skip it. Jev decides only the "unsure" zone. Jev uses the shared access of Part 6, item 6. Jev stays on only when it beats the rule (fewer missed findings for the same cost).
5. **Record.** For each call point: the facts, the rule result, Jev's answer and probability, and the council result (number of accepted findings). This is the measure of the rules and of Jev. The delivery report shows the councils that ran and why.
6. **Effect.** A called council gets its ticket from the hub (for example `[a11y]` or `[seo]`), not from the Orchestrator. The Orchestrator turns the council's accepted actions into draft tickets, as before.

## Effect on other parts

- Part 2: the Validator keeps its own accessibility skills for code tickets. A Worker fix for an `[a11y]` finding goes through the normal technical track.
- Part 7 and Part 8: new components in the setup (row "Accessibility"). The Doctor checks Node, the Chromium for Playwright, the MCP server, and the Figma MCP sign-in.
- Part 11: show an `[a11y]` ticket with its stages, the number of findings by severity, and the open manual checks.

## Tests

1. An `[a11y]` web ticket launches the capture seat. The evidence pack has the `run_axe_scan` result for each page in scope, with the axe-core version.
2. A design ticket stores the Figma node ids, and the token values from `get_variable_defs`.
3. The two members get the same `evidence/manifest.json` hash, and not the other member's report.
4. Each member finding has a WCAG success criterion or a heuristic, and evidence.
5. The council result has a list of manual checks. It does not contain the words "compliant" or "conformant" as a claim.
6. The skill listing of an a11y seat shows the five factory skills, not the suite skills.

## Mockups (2026-10-28)

Not designed yet: the council call and its findings: agreed, single and conflict findings, and the manual checks for the human. Design them with the council, after Part 9.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
