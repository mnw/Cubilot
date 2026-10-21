# Part 10: SEO council

Status: decision 2026-10-19. Build it after Part 9. It uses the council form that Part 9 builds.

## Goal

The factory does SEO, AEO and GEO work as a council. Two members on different model families (Claude and OpenAI) analyse the same evidence. A chair compares their reports. Agreement between two model families is stronger evidence than one opinion. A disagreement is shown to the human, not hidden in an average.

## Role and seats

The role file is `factory/seo/seo.md`. The seats are in `factory/seo/council.yaml`:

| Seat | Harness and model | Job |
|---|---|---|
| `seo-capture` | Claude Code, sonnet | Collects the evidence pack one time. Does not analyse. |
| `seo-claude` | Claude Code, sonnet | Member. Analyses the evidence pack. |
| `seo-openai` | Pi, OpenAI (`gpt-5.5`, check with `pi --list-models`) | Member. Analyses the same evidence pack. |
| `seo-chair` | Claude Code, opus | Compares the two member reports and writes the council result. |

All seats use the same role file. The first message names the seat.

## Flow of an `[seo]` ticket

1. The ticket goes through spec review like all tickets (Part 4, item 9).
2. The hub launches `seo-capture`. It writes `<ticket folder>/evidence/` and `evidence/manifest.json` (source, date and SHA-256 of each file, and the gaps).
3. The hub launches `seo-claude` and `seo-openai` at the same time. Both get the same first message: the ticket, the evidence pack path, and `suite_root`. The hub does not give a member the other member's report.
4. When both member reports are in, the hub launches `seo-chair` with both reports.
5. The chair puts each finding in one class: agreed, single (the chair checks it against the evidence and accepts or rejects it), or conflict. It writes `council/result.json` and `result.md`.
6. The Orchestrator creates `draft` tickets for the accepted actions and sends them to spec review. It sends the conflicts and the questions to the human.
7. After a release, a new `[seo]` ticket of the type "check" runs the council again on new evidence, with the skill `seo-plan` (lane `optimise-seo`, closeout).

## Skills: the suite folded into six skills

The source is "SEO-AEO-GEO Ultimate" v3.3.0 by Oegeyilmaz9, Apache License 2.0. It has 27 skills, which is too many for the skill listing (Part 2, step 1, item 4).
- `factory/seo/suite/` keeps the suite unchanged: 26 lane skills, the scripts, the docs, the manifests and the assets. Only the `agents/openai.yaml` files are removed. Claude Code does not list these skills, because they are not in the plugin's `skills/` folder.
- `factory/seo/skills/` has six new factory skills: `seo-research`, `seo-audit`, `seo-geo-aeo`, `seo-content`, `seo-plan` and `seo-verticals`. Each is short. It names its lanes and tells the agent to read the full lane `SKILL.md` in the suite.
- The suite's router skill `seo` is not used. It runs its own orchestration, which competes with the Orchestrator and the council.
- `<suite-root>` in the suite files means `${CLAUDE_PLUGIN_ROOT}/suite` on Claude Code. For Pi, the app writes `.seo-suite-runtime.json` with `suite_root`, as the suite expects, and puts the path in the first message.
- The suite validators need Python 3.11 or later. The app installs it with `uv` (Part 7). The Doctor checks it.
- License: keep `factory/licenses/SEO-AEO-GEO-ULTIMATE-LICENSE` and `-NOTICE` with the files. The six factory skills say that they are new files.

## Launch changes

1. Staging (Part 2, step 1): stage `factory/seo/` as one plugin, with `suite/`. For the Pi member, also pass the `skills/` folder with `--skill`, and the suite path.
2. The hub reads `council.yaml` for the harness, model and tool limits of each seat. A seat is a session of the role `seo` with a seat name.
3. The user's own SEO plugin (if installed) is set to `"off"` in `skillOverrides` for factory sessions (Part 2, step 1, item 4). The factory uses only its folded copy.
4. Dashboard (Part 11): show an `[seo]` ticket with its four stages, and the numbers of agreed, single and conflict findings.

## Open questions

1. Web access for the OpenAI member. Pi has no built-in web tools. The evidence pack is made so that the members do not need the web. When a member needs more evidence, it lists the gap, and the Orchestrator can ask for a new capture.
2. Client data. Search Console and analytics exports are client data. The project setting for outside services (Part 13, `mutation_triage`) needs a general form: `external_data_policy`. The suite must not send client data to an outside service that the setting does not allow.
3. Cost. One `[seo]` ticket runs four sessions. Measure the tokens (Part 4, "Context pack", item 6).

## Tests

1. An `[seo]` ticket launches `seo-capture` first, then the two members at the same time, then the chair.
2. The first message of `seo-openai` does not contain the report of `seo-claude`, and the reverse.
3. Both members get the same `evidence/manifest.json` hash.
4. The chair result has the three classes, and each "single" finding has a check result.
5. A conflict in the result creates a question for the human, not a ticket.
6. The skill listing of an SEO seat shows the six factory skills and not the 27 suite skills.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
