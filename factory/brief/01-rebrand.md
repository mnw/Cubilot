# Part 1: rebrand from A2AChannel to Cubilot

## Name decision

The new name is **Cubilot** (decided 2026-10-21). A cubilot is the cupola furnace of a foundry.

The tagline is **"Cubilot: The Continuous Software Foundry"**. Where space is small (the About box, the GitHub description), use "Continuous Software Foundry". Do not use "Cubilot Foundry" as a product name: other products use the word "Foundry".

- The repo stays under the personal account `mnw`. The human can move it to a company organisation later. GitHub keeps the history and redirects the old URL.
- The ticket board can have its own name, **Slate**, as a feature name. The product name stays Cubilot.
- Before the first public use, the human does these checks:
  1. Register the domains (`cubilot.ai`, `cubilot.com`) and the GitHub name `cubilot`.
  2. Get a trademark check. "Cubilot" sounds like "Copilot", and both names are in the market of AI tools for code.

## Side by side with A2AChannel (decision 2026-10-21)

The rebrand is the first part, before all other parts. Work continues in A2AChannel. Cubilot must not change the state of A2AChannel. The two apps run side by side on one Mac, until the human retires A2AChannel.

Rules:
1. Cubilot has its own bundle identifier, data folder, logs folder, tmux socket, hub discovery files and shell marker. Cubilot does not read, move or link the A2AChannel folders.
2. Do not launch the copy in the new repo (app, hub or bridge) before this part is complete. Before the rebrand, the copy uses the A2AChannel names and folders.
3. At first, the Cubilot ledger is empty. An import of the A2AChannel data is a separate step, at the retirement of A2AChannel (see "Retire A2AChannel" below).

## Names

| Use | Current | Proposal |
|---|---|---|
| Product name, window title | `A2AChannel` | `Cubilot` |
| Slug (repo, cask, npm) | `a2achannel` | `cubilot` |
| Rust crates | `a2achannel`, `a2achannel_lib` | `cubilot`, `cubilot_lib` |
| Bundle identifier | `com.mnw.a2achannel` | `com.mnw.cubilot` (see item 3.2) |
| Data folder | `~/Library/Application Support/A2AChannel` | `~/Library/Application Support/Cubilot`, a new folder (see item 3.1) |
| Shell marker | `A2ACHANNEL_SHELL` | `CUBILOT_SHELL` (see item 3.4) |

## What to rename, by risk

The name occurs in about 40 files outside `factory/`. Most are documents. The groups below go from high to low risk.

### 1. Agent-visible protocol strings. Change both sides in one commit.

| Where | What |
|---|---|
| `hub/channel/core.ts:96` | Briefing prefix `[A2AChannel briefing]` |
| `hub/channel/core.ts:145` | Nutshell prefix `[A2AChannel nutshell update]` |
| `hub/channel/pi-extension.ts:87-89` | `startsWith` checks on the two prefixes above |
| `hub/channel/instructions.json:7` | Identity line: "a shared A2AChannel coordination room" |
| `hub/channel/claude-mod/.claude-plugin/plugin.json` | `description` and `author.name`. Keep `"name": "chatbridge"`, because the tool names `mcp__chatbridge__*` come from it. |

The pi extension matches the prefixes by text. If only one side changes, pi agents show the Briefing as a normal message. After the change, rebuild `src-tauri/resources/chatbridge-mod.js` and `src-tauri/resources/pi-extension.js`. These are build outputs and contain the old strings.

### 2. User-visible text. Low risk.

- `src-tauri/tauri.conf.json:3,13`: `productName` and window `title`
- `ui/index.html:6,226`, `ui/styles/header.css:37`: title and product mark
- `ui/features/composer.js:212`, `ui/terminal.js:492`, `hub/channel/core.ts:230`: messages that name the app
- `src-tauri/src/lib.rs:567,1078`: config file header and an error message
- `README.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/PROTOCOL.md`, the living specs in `openspec/specs/`, and the open changes in `openspec/changes/`
- Do not edit `openspec/changes/archive/`. It is the history.

### 3. Storage paths and identifiers. New values, no migration.

