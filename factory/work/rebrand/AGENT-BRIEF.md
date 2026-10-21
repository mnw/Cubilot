# Agent brief: rebrand A2AChannel to Cubilot

Date: 2026-10-21. Repo: `~/Workspace/cubilot` (GitHub `mnw/Cubilot`, branch `main`).
Design and reasons: `factory/brief/01-rebrand.md`. Read it first. This file tells you how to do the work.

## Goal

The copy in this repo becomes the app **Cubilot**. Cubilot runs side by side with the installed A2AChannel app. Cubilot has its own identity and its own folders. Work continues in A2AChannel, so A2AChannel must not change.

## Rules

1. Do not launch the app, the hub (`bun run dev`, `hub/main.ts`) or a bridge. Do not run `bun run tauri:dev` or `tauri:build`. The human does the first launch.
2. Do not read, write, move or delete these paths: `~/Library/Application Support/A2AChannel`, `~/Library/Logs/A2AChannel`, `~/Library/Caches/com.mnw.a2achannel`, the A2AChannel tmux socket, and `~/Workspace/A2A-app`.
3. Do not change files outside this repo. If the work needs a change outside the repo (for example `~/.zshrc`), write the change in your final report. The human does it.
4. Do not push. Do not force anything in git. Commit only on `main`, one commit for each step below.
5. You can run `bun install`, `bun test` and `scripts/build-sidecars.sh`. The tests use a temporary tmux socket in `/tmp`.
6. Do not edit history: `openspec/changes/archive/`, `docs/adr/` and `MIGRATION.md` keep the old name.
7. Use Simplified Technical English in comments and in commit messages: short sentences, one instruction in each sentence.

## Names

| Use | Old | New |
|---|---|---|
| Product name, window title, text | `A2AChannel` | `Cubilot` |
| Slug: package, cask | `a2achannel` | `cubilot` |
| Rust crates | `a2achannel`, `a2achannel_lib` | `cubilot`, `cubilot_lib` |
| Bundle identifier | `com.mnw.a2achannel` | `com.mnw.cubilot` |
| Data folder | `~/Library/Application Support/A2AChannel` | `~/Library/Application Support/Cubilot` |
| Logs folder | `~/Library/Logs/A2AChannel` | `~/Library/Logs/Cubilot` |
| Shell marker | `A2ACHANNEL_SHELL` | `CUBILOT_SHELL` |
| `localStorage` keys | `a2achannel_*` | `cubilot_*` |
| Briefing prefix | `[A2AChannel briefing]` | `[Cubilot briefing]` |
| Nutshell prefix | `[A2AChannel nutshell update]` | `[Cubilot nutshell update]` |

Keep these names. They are protocol or internal names, and the brief does not change them:
- the plugin name `chatbridge`, the tools `mcp__chatbridge__*`, and the variables `CHATBRIDGE_*`,
- the variables `A2A_*` (for example `A2A_LEDGER_DB`, `A2A_TOKEN`, `A2A_MODE`),
- the binary names `a2a-bin-*`.

## Facts from the code (checked 2026-10-21)

- The hub port is not fixed. `pick_free_port()` (`src-tauri/src/lib.rs:928`) picks a free port. Two hubs do not collide.
- The discovery files (`hub.url`, `hub.token`), `tmux.sock`, the staged chatbridge mod and the global MCP config (`mcp-configs/global.json`) are all in the data folder. A new data folder separates them.
- Each spawn passes the chatbridge mod with `--plugin-dir` from the data folder. The app does not register `chatbridge` in a global Claude config.
- The app reads `~/.claude/` (`plugins/installed_plugins.json`, commands, skills, `projects/` for usage) and `~/.pi/agent/`. It does not write there. Check this in step 4.
- `scripts/build-sidecars.sh` builds `src-tauri/resources/chatbridge-mod.js` and `pi-extension.js`. These files are git-ignored. Build them again after step 1.

## Steps

Before step 1: `git status` must be clean, and `bun test` must pass. Record the test count.

### Step 1. Protocol strings (one commit)

