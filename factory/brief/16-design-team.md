# Part 16: Design team

Status: planned (decision of the human, 2026-10-28). Build it after Part 12 and before Part 14 (decision 2026-10-28): the design team makes the mockups for the UI redesign of Part 14.

## Goal

The factory makes the design of a feature before the Workers build it, keeps a design system for each project, checks the built UI against the design, and makes visual assets. The design team works as a track, like the writing track: a Designer makes the work, a Design reviewer checks it, and the Orchestrator leads.

## What the team produces

1. **UI designs before the build.** For each request with a UI change: the screens or the changed parts, as a static prototype that uses the project's design system, and screenshots of it. The human approves the design together with the plan of the request (Part 6, item 11: one Approve at the start). The code tickets of the request name the approved design.
2. **Design system.** For each project: the tokens (colour, type, spacing, radius, shadow) as `design-tokens.json` and CSS custom properties, the components and their states, and the patterns. The Designer extracts it from the code when the project has one, and keeps it current. For a European Commission project, the design system is ECL (Europa Component Library). The team uses ECL and does not make a second system.
3. **Design review of the built UI.** After the Tester on a `[code]` ticket that changes UI: the Design reviewer compares screenshots of the built UI with the approved design and the design system.
4. **Visual assets.** Icons, illustrations and graphics, as SVG where possible. The team makes them itself. It does not copy third-party brand marks or protected characters. Each asset records its source and licence.

## Roles

| Role | Model | Job | Never |
|---|---|---|---|
| Designer | Claude, opus for a new design or design system, sonnet for changes | Makes the designs, the design system and the assets. Runs its own screenshot check before hand-in. | Changes product code. Approves its own work. |
| Design reviewer | A different model from the Designer: OpenAI on Pi when it is set up, else opus in a new session | Checks a design against the request and the design system, and the built UI against the approved design. PASS or CHANGES. | Edits files. |

## Tool: OpenPencil (decision 2026-10-28)

The design team works in OpenPencil (github.com/open-pencil/open-pencil). The human chose it because it has no licence fee, no account and no cloud, and it works like Sketch: frames, components, auto layout and variables on a vector canvas.

Facts (sources read 2026-10-28; check again before the build):
- MIT licence. A Tauri desktop app (macOS, Linux, Windows) and a browser app (PWA). Written in TypeScript, with a headless SDK.
- Reads and writes `.pen` and Figma `.fig` files. Exports PNG, JPG, WebP, SVG, HTML and JSX.
- An MCP server for agents (Claude Code is named) with tools to create shapes, set layouts, use boolean operations and variables.
- A command-line tool to inspect, query, change and export files.
- Its maturity is not known: the sources give no version number and no test results.

How it fits Cubilot:
- The Designer's role plugin registers the OpenPencil MCP server. The Design reviewer uses the read tools and the command-line export only.
- The design files are local files in the project repository, so they are in git next to the code.
- The setup screen (Part 8) installs OpenPencil with the other bundled tools, at a pinned version (Part 7, `toolchain.lock`).
- After Part 12, the browser version of OpenPencil can open as a "Design" tab in Cubilot's browser UI, so that the human sees and approves the mockups in Cubilot.

### First task: the trial

Before the design track is built, one Designer stage makes one Cubilot screen (from the Part 14 brief) in OpenPencil through its MCP server. The trial records:
- which MCP tools work, which fail, and which are missing;
- the time and the tokens of the stage;
- whether the command-line tool exports the screenshots and the tokens without the app open (this decides if design stages can run on the Linux server);
- the human's judgement of the result.

If the trial fails, the fallback is Penpot, self-hosted (free, MPL licence, an official MCP server; it needs a browser tab that stays open while the agent works). Figma and Sketch stay possible for a client project that already uses them and pays for them. The tool is a project setting; the design system in the repository does not depend on it.

## Where the work lives

