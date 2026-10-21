# Cubilot: software factory

*Cubilot: The Continuous Software Foundry*

Agent roles in one Cubilot Room, on four tracks:

- **Technical track** (`[code]` tickets): Orchestrator → Validator (spec review) → Worker → Testers → Validator
- **Writing track** (`[doc]` tickets): Orchestrator → Validator (spec review) → Writer → Editor → Reviewer
- **SEO track** (`[seo]` tickets): Orchestrator → Validator (spec review) → SEO capture → two SEO members → SEO chair → Orchestrator
- **Accessibility track** (`[a11y]` tickets): Orchestrator → Validator (spec review) → a11y capture → two a11y members → a11y chair → Orchestrator

The Orchestrator is the Room lead for both tracks. The human has the final word.

## Folder layout

```
factory/
  README.md            this file: roles, flows, rules, skills
  licenses/            MIT licenses of the two source repos
  <role>/
    <role>.md          the role definition (frontmatter + added system prompt)
    skills/<name>/     skills for this role (SKILL.md + references)
    hooks/             hooks that enforce a gate (Editor only today)
  MIGRATION-BRIEF.md        move to the new repo (do this first)
  brief/                    how to build the factory into the app: 00-index.md and one file for each part
  archive/                  the full brief as one file (2026-10-19), read only
  work/                     OpenSpec changes drafted from the brief, one for each part (tasks to build)
  SKILL-UPDATES.md          updated skills to copy to the local skill folders
  seo/council.yaml          the seats of the SEO council
  seo/suite/                the SEO-AEO-GEO Ultimate suite (skills, scripts, schemas), used by the seo skills
  a11y/council.yaml         the seats of the accessibility and usability council
  a11y/suite/               Accessibility Agents (skills, MCP server) and two usability skills, used by the a11y skills
```

To set up a new machine, use the Setup and admin screen of the app (`brief/08-setup-admin.md`). It installs the components, opens the sign-ins, adds the first project and runs the checks.

To use a role in a project before the app does it:
1. Give the agent the body of `<role>/<role>.md` as an added system prompt (`--append-system-prompt-file`). Do not use it as a Claude Code sub-agent file.
2. Copy `<role>/skills/*` to the project's `.claude/skills/` (Claude Code), or pass them with `--skill` (Pi).
3. Start Claude Code roles with `--disallowedTools Task,Agent`. The `disallowedTools` line in the role frontmatter lists the tools to block.

Session names: `orchestrator`, `worker-1`, `worker-2`, `tester-1`, `tester-2`, `validator`, `writer`, `editor`, `reviewer`. Each `worker-N` uses `worker.md`, each `tester-N` uses `tester.md`. The SEO seats `seo-capture`, `seo-claude`, `seo-openai` and `seo-chair` all use `seo/seo.md`. The seats `a11y-capture`, `a11y-claude`, `a11y-openai` and `a11y-chair` all use `a11y/a11y.md`.

A skill can be in two role folders (for example `documentation-lookup`). The copies are the same.

## Roles

The Validator and the Reviewer challenge the work. They run on OpenAI through the Pi harness. The agents that produce the work run on Anthropic through Claude Code. They do not share the same blind spots. The model for each role is in the role file frontmatter.

