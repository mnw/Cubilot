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
6. **The role's harness wins.** A Pi role cannot run on Claude Code from the modal, because its skills and limits are made for Pi.
7. **The launch script builds the same command as the app.** Both read the same role frontmatter, so the script is a working reference for the Rust code.
8. **Editor gate in the Reviewer, not in a hook.** Plugin hooks do not run for chatbridge tools (check 0.4). The Reviewer runs `ste-lint.py` and declines a failed handoff. The Editor role text keeps the rule. A deliberate break is listed by the Editor in `change_summary` as `ste_disable: <rule> at <line>: <reason>` (human decision 2026-10-21). The Reviewer runs the linter twice: with `--disable` for the listed rules (it must exit 0), and without (every hit of a listed rule must be at a listed line, else decline). The Reviewer judges each reason.
9. **One shared plugin for every role.** `factory/shared` (`factory-shared`) holds `asd-ste100`. Every role loads it.
10. **User skill layer on top of the bundle.** `<app data>/factory-user/<role>/skills/` wins over bundled skills of the same name. The user keeps only their changes, so app updates still bring new bundled skills. Every staging writes a new version folder; a running agent keeps its version. Reload without a block is proposed, the human has not approved it yet.

## Risks / Trade-offs

- Pi has no permission gate on `bash`: a Pi Validator can still write files through `bash`. Mitigation in Part 4: a read-only worktree for the Validator and the Reviewer (finding 6, item 3).
- Model IDs change. Check `pi --list-models` before release (finding 6, item 4).
- Account-synced plugins cannot be turned off for one agent, so their skills use part of the skill-listing budget (accepted, check 0.2).
- The Editor gate is an instruction to the Reviewer, not enforcement. A bridge-level gate is in the backlog.
- A user skill is not reviewed. Its description decides when it loads, so a bad user skill can make a role work worse without an error.

## Open Questions

- Reload behaviour (task 8.3): new version without a block is proposed. The human must approve it.
- Check 0.2 answered the `skillOverrides` key form: the bare skill name, user and project skills only.
