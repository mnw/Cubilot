# Part 7: the app provides the code-intelligence toolchain

## Goal

A new laptop must run the factory after three actions: install the app, sign in, and open a factory room. The app must not depend on tools or configuration that the user set up by hand.

Today the toolchain (Graphify, ripgrep, fd, Serena) depends on user-level setup:
- `~/.claude/CLAUDE.md`, `~/.claude/settings.json` and `~/.claude.json`
- `~/.pi/agent/AGENTS.md` and `~/.pi/agent/mcp.json`
- `~/.agents/` (workflow, Serena launcher, hook script)
- `uv tool` installs in `~/.local/` and Homebrew installs in `/opt/homebrew/`

The workflow file also contains absolute paths with the user name (`/Users/mnw/.local/bin/graphify`). These paths fail on a laptop with another user name or without Homebrew.

## Principle

The app owns the toolchain, the configuration and the instructions for every agent that it launches. The app gives them to each agent on the launch command. A terminal session that the user opens by hand keeps the user-level setup. The two do not conflict.

## What the app provides

| Part | How the app provides it |
|---|---|
| tmux | Already bundled (`src-tauri/tauri.conf.json`, `resources/tmux`) |
| ripgrep, fd | Bundle the binaries as resources, like tmux. Both are single static binaries. |
| uv | Bundle the `uv` binary. The app uses it to install the Python tools. |
| Python | `uv` installs a managed Python into the app data folder. No system Python or Homebrew is necessary. |
| Graphify, Serena | `uv tool install` at the versions in `factory/toolchain.lock`, with `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR` and `UV_PYTHON_INSTALL_DIR` set to `<app data>/toolchain/`. |
| Serena launcher | `<app data>/toolchain/bin/serena-mcp`, written by the app, with the same flags as `~/.agents/bin/serena-mcp`. |
| Workflow | `code-intelligence` skill in a shared factory plugin. It loads on demand (Part 2, finding 4). It uses bare tool names, not absolute paths. |
| `asd-ste100` | Ships in the shared plugin. Every agent needs it for chatbridge messages (Part 2, finding 5). |
| Factory roles and skills | Already planned (Part 2, step 1). |

## Toolchain manifest

Add `factory/toolchain.lock`. It pins each tool:

| Tool | Version source today |
|---|---|
| graphifyy | 0.9.91 |
| serena-agent | 2.0.0 |
| ripgrep, fd | rg 15.2.0, fd 10.4.2, with the SHA-256 values in finding 8 |
| uv | the version bundled in the app |

To update a tool, change the manifest and run the smoke test (`~/.agents/tests/code-intelligence.py`, moved into the repo as `tests/toolchain/`). The app compares the installed versions with the manifest when it opens, and installs what is missing or different.

## Launch changes

### Claude agents
1. Prepend `<app data>/toolchain/bin` to `PATH` on the launch command. Agents then find `graphify`, `rg`, `fd` and `serena-mcp` by bare name.
2. Add the Serena entry to the app's MCP config (`write_global_mcp_config`, `src-tauri/src/pty.rs:206`). Point it at `<app data>/toolchain/bin/serena-mcp`.
3. Add `--strict-mcp-config`. The agent then loads only the app's MCP config. A user-level Serena entry on the laptop does not add a second server.
4. Add `--plugin-dir <app data>/factory/shared` for the shared plugin (workflow skill, `asd-ste100`).

### Pi agents
1. Prepend the same `PATH`.
2. Set `PI_CODING_AGENT_DIR=<app data>/pi-agent`. The app writes `mcp.json` (Serena, `deferred` exposure), `settings.json` and the shared skills there. It also writes a `package.json` that lists the Pi extensions the factory uses, and runs `npm install` in that folder (layout from finding 8).
3. Pi keeps `auth.json` in this folder. **Decision (2026-10-16): app agents share the terminal sign-in**, like Claude agents share the Claude Code sign-in. The app does not set `CLAUDE_CONFIG_DIR`, so Claude agents already use the terminal sign-in.
   - The app creates `<app data>/pi-agent/auth.json` as a symlink to `~/.pi/agent/auth.json`.
   - If `~/.pi/agent/auth.json` does not exist, the Doctor tells the user to run `pi` in a terminal and sign in with `/login`. The app does not ask for Pi credentials itself.
   - Check before you build: Pi can save `auth.json` with a temporary file and a rename. A rename replaces the symlink with a normal file, and the two sign-ins then drift apart. Test a `/login` inside an app-launched Pi agent. If the symlink breaks, the app recreates it before each launch and tells the user to sign in from the terminal.
4. The OpenAI key for the Validator and the Reviewer comes from the macOS Keychain. The app reads it and sets `OPENAI_API_KEY` on the launch command, like `resolve_anthropic_api_key` (`src-tauri/src/lib.rs`) does for Anthropic.

### Summariser
Add `--strict-mcp-config` to `claude --print` in `hub/core/summariser/claude.ts`. The summariser does not need Serena.