| Role | Track | Model | What it does | What it never does |
|---|---|---|---|---|
| **Orchestrator** | both | opus | Room lead. Splits requests into tickets with checkable acceptance criteria. Sends each plan to spec review. Unblocks, decides disputes, escalates to the human. Keeps the Nutshell current. | Write code or docs. Test or review. |
| **Worker** (worker-N) | technical | sonnet | The developer. Implements `[code]` tickets on its own branch with tests first. Sends work to the Testers. Answers the Validator's findings with fixes or evidence. | Merge, release, judge its own work. |
| **Tester** (tester-N) | technical | haiku | The small hands. Runs the test suite, end-to-end tests, mutation testing and any command the Validator asks for. Writes the raw report. Several testers can run in parallel. | Say PASS or FAIL. Edit product code. |
| **Validator** | both (spec review), technical | OpenAI on Pi | The challenger. Reviews the plan and the spec of each request before work starts (spec review). Questions the Worker's diff and claims, the Testers' reports, and its own verdict. Reviews correctness, security and design. Gives PASS or FAIL on plans and on code tickets. | Edit files. Fix findings. Run long suites itself. |
| **Writer** | writing | sonnet | Drafts `[doc]` tickets from the code and the sources. Runs its own commands, samples and link check. | Change product code. Publish. |
| **Editor** | writing | sonnet | Edits drafts in place: structure, ASD-STE100 language, style guide, terminology, accessible markup. The only role that runs `humanizer` and `clean-user-facing-text`. | Change technical meaning, commands or code. |
| **Reviewer** | writing | OpenAI on Pi | Final gate for docs: technical accuracy against the code, completeness for the reader, scope. Gives APPROVE or CHANGES. | Edit files. |
| **SEO council** (4 seats) | SEO | capture: sonnet. Members: sonnet and OpenAI on Pi. Chair: opus | Capture makes one evidence pack. The two members analyse it without seeing each other's work. The chair sorts the findings into agreed, single (checked against the evidence) and conflict (to the human), and gives the actions. | Change code or content. Guarantee rankings. Make one SEO score. |
| **Accessibility and usability council** (4 seats) | accessibility | capture: sonnet. Members: sonnet and OpenAI on Pi. Chair: opus | Capture runs axe-core, keyboard, contrast and viewport scans, and reads Figma frames and documents. The members analyse the evidence without seeing each other's work, to WCAG 2.2 AA and EN 301 549, plus usability heuristics. The chair sorts the findings and merges the list of manual checks for the human. | Change code, content or designs. State conformance. Make one score. |

## Ground rules

1. **A ticket is the unit of work. A handoff is a stage move inside a ticket.** Every handoff carries `context.ticket_id`.
2. **The producer owns the ticket to the end.** The Worker or the Writer moves it to `done` after the final verdict.
3. **Verdicts travel as handoffs back to the producer**, with findings in `context`. Each finding is `blocking` or `suggestion`.
4. **Title prefixes route work:** `[code]` to a Worker, `[doc]` and `[spec]` to the Writer, `[seo]` to the SEO council, `[a11y]` to the accessibility and usability council.
5. **`blast_radius: high`** for releases, production config, public docs, data migrations and security. `done` then needs the human's Allow.
6. **Evidence beats opinion.** A finding names the file and line, the command output, or the criterion.
7. **Only the human acks permissions.**
8. **Interrupts are for "stop now"** only.
9. **After two FAIL or CHANGES loops on one ticket**, or a dispute that does not settle, the Orchestrator decides or escalates to the human.
10. **No sub-agents.** No role starts a sub-agent. Claude Code roles start with the `Task` and `Agent` tools blocked. Pi has no sub-agents. All work happens in sessions that the human can see.
11. **One new session for each ticket stage.** The Orchestrator decides which tickets exist, their roles and their dependencies. The app starts the agents. When a ticket stage is ready, the app starts a new session for that role. The session has its own worktree and its own pane. Its first message is the ticket context. When the agent posts its result, the app closes the session. Only the Orchestrator stays open for the whole room. Details: `brief/04-sessions.md`.
12. **Spec review before work.** The Orchestrator creates the tickets of a request as `draft` and sends the plan to the Validator. No `draft` ticket can start. On FAIL, the Orchestrator changes the plan and sends it again. After two FAIL loops, the human decides. On PASS, the tickets become `queued`. A `blast_radius: high` request also needs the human's approval of the plan.
13. **Agents never reach the client's repository.** Agents work only in the internal remote, a bare Git repository in the app data folder. The hub creates one `ticket/<id>` branch for each ticket. Only the human's Deliver step sends a clean, squashed branch to the client, after the leak gate passes. Details: `brief/05-delivery-backup.md`.
14. **One folder is the whole factory.** The app backs up the app data folder each hour, encrypted, to one target. Recovery: install the app, select "Restore from backup", sign in. Details: `brief/05-delivery-backup.md`.

## Spec review (both tracks)

```
human request
  -> Orchestrator: triage, then create_ticket(... status=draft, blocked_by, role) for each ticket (+ spec if needed)
  -> handoff Orchestrator -> validator {request_id, review: "spec"}     (new Validator session)
  -> Validator: coverage, checkable criteria, size, dependencies, blast radius, spec vs code, risks
       FAIL -> handoff Validator -> Orchestrator {findings, questions_for_human}
               Orchestrator changes the plan (or answers) -> new spec review, follow-up only
               two FAIL loops -> the human decides
       PASS -> tickets draft -> queued   (blast_radius high: the human approves the plan first)
```

