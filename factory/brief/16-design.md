# Part 16: Design council

Status: planned (decisions of the human, 2026-10-28). Build it at the end of the build order, after Part 9 (councils come last), which builds the council form and the call rule (Part 9, "Calling a council").

Decision 2026-10-28: the design team (formerly 16a) is folded into the council and is not built. Its two jobs are done: Cubilot's design token system and the mockups for Part 14 were made with the human in claude.ai design artifacts (see "Done before the council"). Until the council exists, Part 14 builds from those mockups, and the Validator checks the built UI against them (Part 14, "Source").

## Goal

The factory decides how a UI looks before the Workers build it, keeps a design token system for each project, checks the built UI against the design, and makes visual assets. The design council does it in the same form as the other councils: called by hub rules and Jev, two members on two models, a chair.

## Tool: OpenPencil (decision 2026-10-28)

The design council works in OpenPencil (github.com/open-pencil/open-pencil). The human chose it because it has no licence fee, no account and no cloud, and it works like Sketch: frames, components, auto layout and variables on a vector canvas.

Facts (sources read 2026-10-28; check again before the build):
- MIT licence. A Tauri desktop app (macOS, Linux, Windows) and a browser app (PWA). Written in TypeScript, with a headless SDK.
- Reads and writes `.pen` and Figma `.fig` files. Exports PNG, JPG, WebP, SVG, HTML and JSX.
- An MCP server for agents (Claude Code is named) with tools to create shapes, set layouts, use boolean operations and variables.
- A command-line tool to inspect, query, change and export files.
- Its maturity is not known: the sources give no version number and no test results.

How it fits Cubilot:
- The role plugins of the design roles and seats register the OpenPencil MCP server. The chair uses the read tools and the command-line export. Check in the trial whether Pi (the OpenAI member) can use the MCP server. If it cannot, the factory builds a Pi extension for OpenPencil (decision 2026-10-28), in the same way as the chatbridge Pi extension: it gives Pi the OpenPencil tools, through the MCP server or the command-line tool. Both council members then work in OpenPencil with the same tools.
- The design files are local files in the project repository, so they are in git next to the code.
- The setup screen (Part 8) installs OpenPencil with the other bundled tools, at a pinned version (Part 7, `toolchain.lock`).
- After Part 12, the browser version of OpenPencil can open as a "Design" tab in Cubilot's browser UI, so that the human sees and approves the mockups in Cubilot.

### First task: the trial

Before the council is built (its first step), one design stage makes a small token set and one Cubilot screen in OpenPencil through its MCP server. The trial records:
- which MCP tools work, which fail, and which are missing;
- the time and the tokens of the stage;
- whether the command-line tool exports the screenshots and the tokens without the app open (this decides if design stages can run on the Linux server);
- the human's judgement of the result.

If the trial fails, the fallback is Penpot, self-hosted (free, MPL licence, an official MCP server; it needs a browser tab that stays open while the agent works). Figma and Sketch stay possible for a client project that already uses them and pays for them. The tool is a project setting; the design system in the repository does not depend on it.

## Where the work lives

In the project repository:
- `design/system/`: the library file (`library.pen`) with the variables (colour, type, spacing, radius, shadow, with modes for the themes) and the components, plus `design-tokens.json` and `tokens.css` exported from it, so that code and design use the same values. A check compares them. For a European Commission project, the system is ECL: start from the ECL tokens and components, and do not make a second system. For Cubilot itself the system exists: `design/system/tokens.json` and `README.md` (2026-10-28, six type sizes, three themes, contrast fixed). The council's trial makes `library.pen` from it; the values do not change.
- `design/<request-id>/`: the design file (`<request-id>.pen`) with one page for each screen and its states, `brief.md`, and `screenshots/` exported by the command-line tool, so that the review and the delivery report work without the app.
- `design/assets/`: SVG files, each with a line in `design/assets/SOURCES.md`.

Inputs:
- Existing design files of the project (`.pen`, or `.fig` from Figma, which OpenPencil opens).
- The existing UI, through screenshots that Playwright makes.

## Done before the council (2026-10-28)

Made with the human in claude.ai, outside the factory, so the redesign can start before the council exists:
1. **Design token system** for Cubilot: in the repository in `design/system/` (`tokens.json`, `README.md`, `SOURCE.md`). Built from `ui/styles/tokens.css`, with contrast fixes for the Rosé Pine themes, a new `orange-text`, and a type scale of six sizes (12, 14, 16, 18, 22, 28 px).
2. **Mockups for Part 14:** every screen of the browser UI, desktop and phone, dark and light, including sign-in (Part 12), the dashboard (Part 11) and a Coverage list that maps each current feature to its screen. In the repository in `design/mockups/` (`cubilot-prototype.html`, a clickable prototype that holds every screen; `COVERAGE.md`; `README.md`).