Change both sides together. The Pi extension finds the prefixes by text.
- `hub/channel/core.ts`: the briefing prefix (line 96), the nutshell prefix (line 145), the "hub not found" message (line 230).
- `hub/channel/pi-extension.ts:87-89`: the two `startsWith` checks.
- `hub/channel/instructions.json:7`: the identity line.
- `hub/channel/claude-mod/.claude-plugin/plugin.json`: `description` and `author.name`. Keep `"name": "chatbridge"`.
- Run `scripts/build-sidecars.sh`. Then run `grep -c A2AChannel src-tauri/resources/*.js`. The result must be 0 for each file.
- Commit: `refactor(rebrand): rename agent-visible protocol strings to Cubilot`.

### Step 2. Storage paths and identity (one commit)

- Data folder, one source: `app_data_dir()` (`src-tauri/src/lib.rs:242`), `DISCOVERY_DIR` (`hub/channel/hub-client.ts:9`), transcripts (`hub/core/transcript.ts:42`). Add `CUBILOT_DATA_DIR`. The Rust shell sets it for the hub and for each spawn. The hub and the bridge read it, and use `~/Library/Application Support/Cubilot` when it is not set.
- On the first launch, create the new folder empty. Do not copy, move or link the A2AChannel folder.
- Bundle identifier: `src-tauri/tauri.conf.json:5`, and the WebKit cache path (`src-tauri/src/lib.rs:1354`).
- Logs folder: `src-tauri/src/lib.rs:666-667`, also the `/tmp` fallback name.
- Shell marker: `src-tauri/src/pty.rs:1132-1139`. Set `CUBILOT_SHELL=1` only.
- `localStorage` keys: `ui/core/state.js`, `ui/features/usage.js`, `ui/terminal.js`, `ui/main.js`.
- Crates and package: `src-tauri/Cargo.toml`, `src-tauri/src/main.rs:5`, `package.json`. Then run `cargo check` in `src-tauri/` to update `Cargo.lock`.
- Tests: the expected paths in `src-tauri/src/pty.rs:1872-1912`, and the socket name in `tests/helpers/tmux.ts:35`.
- Run `bun test` and `cargo test` in `src-tauri/`. The counts must equal the counts before step 1.
- Commit: `refactor(rebrand): give Cubilot its own identifier, data folder and logs`.

### Step 3. User-visible text (one commit)

- `src-tauri/tauri.conf.json`: `productName` and window `title`. `src-tauri/capabilities/default.json`: `description`.
- `ui/index.html` (title, line 226), `ui/styles/header.css:37`, `ui/styles/tokens.css:2`, `ui/features/composer.js:212`, `ui/terminal.js:492`.
- `src-tauri/src/lib.rs`: the config header (line 567), the MCP template comment (line 1078), the comment at line 1340.
- Comments in `hub/main.ts`, `hub/hub.ts`, `hub/core/summariser/*.ts`, `hub/channel/*.ts`, `src-tauri/src/pty.rs`.
- `scripts/check-mod.sh:8`: the default path.
- Documents: `README.md`, `CONTEXT.md`, `CLAUDE.md`, `docs/PROTOCOL.md`, `docs/README.md`, `docs/architecture/`, the living specs in `openspec/specs/`, and the open changes in `openspec/changes/` (not `archive/`).
- Do not edit the `src-tauri/gen/` files by hand. The build makes them again.
- Commit: `docs(rebrand): rename the product to Cubilot in UI text and documents`.

### Step 4. Check (no commit)

1. Run `grep -rIn -i 'a2achannel' --exclude-dir={node_modules,target,.git,factory,archive,adr} .`. Each remaining line must be one of: the names in "Keep these names", `MIGRATION.md`, or a comment that names the old app on purpose. List each remaining line in your report.
2. Find each write outside the data folder: `grep -rn 'home_dir\|homedir()' src-tauri/src hub`. For each result, write in your report: read or write, and the path.
3. Run `bun test`, `cargo test` and `npx @fission-ai/openspec@1.14.3 validate --all --no-interactive`. The OpenSpec result must be the same as before step 1.

### Stop here

Do not do group 4 of the brief (Homebrew cask, release scripts). Do not build or launch the app.

## Report to the human

Send one message with:
1. The three commit hashes and their subjects.
2. The test counts before and after.
3. The remaining `a2achannel` lines from step 4.1, with the reason for each.
4. The table of home-folder reads and writes from step 4.2.
5. The change for `~/.zshrc`: read `CUBILOT_SHELL` and `A2ACHANNEL_SHELL` while both apps run.
6. Each decision you made that this brief does not cover.
