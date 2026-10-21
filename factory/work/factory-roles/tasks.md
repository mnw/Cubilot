## 0. Checks before the build (brief, "Check before you build")

- [ ] 0.1 `claude --help` on the installed version lists `--append-system-prompt-file`, more than one `--plugin-dir`, `--disallowed-tools` and `--settings` → verify: record the version and the flags in this file
- [ ] 0.2 Find the `skillOverrides` key form for user skills and for plugin skills → verify: a test `settings.json` turns off one plugin skill, and `/context` no longer lists it
- [ ] 0.3 `pi --list-models` shows the OpenAI model for the Validator and the Reviewer → verify: update `model:` in `validator.md` and `reviewer.md` if needed

## 1. Launch script (fast path)

- [ ] 1.1 `factory/scripts/factory-launch.sh <role> <agent-name> [--model <m>]`: read the role frontmatter (`harness`, `model`, `provider`, `thinking`, `disallowedTools`, `excludeTools`) → verify: `--dry-run` prints the command for each of the seven roles
- [ ] 1.2 Claude branch: `--append-system-prompt-file` with the role body, `--plugin-dir factory/<role>`, `--model`, `--disallowed-tools` with `Task,Agent` → verify: a `worker` launched with the script answers "which role are you" correctly and cannot start a sub-agent
- [ ] 1.3 Settings generator: write `settings.json` with `skillOverrides` `"off"` for every skill outside the role and the shared plugin → verify: `/context` in the launched agent lists only the role skills
- [ ] 1.4 Pi branch for `validator` and `reviewer`: `--provider`, `--model`, `--thinking`, `--append-system-prompt`, `--skill`, `--exclude-tools edit,write` → verify: the Pi Validator lists the chatbridge tools and has no `edit` or `write` tool
- [ ] 1.5 The script joins the current room like an app agent (same chatbridge mod and MCP config) → verify: a scripted `worker` and an app agent exchange a handoff

## 2. Bundle and stage (design step 1)

- [ ] 2.1 Add `factory/` to the Tauri bundle resources → verify: the built app contains `factory/<role>/<role>.md` for all roles
- [ ] 2.2 Stage each role into `<app data>/factory/<role>/` next to `stage_chatbridge_mod`: `.claude-plugin/plugin.json`, `skills/`, `role.md` without frontmatter, `hooks/hooks.json` when present, no `agents/` → verify: tests 7 and 8 of the brief
- [ ] 2.3 Write `settings.json` for each Claude role with the generator logic of task 1.3 → verify: test 8a of the brief

## 3. Spawn with a role (design steps 2 and 6)

- [ ] 3.1 `role: Option<String>` on `pty_spawn` and `format_claude_command`; parse the frontmatter; unknown role is an error → verify: tests 1, 4 and 5 of the brief
- [ ] 3.2 Claude command with role: `--plugin-dir`, `--append-system-prompt-file`, `--settings`, `--model`, `--disallowed-tools` → verify: tests 2 and 3
- [ ] 3.3 `role: Option<&str>` on `pi_command` with the Pi flags; keep `--no-approve`, the shared `--skill` and `--prompt-template` folders and `-e` → verify: test 6
- [ ] 3.4 The role's harness overrides the modal's harness → verify: test 6 (validator with the modal on Claude)
- [ ] 3.5 Before a Pi launch, run `pi auth check --provider openai --json`; on failure show a clear message and launch nothing → verify: launch with no OpenAI sign-in shows the message

## 4. Pre-allowed tools (design step 3)

- [ ] 4.1 For an agent with a role, pre-allow the handoff, interrupt and ticket tools; do not pre-allow `ack_permission` → verify: a Worker sends and accepts a handoff and creates a ticket without a permission prompt; `ack_permission` still asks the human

## 5. UI (design step 4)

- [ ] 5.1 Role dropdown in the spawn modal, filled from the staged roles; "None" keeps today's behaviour → verify: spawn with "None" gives the same command as before (test 1)
- [ ] 5.2 Show the role's harness and model as defaults; model override for one launch; no harness change for a Pi role → verify: test 10
- [ ] 5.3 Remember role and model override for each agent name (like the cwd cache, `ui/terminal.js:142`) → verify: reopen the modal for `worker-1` and see the last role
- [ ] 5.4 Roster pill shows role, model and, for Pi, the provider → verify: visual check with one Claude and one Pi agent

## 6. Factory preset (design step 5, reduced)

- [ ] 6.1 "New factory room": ask for room name, project folder, worker and tester limits; launch `orchestrator` only → verify: the room has one agent with role `orchestrator`
- [ ] 6.2 When `orchestrator` connects, set it as room lead (`POST /rooms/:room/lead`) → verify: the room header shows the lead
- [ ] 6.3 Seed the Nutshell from a template (product, repo, branch policy, style guide path, definition of done) → verify: the Orchestrator's Briefing contains the Nutshell
- [ ] 6.4 Store the worker and tester limits for Part 4 → verify: the limits are in the room settings

## 7. Checks after the build (brief, checks 2 to 8)

- [ ] 7.1 The chatbridge prompt section still loads with `--append-system-prompt-file` → verify: the agent repeats its chatbridge rules
- [ ] 7.2 Two agents of one role in different worktrees share the staged plugin without conflict → verify: `worker-1` and `worker-2` run at the same time
- [ ] 7.3 The Editor's STE hook fires through `--plugin-dir` for `mcp__chatbridge__send_handoff` → verify: test 9 of the brief
- [ ] 7.4 A skill of one role is not visible to another role → verify: `/context` of `tester` does not list `code-review`