In the project repository:
- `design/system/`: the library file (`library.pen`) with the variables (colour, type, spacing, radius, shadow, with modes for the themes) and the components, plus `design-tokens.json` and `tokens.css` exported from it, so that code and design use the same values. A check compares them. For a European Commission project, the system is ECL: start from the ECL tokens and components, and do not make a second system. For Cubilot itself, the system is `ui/styles/tokens.css` (the three themes).
- `design/<request-id>/`: the design file (`<request-id>.pen`) with one page for each screen and its states, `brief.md`, and `screenshots/` exported by the command-line tool, so that the review and the delivery report work without the app.
- `design/assets/`: SVG files, each with a line in `design/assets/SOURCES.md`.

Inputs:
- Existing design files of the project (`.pen`, or `.fig` from Figma, which OpenPencil opens).
- The existing UI, through screenshots that Playwright makes.

## Flow

1. The Orchestrator triages a request (Part 6, item 1). A request with a UI change gets a `[design]` ticket first.
2. Designer: makes the design or the system change in OpenPencil, exports the screenshots and, for a system change, the tokens. It commits the files on the ticket branch, as a Worker does.
3. Design reviewer: PASS or CHANGES. CHANGES goes back to the Designer. After two CHANGES, the arbiter decides (Part 6, item 11).
4. The plan of the request goes to the human with the design screenshots. One Approve covers both.
5. The Workers build. Each UI ticket names the screens of the approved design that it implements.
6. After the Tester, a design-review stage runs on each UI ticket. Blocking: the built UI differs from the approved design in layout, hierarchy, content or states, or it uses values that are not in the design system. Suggestion: small visual differences. Then the Validator.
7. Accessibility (WCAG 2.2 AA, EN 301 549) stays with the accessibility council (Part 9). The Design reviewer flags an obvious problem as a suggestion and names Part 9.

## Skills

Sources as for the other roles (`factory/README.md`). Copy each skill with its source note and licence.

| Role | Core | Optional |
|---|---|---|
| Designer | an OpenPencil skill (write it after the trial, from the tools that work), `agency-design-ui-designer`, `agency-design-ux-architect`, `design-system` (ECC), `frontend-design-direction` (ECC), `frontend-ui-engineering` (Osmani) | `agency-design-brand-guardian`, `agency-design-visual-storyteller`, `agency-design-inclusive-visuals-specialist` |
| Design reviewer | `agency-design-ui-finish-gate-reviewer`, `design-system` (ECC, audit mode) | `agency-design-ux-researcher`, `agency-design-persona-walkthrough` |

## Dependencies

- The hub stage chain for the roles `designer` and `design-reviewer`. The hub refuses roles without a chain today (role-chain gate). Build this chain with the writing chain (parked drafts "writing chain 1/2 and 2/2"), with one mechanism for both tracks.
- Part 6, item 11 (one Approve at the start, the arbiter).
- Part 12 comes first: the design team designs for the browser UI that the hub serves.
- Part 14 uses this part: the Designer makes the mockups of the redesigned browser UI from the Part 14 brief, the Design reviewer checks them, and the human approves them before the Workers build. For Cubilot itself, the design system is `ui/styles/tokens.css` (the three themes).

## Tests

1. A request with a UI change gets a `[design]` ticket before its code tickets, and the code tickets are blocked by it.
2. The human's Approve at the start shows the design screenshots.
3. A built UI that uses a colour value outside the design system gets a blocking design-review finding.
4. On a European Commission project, the Designer uses ECL tokens and components, and creates no new token set.
5. Each asset in `design/assets/` has a line in `SOURCES.md`.
6. The tokens exported from `design/system/library.pen` match `design/system/tokens.css` (a check that fails on a difference).
7. A design stage that cannot reach the OpenPencil MCP server stops with a clear message and a "Needs you" line; it does not fall back to HTML silently.

## Open questions

1. Image generation (raster illustrations): not in scope. SVG only.
3. Can design stages run on the Linux server without a screen? The trial answers this (command-line export without the app).
4. Does a fork of OpenPencil become the base of the shelved Sketch clone (Ardoise)? A separate decision, only after a good trial.
2. Does the design review run on every UI ticket, or only when the ticket names a screen of an approved design?

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