## Technical track (`[code]`)

```
queued [code] ticket (after spec review PASS)
  -> Worker: claim -> in_progress -> tests + implementation -> in_review (note)
  -> handoff Worker -> tester-N   {ticket_id, branch, how_to_run}   (can split across testers)
  -> Tester: build, lint, types, tests, e2e, mutation testing on changed files -> report
  -> handoff Tester -> Validator  {ticket_id, branch, report_path}
  -> Validator: criteria vs evidence, mutation threshold, diff review, challenges
       needs more evidence -> handoff Validator -> tester-N {commands}
       ticket is wrong     -> handoff Validator -> Orchestrator {reason}; the changed ticket goes to spec review
       FAIL -> handoff Validator -> Worker {findings, surviving mutants}; Worker fixes, repeats
       PASS -> handoff Validator -> Worker "close T"
  -> Worker: transition done (high radius: waits for the human's Allow)
```

## Writing track (`[doc]`)

```
queued [doc] ticket (after spec review PASS; audience and sources in the ticket)
  -> Writer: claim -> in_progress -> draft -> runs samples + link check -> in_review (note)
  -> handoff Writer -> Editor     {ticket_id, path, style_guide}
  -> Editor edits in place
  -> handoff Editor -> Reviewer   {ticket_id, path, change_summary, open_questions}
  -> Reviewer: APPROVE -> handoff -> Writer "close T"
               CHANGES -> handoff -> Writer {findings}
  -> Writer: transition done
```

For a feature with docs, the Orchestrator creates two tickets. The Orchestrator assigns the `[doc]` ticket after the `[code]` ticket gets a Validator PASS.

## Skills per role

Core = load always. Optional = load when the ticket needs it. Sources: **ECC** = affaan-m/ecc, **Agency** = msitarzewski/agency-agents (skills prefixed `agency-`), **Osmani** = addyosmani/agent-skills, **Own** = written for this factory.

On 2026-10-18 the sub-agent and persona files of ECC and Agency became skills. Each converted skill starts with a note that says so. The agent runs these instructions in its own session.

### Orchestrator
| | Item | Type | Why |
|---|---|---|---|
| Core | `intent-driven-development` | ECC skill | Turns vague requests into checkable acceptance criteria |
| Core | `planning-and-task-breakdown` | Osmani skill | Vertical slices, dependency graph, task sizes. The output is draft tickets with `blocked_by`. |
| Core | `team-agent-orchestration` | ECC skill | Work items with owners, branch isolation, merge gates |
| Core | `agency-project-manager-senior` | Agency skill | Spec to tasks, realistic scope |
| Optional | `architecture-decision-records` | ECC skill | Records decisions the team must keep |
| Core | `context-engineering` | Osmani skill | Keeps the project primer and the Nutshell short and current (context pack, Part 4) |
| Optional | `interview-me` | Osmani skill | One question at a time when a request is not clear ("Needs info") |
| Optional | `constraint-driven-development` | Osmani skill | Asks the human for the project's quality bar. The Writer writes `CONSTRAINTS.md`. |

### Technical track

**Worker**
| | Item | Type | Why |
|---|---|---|---|
| Core | `test-driven-development` | Osmani skill | Red, green, refactor. Finds the stack first (PHPUnit, Jest). A failing test first for each bug fix. |
| Core | `search-first` | ECC skill | Look for an existing tool before custom code |
| Core | `git-workflow-and-versioning` | Osmani skill | Atomic commits, worktrees, save points, change summaries |
| Core | `coding-standards` | ECC skill | Common naming and readability rules |
| Core | `agency-engineering-minimal-change-engineer` | Agency skill | Minimal diffs, no scope creep |
| Optional | `build-error-resolver` | ECC skill | Gets a broken build green with minimal edits |
| Optional | `documentation-lookup` | ECC skill | Current library docs through Context7 |
| Optional | `api-design` | Factory skill (merged: Osmani principles + ECC REST tables) | API and interface tickets |
| Optional | `error-handling`, `database-migrations` | ECC skills | By ticket type |
| Core | `incremental-implementation` | Osmani skill | Thin slices that you can test one at a time |
| Core | `debugging-and-error-recovery` | Osmani skill | Root-cause debugging when tests or builds fail |
| Optional | `agency-engineering-cms-developer`, `agency-engineering-drupal-performance` | Agency skills | Drupal modules, themes, caching |
| Optional | `deprecation-and-migration` | Osmani skill | Drupal major upgrades, schema changes, removal of old APIs |
| Optional | `frontend-ui-engineering` | Osmani skill | Accessible, responsive UI (WCAG) |
| Optional | `code-simplification`, `source-driven-development` | Osmani skills | Clearer code without a change in behaviour, and decisions checked against official docs |