**3.1 Data folder.** `app_data_dir()` (`src-tauri/src/lib.rs:242`), `DISCOVERY_DIR` (`hub/channel/hub-client.ts:9`) and the transcripts path (`hub/core/transcript.ts:42`) all use `A2AChannel`. The folder holds the ledger database, transcripts, `config.yml`, `hub.url`, `hub.token`, `tmux.sock`, the staged chatbridge mod and the MCP configs.

- Change all three to `Cubilot`. Use one source for the path: the hub and the bridge read it from an environment variable (for example `CUBILOT_DATA_DIR`). Part 12 needs this too.
- On the first launch, Cubilot creates an empty folder. It does not move the A2AChannel folder and does not make a symlink.
- Because `hub.url`, `hub.token` and `tmux.sock` are in the data folder, each app has its own hub and its own tmux server. A bridge finds only the hub of its own app.

**3.2 Bundle identifier.** Change `com.mnw.a2achannel` (`tauri.conf.json:5`) to `com.mnw.cubilot`. The identifier also names the WebKit storage (`src-tauri/src/lib.rs:1354`). macOS then treats Cubilot as a different app:
- Cubilot gets its own `localStorage`. The A2AChannel values stay with A2AChannel.
- macOS asks for the permissions again, for Cubilot only.

**3.3 Logs folder.** `~/Library/Logs/A2AChannel` (`src-tauri/src/lib.rs:666-667`). Change it to `~/Library/Logs/Cubilot`.

**3.4 Shell marker.** `pty.rs:1132-1139` sets `A2ACHANNEL_SHELL=1`, and your `.zshrc` reads it for theming. Cubilot sets `CUBILOT_SHELL=1` only. Update `.zshrc` to read both variables while the two apps run.

**3.5 `localStorage` keys** (`a2achannel_*` in `ui/`). Cubilot has new storage (item 3.2), so there is no value to keep. Change the keys to `cubilot_*`.

**3.6 Crate and package names.** `src-tauri/Cargo.toml:2,7`, `src-tauri/src/main.rs:5`, `package.json:2`. Rename them in the same commit, because `main.rs` calls the library crate by name.

**3.7 Tests.** `src-tauri/src/pty.rs:1872-1912` contain the old data folder path in expected strings. Update them with item 3.1.

**3.8 Shared places outside the data folder.** Find each place where the app writes outside its data folder. Examples: `~/.claude.json`, `~/.claude/settings.json`, `~/.pi/agent/`, `~/.zshrc`, launch agents, a fixed hub port. For each place, make sure that Cubilot does not change or replace an A2AChannel value. The MCP server name `chatbridge` is the most likely conflict. If a global config holds it, Cubilot uses its own entry.

### 4. Distribution

- **GitHub repo:** the new repo `mnw/Cubilot` (see `../MIGRATION-BRIEF.md`). Do not rename `mnw/A2AChannel`. Work continues there.
- **Homebrew:** add a new cask `Casks/cubilot.rb` next to `Casks/a2achannel.rb`. See `scripts/bootstrap-tap.sh`, `scripts/release.sh` and `scripts/install.sh`. Do not add `cask_renames.json` now: it replaces the A2AChannel install.
- The `.app` name changes with `productName`. `scripts/install.sh` and `scripts/release.sh` use the old `.app` path.

## Order of work

1. Do this part first, directly after the migration, before all other parts. The other parts use the new names and the new data folder.
2. Do group 1 and the rebuild of `src-tauri/resources/` in one commit.
3. Do group 3 in one commit.
4. Then do the first launch of Cubilot. Check that A2AChannel still runs, and that its data folder did not change.
5. Do group 4 when the release is ready.

## Retire A2AChannel (later)

When the work in A2AChannel is complete, the human decides:
1. Import the A2AChannel ledger and transcripts into Cubilot (a copy, not a move), or keep the empty ledger.
2. Add `cask_renames.json` (`{"a2achannel": "cubilot"}`) to the tap. Check the current Homebrew docs for this file first.
3. Remove `A2ACHANNEL_SHELL` from `.zshrc`.
4. Archive `mnw/A2AChannel` on GitHub.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
