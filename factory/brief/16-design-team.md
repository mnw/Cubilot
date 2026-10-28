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

## Tool: Figma (decision 2026-10-28)

The design team works in Figma. It uses the remote Figma MCP server:
- **Write:** `use_figma` creates and edits frames, components, variants, variables and auto layout in a Figma file, through the Figma Plugin API. `upload_assets` and `generate_image` add images. The Figma skill `figma-use` makes these calls reliable.
- **Read:** `get_design_context`, `get_screenshot`, `get_variable_defs` and `get_metadata`. The Design reviewer reads only.
- **Code link:** Code Connect maps Figma components to code components, so that the Workers build from the real components.

Conditions (Figma documentation, read 2026-10-28; check again before the build):
- A Figma Professional, Education, Organization or Enterprise plan, and edit access to the files.
- Write to canvas is in beta. It is free during the beta and becomes a paid, usage-based feature later. Record the cost in the delivery report when Figma starts to charge.
- Output can need manual cleanup. The Designer works in a draft file or a branch of the file, never in the published library directly.
- Fonts must be in the Figma account. Components with images or video cannot be imported.
- The stage sessions need the Figma MCP in their role plugin, with the human's Figma sign-in on the Mac. Agents never see the human's password; the sign-in is the human's step (Part 8, setup).

## Where the work lives

In Figma, for each project:
- **Library:** the design system as Figma variables (colour, type, spacing, radius, shadow, with modes for the themes) and published components. For a European Commission project, start from the ECL Figma kit when one is available, and do not make a second system.
- **Design file:** one page for each request, with the screens and their states. The Designer works on a draft or a branch; the human approves the page link.

In the project repository:
- `design/system/`: `design-tokens.json` and `tokens.css`, exported from the Figma variables, so that code and Figma use the same values. A check compares them.
- `design/<request-id>/`: `brief.md` (the Figma page link, the screens and states) and `screenshots/` (from `get_screenshot`), so that the review and the delivery report work without Figma.
- `design/assets/`: SVG files, each with a line in `design/assets/SOURCES.md`.

Inputs:
- Existing Figma files of the project.
- The existing UI, through screenshots that Playwright makes.

## Flow

1. The Orchestrator triages a request (Part 6, item 1). A request with a UI change gets a `[design]` ticket first.
2. Designer: makes the design or the system change in Figma (draft or branch), exports the screenshots and, for a system change, the tokens.
3. Design reviewer: PASS or CHANGES. CHANGES goes back to the Designer. After two CHANGES, the arbiter decides (Part 6, item 11).
4. The plan of the request goes to the human with the design screenshots. One Approve covers both.
5. The Workers build. Each UI ticket names the screens of the approved design that it implements.
6. After the Tester, a design-review stage runs on each UI ticket. Blocking: the built UI differs from the approved design in layout, hierarchy, content or states, or it uses values that are not in the design system. Suggestion: small visual differences. Then the Validator.
7. Accessibility (WCAG 2.2 AA, EN 301 549) stays with the accessibility council (Part 9). The Design reviewer flags an obvious problem as a suggestion and names Part 9.

## Skills

Sources as for the other roles (`factory/README.md`). Copy each skill with its source note and licence.

| Role | Core | Optional |
|---|---|---|
| Designer | `figma-use` (Figma), `agency-design-ui-designer`, `agency-design-ux-architect`, `design-system` (ECC), `frontend-design-direction` (ECC), `frontend-ui-engineering` (Osmani) | `agency-design-brand-guardian`, `agency-design-visual-storyteller`, `agency-design-inclusive-visuals-specialist` |
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
6. The tokens exported from the Figma variables match `design/system/tokens.css` (a check that fails on a difference).
7. A design stage without the Figma sign-in stops with a clear message and a "Needs you" line; it does not fall back to HTML silently.

## Open questions

1. Image generation: Figma's `generate_image` can make raster images. Is it in scope, and at what cost after the beta? Today: SVG only.
3. Which Figma plan and team does the factory use, and who owns the files (the human, or each client)?
2. Does the design review run on every UI ticket, or only when the ticket names a screen of an approved design?

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
