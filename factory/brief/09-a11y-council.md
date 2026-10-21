# Part 9: accessibility and usability council

Status: decision 2026-10-19. Build it after Part 4, because it uses one session for each stage. It builds the council form. The SEO council (Part 10) uses the same form.

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

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