The council takes both over. It does not redo them.

## The council

Built after Part 9. From then on it does all design work.

### When the hub calls it

Step A rules in `config.yml` (Part 9, "Calling a council"), from facts that code computes:
- **Call:** the project has no design token system yet; a request adds a new screen, or a ticket changes UI that no approved design covers; a ticket needs a component or a token that is not in the design system; the human asks for it.
- **Skip:** the UI change uses only existing components and tokens and follows an approved design.
- **Unsure:** everything else. After 50 calls, Jev decides "call" or "skip" for the unsure cases.

The Orchestrator does not call the council. The design review of the built UI stays one check stage by rule, not a council.

### Seats

| Seat | Harness and model | Job |
|---|---|---|
| `design-capture` | Claude Code, sonnet | Collects the input once: the request, the current tokens and components, screenshots of the existing UI, and the constraints (ECL, themes, contrast). Does not design. |
| `design-claude` | Claude Code, opus | Member. Proposes the tokens or the screens in OpenPencil. |
| `design-openai` | Pi, provider `openai-codex` (the Validator's model) | Member. Proposes the same, blind. Needs OpenPencil in Pi (see Tool). |
| `design-chair` | Claude Code, opus | Compares the two proposals: agreed, single (checked against the brief and the constraints), or conflict. Merges the agreed and accepted parts into one design. |

Conflicts about looks (two layouts, two colour directions) are design choices: the chair shows them to the human side by side in the start Approve, and the human picks. Conflicts about rules (contrast, a token outside the system, ECL) the chair decides by the rule; the arbiter decides what the rules do not cover.

## What it produces

1. The design token system for each project. For a European Commission project, start from ECL and make no second system.
2. UI designs before the build: screens and states in OpenPencil, with exported screenshots, approved by the human with the plan (one Approve at the start).
3. Visual assets: SVG where possible, made by the council, with a line in `design/assets/SOURCES.md`. No third-party brand marks or protected characters.
4. The design review of the built UI (one check stage by rule).
Accessibility stays with the accessibility council (Part 9).

## Skills

Sources as for the other roles (`factory/README.md`). Copy each skill with its source note and licence.

| Role or seat | Core | Optional |
|---|---|---|
| `design-claude`, `design-openai` | an OpenPencil skill (write it after the trial), `agency-design-ui-designer`, `agency-design-ux-architect`, `design-system` (ECC), `frontend-design-direction` (ECC) | `agency-design-brand-guardian`, `agency-design-visual-storyteller`, `agency-design-inclusive-visuals-specialist` |
| `design-chair` and the design-review check | `agency-design-ui-finish-gate-reviewer`, `design-system` (ECC, audit mode) | `agency-design-ux-researcher`, `agency-design-persona-walkthrough` |
| `design-capture` | `agency-testing-evidence-collector`, `design-system` (ECC, extract mode) | |

## Dependencies

- Part 9 (the council form and the call rule); the hub stage chain for the seats (build it with the writing chain, one mechanism); Part 6, item 11 (one Approve, the arbiter); a Pi extension for OpenPencil if the trial shows that Pi cannot use the MCP server.
- Part 14 does not wait for this part: it builds from `design/mockups/`.

## Tests

1. The values in `library.pen` (made by the trial) match `design/system/tokens.json`; a check lists each value in `ui/` outside the tokens.
2. A design ticket's screenshots are in `design/<request-id>/screenshots/`, and the human's Approve shows them.
3. A built UI that uses a colour value outside the token system gets a blocking design-review finding.
4. A design stage that cannot reach the OpenPencil MCP server stops with a clear message and a "Needs you" line; it does not fall back to HTML silently.
5. A project without `design/system/` gets a council call at its first UI request.
6. A ticket that uses only existing components and an approved design gets no call.
7. The two members get the same first message, and neither sees the other's proposal before the chair.
8. A conflict about looks reaches the human in the start Approve with both options; a conflict about contrast is decided by the rule.
9. On a European Commission project, the council uses ECL tokens and components, and creates no new token set.

## Open questions

1. Image generation (raster illustrations): not in scope. SVG only.
2. Can design stages run on the Linux server without a screen? The trial answers this.
3. Can Pi use the OpenPencil MCP server? The trial answers this. If not, a Pi extension is built before the council.
4. Does a fork of OpenPencil become the base of the shelved Sketch clone (Ardoise)? A separate decision, after a good trial.

## Mockups (2026-10-28)

Not designed yet: the side-by-side choice of two designs in the start Approve. Design them with the council, after Part 9.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
