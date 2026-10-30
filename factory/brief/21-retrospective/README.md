# Part 21: the retrospective role and its skills

The role folder is `factory/retrospective/` (moved from this folder by Part 21 group 2). This file keeps the list of skills and their sources.
ECC skills are copied from affaan-m/ecc at commit `b38be6a7` (2026-10-30). The Agency `workflow-optimizer` is converted from agency-agents at commit `b37b5bb` (2026-10-30).

## Skills of the role

| Skill | Source | Why | How |
|---|---|---|---|
| `retrospective-review` | factory (new, draft here) | The weekly procedure: read the evidence file, judge last week's changes (keep or revert), write at most 3 proposals in the schema | Draft in `retrospective/skills/retrospective-review/SKILL.md` |
| `loop-design-check` | ECC (affaan-m/everything-claude-code, MIT) | Checks whether a factory loop spins, games its verifier, or runs a wrong answer to the end. Fits FAIL loops and review rules | Copy `skills/loop-design-check/` at a pinned commit |
| `agent-architecture-audit` | ECC | Severity-ranked findings on an agent stack: wrapper regressions, hidden repair loops, tool discipline. Fits proposals on role files and the hub | Copy at the same commit |
| `agent-introspection-debugging` | ECC | A taxonomy of agent failure patterns (repetition loop, context overflow, stale state, rate limit). Fits the stage failures and "no result" sessions in the evidence | Copy at the same commit |
| `growth-log` | ECC | Writes lessons as reusable patterns, not as a diary. Fits the "lessons" part of the result | Copy at the same commit |
| `agency-testing-workflow-optimizer` | Agency (msitarzewski/agency-agents, MIT) | Baseline first, then before/after with numbers. Fits the keep-or-revert check | Convert the agent file to a skill, as for the other `agency-*` skills |
| `agency-testing-test-results-analyzer` | Agency, already in `validator/skills/` | Reads test results and quality metrics: tester hours, flaky tests, suite failures | Same copy as the Validator's |
| `context-engineering` | Osmani (addyosmani/agent-skills, MIT), already in `orchestrator/skills/` | Proposals that change a role file or a first message | Same copy as the Orchestrator's |

Not used: ECC `continuous-learning` and `continuous-learning-v2`. They write learned skills by themselves from a Stop hook. Part 21 forbids that: the retrospective only proposes, and the human approves each change.

The licenses of ECC, Agency and Osmani are already in `factory/licenses/`.