**Tester** (haiku)
| | Item | Type | Why |
|---|---|---|---|
| Core | `verification-loop` | ECC skill | Fixed run order: build, types, lint, tests with coverage |
| Core | `mutation-testing` | Own skill | Mutation run on changed files, score and surviving mutants |
| Core | `agency-testing-evidence-collector` | Agency skill | Raw evidence, marks untested scope |
| Optional | `e2e-testing` | ECC skill | Playwright journeys |
| Optional | `browser-qa` | ECC skill | Console errors, Core Web Vitals, form flows |
| Optional | `agency-testing-api-tester` | Agency skill | API smoke runs |
| Optional | `agency-testing-test-automation-engineer` | Agency skill | Routine test authoring |

**Validator**
| | Item | Type | Why |
|---|---|---|---|
| Core | `agency-testing-reality-checker` | Agency skill | Defaults to "needs work", demands proof |
| Core | `intent-driven-development` | ECC skill | Challenges weak or uncheckable acceptance criteria |
| Core | `code-review` | Factory skill (merged: Osmani five-axis procedure + ECC confidence gate) | The review procedure for every code ticket |
| Core | `agency-engineering-code-reviewer` | Agency skill | Correctness over style, actionable findings |
| Core | `security-and-hardening` | Osmani skill | Threat model first, always / ask first / never tiers, SSRF, personal data |
| Core | `silent-failure-hunter` | ECC skill | Swallowed errors, bad fallbacks |
| Core | `pr-test-analyzer` | ECC skill | Do the tests prevent real bugs? Use with surviving mutants |
| Core | `ai-regression-testing` | ECC skill | Catches blind spots when the same model writes and reviews |
| Core | `agency-testing-test-results-analyzer` | Agency skill | Reads the Testers' results and mutation reports |
| Optional | `php-reviewer`, `typescript-reviewer` | ECC skills | By stack |
| Optional | `accessibility`, `agency-testing-accessibility-auditor` | ECC skill + Agency skill | WCAG 2.2 AA, the base for EN 301 549 |
| Optional | `agency-testing-performance-benchmarker` | Agency skill | Performance tickets |
| Optional | `production-audit` | ECC skill | Release tickets |
| Optional | `constraint-driven-development`, `code-simplification` | Osmani skills | Checks the diff against `CONSTRAINTS.md`, and against needless complexity |

### SEO track

**SEO council** (all seats)
| | Item | Type | Why |
|---|---|---|---|
| Core | `seo-research` | Factory skill (folds 3 suite skills) | Keywords, intent, AI-answer query corpus, sources, competitors |
| Core | `seo-audit` | Factory skill (folds 11 suite skills) | Technical, on-page, architecture, sitemaps, schema, hreflang, images, video, search data, agent readiness |
| Core | `seo-geo-aeo` | Factory skill (folds 3 suite skills) | Direct answers, entities, citations, AI-visibility measurement |
| Core | `seo-content` | Factory skill (folds 2 suite skills) | Content review, briefs, page systems at scale |
| Core | `seo-plan` | Factory skill (folds 3 suite skills) | Action plan, roadmap, check after release |
| Optional | `seo-verticals` | Factory skill (folds 4 suite skills) | Local, commerce, news and Discover, authority |

The six factory skills route to the 26 lane skills of SEO-AEO-GEO Ultimate in `seo/suite/skills/`, which stay unchanged. The suite's own router (`seo`) is not used, because the Orchestrator and the council own the order of work. Only the six short skills are in the skill listing.

### Accessibility track