## What the app cannot bundle

The app checks these when it opens and shows a fix for each one:

| Need | Check | Fix |
|---|---|---|
| Claude Code CLI | `claude --version` meets the minimum (`ensure_claude_version`) | Link to the native installer |
| Pi CLI | `pi --version` | Show the install command |
| git | `git --version` | `xcode-select --install` |
| Claude sign-in | `claude` opens a session | Open a terminal tab with `claude` to sign in |
| OpenAI key | Keychain entry or Pi credential (`pi auth check --provider openai --json`) | Settings field that writes to the Keychain |
| Language servers | Serena runs for the project language | Serena downloads most of them. PHP needs extra setup: test it on a Drupal project. |

## Doctor screen

Add a "Doctor" view. It shows each item in the two tables above with its status: installed version, manifest version, sign-in state. Each failed item has one fix button. Decision 2026-10-19: the Doctor is the Checks tab of the Setup and admin screen (Part 8). The first launch on a new machine opens the setup flow of Part 8.

## Moving to a new laptop

1. Install the app (`brew install --cask`).
2. Open it. The Doctor installs the toolchain and lists the missing sign-ins.
3. Sign in to Claude, and set the OpenAI key.
4. Optional: copy `<app data>` from the old laptop (ledger, transcripts, `config.yml`) to keep the room history. The toolchain folder does not need a copy. The app installs it again.

## Repo work after the toolchain moves into the app

- Write the workflow without absolute paths. Keep `~/.agents/code-intelligence.md` for terminal sessions, or let the Doctor offer "use the app toolchain in the terminal too" that writes the user-level pointers.
- Move the smoke test into the repo and run it in CI against the manifest versions.
- Use per-role Serena limits (Part 2): only the Worker keeps Serena's edit tools.

## How the factory uses the toolchain

### Tool access for each role

| Role | Graphify | rg, fd | Serena |
|---|---|---|---|
| Orchestrator | `query` on the main checkout, to scope tickets and set the blast radius | yes | read only |
| Worker | `update` in its own worktree when it claims a ticket, then `query` | yes | read and edit |
| Tester | none | `rg` to collect evidence | none |
| Validator (Pi) | `path` and `explain` on the diff, to check impact | yes | read only |
| Writer | `query` and `explain` for architecture docs | yes | read only |
| Editor | none | `rg` to check terminology | none |
| Reviewer (Pi) | `explain`, to check claims against the code | yes | read only |

Only the Worker keeps the Serena edit tools. The app enforces the "read only" and "none" cells from the role frontmatter:
- Claude roles: `--disallowed-tools` with the Serena edit tools (`mcp__serena__rename_symbol`, `mcp__serena__replace_symbol_body`, the `mcp__serena__insert_*` tools and every other Serena tool that writes). For "none", disallow all `mcp__serena__*` tools.
- Pi roles: `--exclude-tools 'edit,write,mcp__serena__rename_symbol,mcp__serena__replace_*,mcp__serena__insert_*'`, plus every other Serena tool that writes.
- Get the full list of Serena tools that write from `serena-agent` 2.0.0 when you build. Do not depend on the names in this brief.

### A worktree for each agent run

Serena selects its project from the working folder, and a graph belongs to one branch. The app sets the right working folder:
1. Each Worker has its own worktree (step 5).
2. Each Tester run and each Validator run uses a temporary worktree: `git worktree add` for the branch in the handoff. The app removes it when the handoff is resolved.
3. No agent changes the branch of the main checkout. Step 5 said that Testers and the Validator check out branches in the main project folder. This rule replaces that sentence. Parallel Testers in one folder collide.

### The app prepares the graphs

1. When the app creates a worktree, it runs `graphify extract . --code-only` in the background. This uses no model tokens.
2. The app refreshes the main-checkout graph when a factory room opens and after each merge to main.
3. The app records the commit of each graph build. The roster pill or the room header shows "graph current" or "graph N commits behind".
4. A Worker runs `graphify update .` in its worktree after a rebase or a pull.
5. The rule "one coordinating agent prepares the graph" in the code-intelligence workflow is for sub-agents. The factory has none. Each worktree has its own graph, and the app prepares it.

### Handoff context

The workflow requires the root, the graph location and the graph freshness for each piece of delegated work. In the factory, handoffs carry this:
- `context.worktree`: absolute path of the worktree for the work
- `context.graph`: `{ "path": "<worktree>/graphify-out/graph.json", "built_at_commit": "<sha>" }`

The Briefing also shows each agent its worktree root and graph status.

### Serena project data

`.serena/` is not in git, so each worktree has its own Serena memories. Keep decisions that all agents need in tracked files (`CONTEXT.md`, `docs/adr/`), not in Serena memories. Add `graphify-out/` and `.serena/` to a global git excludes file (`core.excludesFile`), so neither one gets into a commit. The Doctor can offer this as a fix.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
