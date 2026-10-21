# Backlog experiment: a separate CLAUDE_CONFIG_DIR for each role

Ticket `t_925d443c927f9f48`. Source: human decision A b) of 2026-10-21 (check 0.2). Experiment only: no product code.
Run by Worker2. Claude Code 2.1.306 (`claude --version`), macOS. `~/.claude` was not written: every run used a new
temp folder as `CLAUDE_CONFIG_DIR`.

## Result in one paragraph

A new `CLAUDE_CONFIG_DIR` removes the account-synced plugins (`seo-aeo-geo-ultimate`, the `anthropic-skills:*`
skills) and every user skill, command, plugin and MCP server: the agent has 18 built-in skills and 3 built-in plugins.
The chatbridge mod still loads from `--plugin-dir` (15 tools). **Blocker: the new directory is not signed in.**
`claude -p` answers `Not logged in · Please run /login`, so the agent cannot call the model until someone signs in
there. `/login` is interactive; I stopped here, as the ticket rule says. Not tested: whether a sign-in in that directory
brings the account-synced plugins back.

## Commands

```sh
CFG=$(mktemp -d /tmp/cfgdir.XXXXXX)          # a NEW folder, never ~/.claude

# 1. does the new dir work?
CLAUDE_CONFIG_DIR=$CFG claude -p "say ok"
#   -> "Not logged in · Please run /login"

# 2. the init event (skills, plugins, MCP servers, tools) is printed BEFORE the model call, so it shows
#    even without a sign-in. Stdin must be redirected, else claude waits 3 s.
CLAUDE_CONFIG_DIR=$CFG claude -p "ok" --output-format stream-json --verbose --model haiku < /dev/null   # "with"
claude -p "ok" --output-format stream-json --verbose --model haiku < /dev/null                           # default dir

# 3. the chatbridge mod in the new dir (room cfg-exp-room is a throwaway room)
CHATBRIDGE_AGENT=cfg-exp CHATBRIDGE_ROOM=cfg-exp-room CLAUDE_CONFIG_DIR=$CFG claude -p "ok" \
  --output-format stream-json --verbose --model haiku \
  --plugin-dir "$HOME/Library/Application Support/Cubilot/chatbridge-mod" < /dev/null
```

What the new dir contained after the runs: `.claude.json`, `backups/`, `projects/`, `sessions/`. No credentials file.

## Skill list, with and without the separate directory (init event)

| | default `~/.claude` | new `CLAUDE_CONFIG_DIR` |
|---|---|---|
| skills | 91 | 18 |
| plugins | 11 | 3 (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`) |
| MCP servers | figma (needs-auth), geo-optimizer, serena | none |
| tools | 54 | 22 |
| `seo-aeo-geo-ultimate:*` (27 skills) | present | **absent** |
| `anthropic-skills:*` (17 skills) | present | **absent** |
| user skills (`~/.claude/skills`), user commands | present | absent |
| installed marketplace plugins (figma, ponytail, ...) | present | absent |

The 18 skills in the new dir are all built in: batch, claude-api, code-review, dataviz, debug, deep-research, design,
design-sync, doctor, fewer-permission-prompts, loop, plugin-authoring, run, run-skill-generator, simplify, update-config,
verify, workflow-authoring. (`code-review` and `deep-research` are built-in names; they are not the factory skills of the
same name.)

With the mod added (`--plugin-dir`): plugins = `chatbridge` + the 3 built-in ones, and 15 `mcp__chatbridge__*` tools.
The mod needs nothing from the config dir: it loads from the path and reads `hub.url` / `hub.token` from
`~/Library/Application Support/Cubilot/`. It did connect to the hub (agent `cfg-exp` in a throwaway room).

## What a role needs in its own directory

| Need | Finding |
|---|---|
| Sign-in | **Blocker.** Not logged in in a new dir. An interactive `/login` is needed. Options not tried: `ANTHROPIC_API_KEY` (a different billing, not the account), `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN` (the token step is interactive). I did not read or copy any credential from `~/.claude` or the keychain. |
| Account-synced plugins | Absent without sign-in. Unknown after sign-in (they come from the account, so they may return). This is the question the experiment was for, and it needs a sign-in to answer. |
| Chatbridge mod | Works: `--plugin-dir`, not in the config dir. |
| MCP servers | None in the new dir. The app passes `--mcp-config <app data>/mcp-configs/global.json` when it exists (not on this machine), so it still works. Server auth (figma `needs-auth`, geo-optimizer, serena) would need a new sign-in in the new dir. |
| Settings | `--settings <file>` works in any dir (the app already uses it for `enabledPlugins` and `skillOverrides`). The user's `~/.claude/settings.json` (hooks, permissions, `autoUpdatesChannel`) is NOT read in the new dir: hooks and permission rules the user set are gone for that role. |
| Trust and onboarding | Not tested; a new dir starts with a new `.claude.json`. |

## Setup steps if the human wants to continue

1. Pick one folder for each role, for example `<app data>/claude-config/<role>`.
2. Sign in once in each folder: `CLAUDE_CONFIG_DIR=<folder> claude`, then `/login` (interactive; the human does this).
3. Re-run command 2 above. Check whether `seo-aeo-geo-ultimate:*` returns after the sign-in. If it does, the separate
   directory does not remove account-synced plugins, and the `enabledPlugins` / `skillOverrides` generator (task 1.3) stays
   the only tool.
4. If it does not return: the cost is one sign-in for each role folder, no user hooks or permission rules, and MCP
   servers set up again.

## Limits of this experiment

- One Claude Code version (2.1.306), one machine.
- The init list was read from the stream-json init event, not from `/context`.
- Sign-in was not tested, so the main question (do account-synced plugins return after sign-in) is open.
