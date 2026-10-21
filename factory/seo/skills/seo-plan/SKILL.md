---
name: seo-plan
description: Turns the council's SEO, AEO and GEO findings into an action plan for approval, with order, owners, risks, rollback and checks. Also checks the result after the Worker implemented an action. Use when the council has findings, and for an [seo] check ticket after a release.
---

> Factory skill (2026-10-19). It folds skills of "SEO-AEO-GEO Ultimate" v3.3.0 by Oegeyilmaz9 (https://github.com/oegeyilmaz9/seo-aeo-geo-ultimate), Apache License 2.0. The original skills are unchanged in `suite/skills/`. This file is new: it routes to them. License and NOTICE: `factory/licenses/SEO-AEO-GEO-ULTIMATE-LICENSE` and `-NOTICE`.

## Rules that always apply

1. `<suite-root>` in the suite files means `${CLAUDE_PLUGIN_ROOT}/suite` on Claude Code. On Pi, use the `suite_root` path in your first message.
2. Read the full original `SKILL.md` of each lane that you use, and the reference files that it names. Do not work from this summary alone.
3. Do not run the suite's autonomous mode (the `seo` router skill). The Orchestrator and the SEO council own the order of work. Use `suite/skills/seo/references/routing-matrix.md` only to choose lanes.
4. Work from the evidence pack of the ticket (the role file `seo.md`, "Evidence pack"). Do not change it. When evidence is missing, list it as a gap. Do not bypass log-ins, paywalls, bot controls or rate limits.
5. No ranking, traffic, citation or revenue guarantees. No single SEO score.
6. Each finding names its evidence (URL, file, capture id or data export), its lane, and your confidence.
7. Do not change code or content. Findings become `[code]` or `[doc]` tickets through the Orchestrator.
8. Do not start sub-agents.

## Lanes

| Lane | Use it for | Read |
|---|---|---|
| `seo-action-plan` | Approval-ready actions with evidence links, owners, risk and rollback | `suite/skills/seo-action-plan/SKILL.md` |
| `seo-plan` | Roadmap and sequence with dependencies and review gates | `suite/skills/seo-plan/SKILL.md` |
| `optimise-seo` | Verification and closeout after the Worker implemented an approved action (the suite's implementation steps are done by the Worker on [code] tickets) | `suite/skills/optimise-seo/SKILL.md` |

## Procedure

1. Read the ticket, the evidence pack and the notes of earlier stages.
2. Choose the lanes that the ticket needs from the table. Write down which lanes you did not use, and why.
3. For each lane, read its `SKILL.md` and its `references/markdown-delivery-contract.md`. Follow the lane's own procedure and output contract.
4. Run the suite validators that the lane names (Python 3.11 or later, from `<suite-root>/scripts/`). A validator that fails is a finding about your own output. Fix the output first.
5. Write your member report (the role file `seo.md`, "Member report").
