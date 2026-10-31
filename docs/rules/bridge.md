# Rules: bridge

Chatbridge mod, pi extension, skills, Claude Code version and hook rules.

## Pi has no MCP support by design — the chatbridge ships as a pi extension, not a sidecar

- **Pi has no MCP support by design — the chatbridge ships as a pi extension, not a sidecar.** `hub/channel/pi-extension.ts` imports the SAME `core.ts`, `tools.ts` and `hub-client.ts` the Claude mod uses; tool definitions are never duplicated across runtimes. It is bundled by `scripts/build-sidecars.sh` to `src-tauri/resources/pi-extension.js` (gitignored build artifact) and loaded via `pi -e`. **After changing `hub/channel/pi-extension.ts`, `tools.ts`, or `hub-client.ts`, rerun `./scripts/build-sidecars.sh`** — the `.app` loads the bundle, not the TypeScript. Identity reaches it as `CHATBRIDGE_AGENT`/`CHATBRIDGE_ROOM` env on the tmux command, the same way it reaches the Claude mod.

## Pi agents reuse Claude Code's skills and commands; they do NOT get its MCP servers, plugins, or hooks

- **Pi agents reuse Claude Code's skills and commands; they do NOT get its MCP servers, plugins, or hooks.** Pi implements the same Agent Skills standard (`<dir>/SKILL.md` + `name`/`description` frontmatter), so `claude_resource_flags()` in `pty.rs` passes `--skill ~/.claude/skills` and `--prompt-template ~/.claude/commands` (plus the project-local `.claude/` equivalents) on every pi spawn without a factory role. A spawn with a factory role (change factory-roles, task 3.3) passes `--no-skills` and only the staged role and `shared` `--skill` folders instead, with no `claude_resource_flags()` folders: pi 1.3.0 also discovers `~/.claude/skills` by itself, so flag order alone cannot pick the factory copy — **project-local paths are passed first** because pi resolves name collisions first-one-wins, which reproduces Claude Code's closest-scope-wins precedence. Only existing paths are passed; pi warns on missing ones. `CLAUDE.md` is read by pi natively. Plugin skills are shared too, but only for plugins listed in `SHARED_CLAUDE_PLUGINS` (currently figma) — resolved through `installed_plugins.json` rather than a pinned path, because the plugin cache keeps stale version dirs beside the live one and globbing the plugin dir double-loads every skill. Keep the list explicit: each skill costs ~155 tokens of system prompt in every request, so sharing a plugin is a judgement call, not a sweep. Claude's MCP servers, marketplace plugins, and `~/.claude/settings.json` hooks have no pi equivalent and are silently absent — don't assume parity when debugging a pi agent that "can't do what the claude one does".

## Per-agent skill switches keep their state in the factory dir, `<app data>/factory/agents/`, next to the agent link `<hex>`

- **Per-agent skill switches keep their state in the factory dir, `<app data>/factory/agents/`, next to the agent link `<hex>`.** `<hex>` is the lowercase hex of the agent name. `.skills-off` is the human's choice. Only the hub writes .skills-off (`hub/core/skills.ts`, routes `GET` and `PUT /agents/{name}/skills`, `POST /agents/{name}/skills/apply`). `.skills-prepared` is the build the app prepares on a click. A role launch with at least one skill off builds a view, swaps `.view` to it, and writes `.skills-published` and `.skills-applied`. A launch with no skill off builds no view and keeps the link (`launch_in` in `src-tauri/src/skills.rs`). At a reload, `/factory/relink` publishes the prepared build and writes `.skills-pending`. A success report with the matching attempt copies it to `.skills-applied` (`hub/features/factory-skills.ts`, `hub/features/factory.ts`). `.view` links to the built `.view-<gen>` folder, which the launch flags name only after the first uncheck. `.skills-lock` and `.skills-lock.guard` serialise the publication. See `docs/PROTOCOL.md` (`/factory/relink`, `/factory/applied`, `/agents/{name}/reload`).

## Skills are added per role, not per agent

- **Skills are added per role, not per agent.** There is no per-agent skill add. The limit and its workaround are in `docs/SKILLS.md` ("Known limits").

## Briefings re-send on roster/presence change, not once per process

