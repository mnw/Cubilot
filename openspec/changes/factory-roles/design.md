## Context

Research, sources and the reasons for each decision are in `factory/brief/02-factory-roles.md` ("Research findings"). This file keeps only what the implementation needs.

## Goals / Non-Goals

**Goals:** launch any agent with a role; the right harness, model, skills and tool limits for each role; no change for agents without a role; a script that does the same before the app work is done.

**Non-goals:** launching agents for each ticket stage (Part 4); the toolchain bundle (Part 7); the setup screen (Part 8). The preset in this change launches only the Orchestrator.

## Decisions

1. **Do not use `claude --agent <role>`.** It replaces the default system prompt. Use `--append-system-prompt-file` (brief, finding 1).
2. **One plugin for each role**, staged into app data like the chatbridge mod, never into the signed bundle (finding 2, `lib.rs:753`).
3. **Skills only, no sub-agents.** The plugin has no `agents/` folder. Every Claude role gets `--disallowed-tools Task,Agent` (Part 4, decision 1).
4. **Skill isolation with `skillOverrides`.** The app lists the skills that Claude Code finds and turns off every skill outside the role plugin and the shared plugin (step 1, item 4). Pi gets only the role's `--skill` folders.
5. **Pi roles use `--exclude-tools`, not `--tools`.** `--tools` is an allowlist and removes the chatbridge tools (finding 6, item 1).
6. **The role's harness wins.** A Pi role cannot run on Claude Code from the modal, because its skills and limits are made for Pi.
7. **The launch script builds the same command as the app.** Both read the same role frontmatter, so the script is a working reference for the Rust code.

## Risks / Trade-offs

- Pi has no permission gate on `bash`: a Pi Validator can still write files through `bash`. Mitigation in Part 4: a read-only worktree for the Validator and the Reviewer (finding 6, item 3).
- Model IDs change. Check `pi --list-models` before release (finding 6, item 4).
- `skillOverrides` names for plugin skills: check the exact key form (`plugin:skill` or bare name) on the installed Claude Code version before you write the generator.

## Open Questions

- The exact `skillOverrides` key form for plugin skills (see above).