**Accessibility and usability council** (all seats)
| | Item | Type | Why |
|---|---|---|---|
| Core | `a11y-web-audit` | Factory skill (routes to 15 Accessibility Agents specialists) | Web pages and components: axe-core results, keyboard, ARIA, forms, dialogs, contrast, media, language |
| Core | `a11y-design-review` | Factory skill (Figma checks + 4 lanes) | Figma designs before build: contrast, target size, states, reflow, annotations |
| Core | `usability-review` | Factory skill (3 lanes) | Nielsen's heuristics, cognitive walkthrough, cognitive accessibility |
| Optional | `a11y-documents` | Factory skill (6 lanes) | PDF (PDF/UA), Word, Excel, PowerPoint |
| Optional | `a11y-compliance` | Factory skill (4 lanes) | EN 301 549 and EAA mapping, EU model accessibility statement |

Tools (installed by the Setup screen): the Accessibility Agents MCP server, the Playwright MCP, and the Figma MCP. The Accessibility Agents MCP server runs locally. It gives axe-core with Playwright, and keyboard, contrast, viewport, PDF and Office scans. veraPDF is optional, for PDF/UA. The axe DevTools browser extension stays the human's tool for the manual checks. The Validator keeps its own accessibility skills for code tickets.

### Writing track

**Writer**
| | Item | Type | Why |
|---|---|---|---|
| Core | `agency-engineering-technical-writer` | Agency skill | Developer docs, API reference, READMEs, tutorials |
| Core | `agency-engineering-codebase-onboarding-engineer` | Agency skill | States only facts grounded in the code |
| Core | `code-explorer` | ECC skill | Traces code paths before writing about them |
| Core | `documentation-lookup` | ECC skill | Current third-party docs |
| Core | `docs-governance` | ECC skill | Link and reference check before hand-in |
| Optional | `code-tour` | ECC skill | Walkthroughs anchored to real files and lines |
| Optional | `article-writing` | ECC skill | Long tutorials and guides |
| Optional | `architecture-decision-records` | ECC skill | ADR tickets |
| Optional | `agency-specialized-document-generator` | Agency skill | PDF or DOCX output |
| Optional | `show-me` | Third-party skill (MIT, HumanLayer, v1.0.1) | Diagrams and short HTML pages that explain a topic |
| Core | `documentation-and-adrs` | Osmani skill | ADRs, code comments, API docs, README structure |
| Spec tickets | `spec-driven-development` | Osmani skill | Writes the spec for a `[spec]` ticket |
| Spec tickets | `constraint-driven-development` | Osmani skill | Writes `CONSTRAINTS.md` from the human's answers |
| Optional | `source-driven-development` | Osmani skill | Checks claims against official documentation |

**Editor**
| | Item | Type | Why |
|---|---|---|---|
| Core | `brand-voice` | ECC skill | Style profile built from your own sample docs |
| Core | `asd-ste100` | Third-party skill (MIT, D. Y. Teng, v0.4.0, commit `3944283`) | Simplified Technical English. Strict mode for procedures, STE-flavored mode for prose. Its linter `scripts/ste-lint.py` is the Editor's gate (exit 0 required). |
| Core | `clean-user-facing-text` | Plugin skill, source not checked | Final pass: invisible-Unicode audit and prose hygiene. Runs last. |
| Optional | `living-docs-governance` | ECC skill | Doc roles and structure on long-lived projects |
| Optional | `humanizer` | Third-party skill (MIT, Siqi Chen, v3.1.0) | Removes AI writing patterns. Prose-heavy docs only. Runs first. |

Editor order: `humanizer` (optional) → `asd-ste100` → `clean-user-facing-text`. ASD-STE100 rules win over the other two.

**Reviewer**
| | Item | Type | Why |
|---|---|---|---|
| Core | `agency-engineering-technical-writer` | Agency skill | Judges completeness for the reader's task |
| Core | `code-explorer` | ECC skill | Checks technical claims against the code |
| Optional | `comment-analyzer` | ECC skill | Docstring and comment accuracy |

## Mutation testing

Neither source repo has a mutation-testing skill, so this factory has its own skill in `tester/skills/mutation-testing/`. It covers Infection (PHP/Drupal), StrykerJS, mutmut, PIT and cargo-mutants, and runs on changed files only.

Mutation testing is opt-in for each project, with `mutation_mode: off | advisory | enforce`. The default is `off`. Use `advisory` first and change to `enforce` only after you know the real scores of the project. See `brief/13-mutation-testing.md` for the risks.

