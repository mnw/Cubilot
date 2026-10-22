## Context

Research, sources and the reasons for each decision are in `factory/brief/02-factory-roles.md` ("Research findings"). This file keeps only what the implementation needs.

## Goals / Non-Goals

**Goals:** launch any agent with a role; the right harness, model, skills and tool limits for each role; no change for agents without a role; a script that does the same before the app work is done.

**Non-goals:** launching agents for each ticket stage (Part 4); the toolchain bundle (Part 7); the setup screen (Part 8). The preset in this change launches only the Orchestrator.

## Decisions

1. **Do not use `claude --agent <role>`.** It replaces the default system prompt. Use `--append-system-prompt-file` (brief, finding 1).
2. **One plugin for each role**, staged into app data like the chatbridge mod, never into the signed bundle (finding 2, `lib.rs:753`).
3. **Skills only, no sub-agents.** The plugin has no `agents/` folder. Every Claude role gets `--disallowed-tools Task,Agent` (Part 4, decision 1).
4. **Skill isolation with `enabledPlugins` and `skillOverrides`.** The app turns off every installed and `--plugin-dir` plugin outside the role plugin and the shared plugin with `enabledPlugins`, and every user and project skill outside them with `skillOverrides` (step 1, item 4). Account-synced plugins stay visible (check 0.2, human decision 2026-10-21). Pi gets only the role's `--skill` folders.
5. **Pi roles use `--exclude-tools`, not `--tools`.** `--tools` is an allowlist and removes the chatbridge tools (finding 6, item 1).
6. **The harness in the modal decides; the role's harness is the default** (human decision 2026-10-22, replaces "the role's harness wins"). Every role file has tool limits for both harnesses. The role's model applies only on the role's harness; on the other harness the human picks a model. A `validator` or `reviewer` on Claude loses the different-model-family cross-check by the human's choice. The New factory room window has the same harness and grid choice for the orchestrator.
7. **The launch script builds the same command as the app.** Both read the same role frontmatter, so the script is a working reference for the Rust code.
8. **Editor gate in the Reviewer, not in a hook.** Plugin hooks do not run for chatbridge tools (check 0.4). The Reviewer runs `ste-lint.py` and declines a failed handoff. The Editor role text keeps the rule. A deliberate break is listed by the Editor in `change_summary` as `ste_disable: <rule> at <line>: <reason>` (human decision 2026-10-21). The Reviewer runs the linter twice: with `--disable` for the listed rules (it must exit 0), and without (every hit of a listed rule must be at a listed line, else decline). The Reviewer judges each reason.
9. **One shared plugin for every role.** `factory/shared` (`factory-shared`) holds `asd-ste100`. Every role loads it.
10. **User skill layer on top of the bundle.** `<app data>/factory-user/<role>/skills/` wins over bundled skills of the same name. The app seeds a copy of each bundled skill into the user folder, with a `.cubilot-seed` hash (human decision 2026-10-22), so the user sees and edits the provided skills there. The app never changes an existing copy, because a refresh can race a user's save (Validator review 2026-10-22). An app update logs the copies that are unchanged but older than the bundle; the user deletes such a folder to get the new version. A deleted copy is seeded again. Every staging writes a new version folder.
11. **Hot reload of skills** (human decision 2026-10-22; revised after the Validator design and code reviews of 2026-10-22). Each agent has two records in `factory/agents/`: its link `<hex of agent name>` (the files it sees, named by its launch flags) and `<hex>.applied` (the version its runtime loaded with success). A shared link would change a busy agent's reads, so there is none in the launch flags. A new session deletes the records of an earlier launch with the same name; only a role launch writes them again, so a no-role or legacy session has no link and never reloads. The desired version is `CUBILOT_FACTORY_VERSION` in the hub, sent in the briefing. The bridge keeps no version state. At the agent's idle point (at once when idle, after its run when busy), the bridge calls `POST /factory/relink`: reload when the link or `.applied` differs from the desired version (the hub moves the link first), no reload when both match, 404 with no link, 409 with no desired version. There is no rollback. A reload in progress is marked by `<hex>.pending`: while it exists, relink answers no reload for any version, so a replacement bridge or a newer version never starts a second reload. Elapsed time never clears it; only a recorded success or failure (`/factory/applied`) or a new session does. A reload that never completes stays blocked and the bridge logs "hot reload still pending: restart the agent". Every reload is bounded to 30 s from the bridge's view, and a late Claude success is still recorded. A failed Pi reload leaves an invalid runtime, so the agent posts "hot reload failed, restart this agent" to the human and is not reconnected in place (accepted limit). Claude reloads only changed modules, so the bridge is never stopped before a reload; a replaced module ends the old bridge by a generation number in `$.state`. No input goes to a terminal. A Claude agent keeps its launch-time role text. Accepted limits: chat in flight can be lost at the hub restart; a new run that starts while relink is pending can see changed files. Live evidence: spike t_a110c82762e4cf00, sections 5, 7 and 8.

## Risks / Trade-offs

- Pi has no permission gate on `bash`: a Pi Validator can still write files through `bash`. Mitigation in Part 4: a read-only worktree for the Validator and the Reviewer (finding 6, item 3).
- Model IDs change. Check `pi --list-models` before release (finding 6, item 4).
- Account-synced plugins cannot be turned off for one agent, so their skills use part of the skill-listing budget (accepted, check 0.2).
- The Editor gate is an instruction to the Reviewer, not enforcement. A bridge-level gate is in the backlog.
- A user skill is not reviewed. Its description decides when it loads, so a bad user skill can make a role work worse without an error.

## Open Questions

- Reload behaviour (task 8.3): decided by the human on 2026-10-22 (hot reload, decision 11). The state model and the failure rule follow the Validator design review of 2026-10-22.
- Check 0.2 answered the `skillOverrides` key form: the bare skill name, user and project skills only.