- **Briefings re-send on roster/presence change, not once per process.** `hub/core/briefing-dispatcher.ts` owns this: `scheduleFanout()` (500 ms reset-on-call debounce) rebuilds each connected agent's briefing and enqueues it only when its signature (`briefingSignature()` in `hub/core/briefing.ts`: room, peers + online flags, nutshell, summary layer counts) differs from the last one sent to that agent; `forceFanout()` skips the dedup. Permanent members (human) are never briefed. The bridge core delivers a briefing in `context` mode — it never wakes the agent. The last-sent signatures live in memory only; a hub restart re-briefs everyone.

## The chatbridge is a Claude Code mod, not an MCP server. `--mcp-config <path>` carries ONLY the user's own global MCP servers

- **The chatbridge is a Claude Code mod, not an MCP server. `--mcp-config <path>` carries ONLY the user's own global MCP servers.** Cubilot generates `~/Library/Application Support/Cubilot/mcp-configs/global.json` (mode `0600`) from the user's global MCP config with the `chatbridge` entry filtered out, so a stale user entry can never shadow or duplicate the mod's `mcp__chatbridge__*` tools. Claude loads it additively with the cwd's own `.mcp.json`. Never write to the user's project `.mcp.json`.

## The mod is staged, never loaded from inside the `.app`

- **The mod is staged, never loaded from inside the `.app`.** `lib.rs` materializes it atomically at `~/Library/Application Support/Cubilot/chatbridge-mod/` at startup (sibling temp dir, then rename) and `pty.rs::claude_command` passes that path to `--plugin-dir`. Claude Code writes `.claude-plugin/types/`, `.gitignore` and `tsconfig.json` into every `--plugin-dir` it loads; pointing it into the signed bundle would modify the bundle. Identity reaches the mod as `CHATBRIDGE_AGENT`/`CHATBRIDGE_ROOM` env on the tmux command, same as pi.

## The bridge core owns policy; adapters implement `Host` only

- **The bridge core owns policy; adapters implement `Host` only.** Room gate, briefing/nutshell text, the message envelope, delivery mode (`context` / `steer` / `wake`) and the post-delivery check live in `hub/channel/core.ts`. `hub/channel/pi-extension.ts` and `hub/channel/claude-mod/register.ts` supply a `Host` (`hub/channel/host.ts`: request, stream, upload, deliver, log) and wire runtime events to `onRunEnd`/`onToolResult` — nothing else. A policy change made in one adapter is a bug; make it in the core. `tools.ts` and `hub-client.ts` do I/O through the `Host`, never `node:*` or global `fetch`.

## The mod's tool hook must ask `$.tool.check` before running a chatbridge tool

- **The mod's tool hook must ask `$.tool.check` before running a chatbridge tool.** It answers the call itself, so Claude Code's permission step beneath it never runs. `deny`, or an `ask` that comes from a user settings rule, refuses the call (a mod tool has no approval dialog — failing closed honours the rule); an `ask` from the permission mode alone runs the tool — so in `default` mode all seventeen chatbridge tools (the nine bridge tools plus `checkpoint_note`, `create_ticket`, `claim_ticket`, `transition_ticket`, `assign_ticket`, `attach_ticket_file`, `list_tickets`, `edit_ticket`) run without a prompt. Never remove this check: without it a user's ask/deny rules on `mcp__chatbridge__*` are silently bypassed.

## `PreToolUse` and `PostToolUse` hooks do not run for chatbridge tools

- **`PreToolUse` and `PostToolUse` hooks do not run for chatbridge tools.** Tested live on Claude Code 2.1.306 on 2026-10-21: PreToolUse and PostToolUse hooks from a plugin do not run for mcp__chatbridge__* tools, because the mod answers the call itself. (Evidence: `openspec/changes/factory-roles/tasks.md`, check 0.4; a control hook on `Bash` ran in the same session.) The mod's `tool.call` hook never calls `next(e)`; per the declarations, `next(e)` is what runs "the hooks beneath, then core", and `$.tool.check` "asks no PreToolUse hook or classifier". The user's allow/ask/deny *rules* are still honoured through `$.tool.check`. Hooks in `~/.claude/settings.json` were not tested separately. Do not rely on a hook to police chatbridge tools.

## `--allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'` stays on the claude command in `hub/core/launch-command.ts` (pinned by `tests/unit/launch-command.test.ts`)

- **`--allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'` stays on the claude command in `hub/core/launch-command.ts` (pinned by `tests/unit/launch-command.test.ts`).** It is a leftover of the MCP era, kept on purpose and not yet proven redundant: the three tools already run in `default` mode through the mod, but the allow rule probably still matters in a mode that turns an unresolved `ask` into a deny (the other thirteen tools would then be denied; untested). Removing it, or extending it to all sixteen, needs a live check of `$.tool.check` under such a mode first. Do not delete it as dead code on sight.