- The **Testers** run it on the fast suites only (unit and kernel tests), with a 15-minute time budget, and report the numbers. At the limit they report a partial result.
- The **Validator** reports findings as suggestions in `advisory` mode. In `enforce` mode it applies the project threshold. It accepts equivalent-mutant marks that have a reason. A partial result never fails a ticket.
- The **Worker** kills a blocking surviving mutant with a test, or marks it equivalent with a one-line reason.

## Not included

- Removed on 2026-10-18, because they start sub-agents or repeat a skill: `council` and `santa-method` (ECC skills), `planner`, `e2e-runner` and `security-reviewer` (ECC agents). For a second independent review of a high blast radius ticket, the Orchestrator creates a second review ticket. The app starts a separate Validator session for it. The removed files are in `_to_delete/`.
- `search-first` tells the agent to give some steps to a sub-agent. It starts with a factory note: do the step in your own session, or ask the Orchestrator for a separate ticket.
- Replaced on 2026-10-19 after a comparison with addyosmani/agent-skills: `blueprint`, `tdd-workflow`, `git-workflow` and `security-review` (ECC). `code-reviewer` and `api-design` (ECC) are merged into the factory skills `code-review` and `api-design`. The old files are in `_to_delete/`.

- Your Drupal/OpenEuropa skill. Copy it into `worker/skills/`.
- Do not load these. They run their own pipeline or tracker and conflict with tickets and handoffs: Agency `agents-orchestrator`, ECC `orch-*`, `plan-orchestrate`, `story-lifecycle`. The ECC hook skills `delivery-gate` and `gateguard` change every agent's behaviour, so only the human sets them.

## Sources

Copied on 2026-10-16. Both are MIT. The licenses are in `licenses/`.
- ECC: https://github.com/affaan-m/ecc at commit `76aaa77`
- Agency agents: https://github.com/msitarzewski/agency-agents at commit `652b269`
- asd-ste100 v0.4.0 by Dustin Yuchen Teng, MIT: https://github.com/danyuchn/asd-ste100-skill at commit `3944283` (updated 2026-10-18). The license is in `editor/skills/asd-ste100/LICENSE`.
- humanizer v3.1.0 by Siqi Chen, MIT: https://github.com/blader/humanizer at commit `8c307f3` (updated 2026-10-18, from v2.1.1). The license is in `editor/skills/humanizer/LICENSE`.
- Osmani agent skills by Addy Osmani, MIT: https://github.com/addyosmani/agent-skills at commit `aeac41d` (copied 2026-10-19). Ten skills, each with a factory note at the top. The license is in `licenses/ADDY-OSMANI-AGENT-SKILLS-LICENSE`. Not copied: `doubt-driven-development` (it starts a sub-agent), `using-agent-skills` (a skill router), the personas, the hooks and the commands.
- show-me v1.0.1 by HumanLayer, MIT: https://github.com/humanlayer/skills (`plugins/show-me`), last change `bba9d13`. The license is in `writer/skills/show-me/LICENSE`.
- SEO-AEO-GEO Ultimate v3.3.0 by Oegeyilmaz9, Apache License 2.0: https://github.com/oegeyilmaz9/seo-aeo-geo-ultimate (copied 2026-10-19 from the installed plugin). `seo/suite/` holds its skills, scripts, docs, manifests and assets without changes, except that the `agents/openai.yaml` files are removed. The six skills in `seo/skills/` are new files that route to it. The license and the NOTICE are in `licenses/`.
- Accessibility Agents by Taylor Arndt, MIT: https://github.com/community-access/accessibility-agents at commit `decf6ba` (copied 2026-10-19). `a11y/suite/accessibility-agents/` holds its skills, templates and MCP server source without changes. The license is in `licenses/ACCESSIBILITY-AGENTS-LICENSE`.
- Usability skills `nielsen-heuristics-audit` and `cognitive-walkthrough` by mastepanoski, MIT: https://github.com/mastepanoski/claude-skills at commit `b6457af`. The license is in `licenses/USABILITY-SKILLS-MASTEPANOSKI-LICENSE`.
- Not copied: mgifford/accessibility-skills (AGPL-3.0). Its license would put conditions on the factory as a product. You can install it as a personal skill.
- clean-user-facing-text: copied from a Claude plugin. The source and the license are not checked. Check them before you distribute the factory.
