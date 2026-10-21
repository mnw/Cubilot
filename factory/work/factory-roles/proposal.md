## Why

The factory has seven role definitions with their own skills, models and tool limits (`factory/<role>/`), but the app launches every agent the same way: one Claude Code command with the user's whole skill set and no role. The human must give each agent its job in chat, the challenger roles cannot run on a different model family, and nothing stops an agent from starting hidden sub-agents.

This change lets the app launch an agent with a factory role. A role sets the agent's instructions, model, harness (Claude Code or Pi), skills and tool limits. It is the base for every later part of the brief: sessions for each ticket stage (Part 4) and the councils (Parts 9 and 10) launch agents through it.

Brief: `factory/brief/02-factory-roles.md` (research findings, design steps 1 to 6, checks, tests).

## What Changes

- **Fast path first:** a launch script, `factory/scripts/factory-launch.sh <role> <agent-name>`, builds the role command outside the app. Teams can use the roles at once, and the role prompts and skills get tested before the app work.
- The app bundles `factory/` and stages each role into `<app data>/factory/<role>/` as a Claude Code plugin with skills and hooks only (no `agents/` folder).
- For each Claude role, the app writes `settings.json` with `skillOverrides` that turn off every skill outside the role plugin and the shared plugin, so the 1 % skill-listing budget keeps the role's skills visible.
- `pty_spawn` and `format_claude_command` take an optional `role`. With a role, the Claude command adds `--plugin-dir`, `--append-system-prompt-file`, `--settings`, `--model` and `--disallowed-tools` (every role blocks `Task` and `Agent`). Without a role, the command is unchanged.
- `pi_command` takes an optional `role` for the Validator and the Reviewer: `--provider`, `--model`, `--thinking`, `--append-system-prompt`, `--skill` and `--exclude-tools edit,write`. The role's harness overrides the harness choice in the spawn modal.
- Agents with a role get the handoff, interrupt and ticket tools pre-allowed. `ack_permission` stays with the human.
- UI: a Role dropdown in the spawn modal, a model override for one launch, and role and model on the roster pill.
- "New factory room" preset: launches the Orchestrator, sets it as room lead, and seeds the Nutshell. (The other roles launch for each ticket stage in Part 4.)

## Capabilities

### New Capabilities

- `factory-roles`: staging of role plugins, launch of Claude and Pi agents with a role, skill isolation, tool limits, and the role choice in the UI.

### Modified Capabilities

- `terminal-projection`: the spawn path accepts an optional role. Behaviour without a role does not change.
- `agent-onboarding`: agents with a role get more pre-allowed chatbridge tools.

## Impact

- `src-tauri/src/pty.rs`: `pty_spawn`, `format_claude_command`, `pi_command`, launch-command tests.
- `src-tauri/src/lib.rs`: staging next to `stage_chatbridge_mod`.
- `src-tauri/tauri.conf.json`: `factory/` in the bundle resources.
- `ui/terminal.js`, `ui/features/roster.js`: spawn modal and roster pill.
- `factory/scripts/factory-launch.sh`: new.
- No hub change. No change for agents launched without a role.