## In the mod, `$` may only be passed to top-level function declarations

- **In the mod, `$` may only be passed to top-level function declarations.** `claude plugin validate` rejects anything else. The `Host` is built in a top-level `makeHost($)` that returns closures over `$`; the core never sees `$`.

## After changing anything under `hub/channel/**`, rerun `./scripts/build-sidecars.sh` AND `./scripts/check-mod.sh`

- **After changing anything under `hub/channel/**`, rerun `./scripts/build-sidecars.sh` AND `./scripts/check-mod.sh`.** The `.app` loads the bundles (`pi-extension.js`, `chatbridge-mod.js`), not the TypeScript; `check-mod.sh` runs `claude plugin validate` and type-checks `register.ts` against the Claude Code declarations (the root `tsconfig.json` excludes `hub/channel/claude-mod/**`).

## Claude Code 2.1.296 is the minimum; the app refuses older versions at spawn

- **Claude Code 2.1.296 is the minimum; the app refuses older versions at spawn.** Installed plugins' hooks modules sit behind Claude Code's rollout flag `tengu_plugin_hooks_modules`; on 2.1.287 a stale disk-cached "off" silently disabled the mod in new processes. If a Claude agent never joins (the tab warns after 20 s), check its debug output for "hooks modules not loaded" before suspecting the bridge. Never force the flag (e.g. `DISABLE_GROWTHBOOK`). Claude Code's `stable` auto-update channel lagged at 2.1.287 (2026-10-13) and its auto-updater reinstalled it over 2.1.296; machines running Cubilot need `"autoUpdatesChannel": "latest"` in `~/.claude/settings.json` until stable reaches 2.1.296.

## Verified against Claude Code 2.1.296 and pi 0.87.1

- **Verified against Claude Code 2.1.296 and pi 0.87.1** (first built on 2.1.287). Mods are early access; re-run the spike evidence (`openspec/changes/chatbridge-claude-mod/design.md`, "Spike results") and `test-matrix.md` when either version changes. See `docs/adr/0011-chatbridge-runtime-core.md`.

## Claude settings (hooks) pass via `--settings <path>`, mirroring the `--mcp-config` pattern

- **Claude settings (hooks) pass via `--settings <path>`, mirroring the `--mcp-config` pattern.** Cubilot materializes per-agent settings at `~/Library/Application Support/Cubilot/settings/<agent>.json` (mode `0600`, atomic write via tmpfile + rename). Currently registers a single `Stop` hook that writes a sentinel file under `/tmp/cubilot/<CUBILOT_AGENT>/signals/` for the deterministic-tui-capture orchestrator's completion signal. Never write to the user's `~/.claude/settings.json`. The hook command MUST use BSD-userland `date` syntax only (`%s` whole-second epoch); GNU extensions like `%3N` produce literal output on macOS. Sub-second ordering comes from filesystem mtime (`stat -f %m`).

## The bridge core enforces the room as defense-in-depth

- **The bridge core enforces the room as defense-in-depth.** Even though the hub routes by room, `hub/channel/core.ts` compares `room` on every inbound event against its configured `CHATBRIDGE_ROOM` and drops concrete mismatches with a `host.log` line (null/absent room = system/global, let through). Never remove this gate on the theory that the hub is correct — a regression in routing should surface as drop-log noise, not silent context pollution in an agent's session.

## `post_file` follows symlinks

- **`post_file` follows symlinks.** `Host.upload` stats with symlinks followed (`statSync` in `hub/channel/node-host.ts`, `$.fs.stat` and `curl -F` in the Claude mod), not `lstatSync`. An agent passing `/tmp/link-to-id_rsa` would exfiltrate the target. Not privilege escalation (agents run as the user) but a compromised tool-use path could abuse it. Accepted because rejecting symlinks is security theater unless we also sandbox the entire path — agents already have full fs access. Treat `post_file` as "agent opens this file and sends its bytes."

## Research-preview caveats

- The Claude Code mods API (function hooks: `register(on)`, `$`, `classic.PermissionRequest`, `$.prompt.submit`, `$.session.append`) is early access and may change between Claude Code releases. Verified on 2.1.296 (first built on 2.1.287). If the bridge goes silent after a Claude Code update, run `./scripts/check-mod.sh` first, then the spike checks in `design.md`. There is no MCP fallback.
