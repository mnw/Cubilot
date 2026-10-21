# Part 1: rebrand to Cubilot

Status: done on 2026-10-21 (commits `64f553a` to `781a7dc`). The source of the code is in `../../MIGRATION.md`.

## Name decision

The new name is **Cubilot** (decided 2026-10-21). A cubilot is the cupola furnace of a foundry.

The tagline is **"Cubilot: The Continuous Software Foundry"**. Where space is small (the About box, the GitHub description), use "Continuous Software Foundry". Do not use "Cubilot Foundry" as a product name: other products use the word "Foundry".

- The repo stays under the personal account `mnw`. The human can move it to a company organisation later. GitHub keeps the history and redirects the old URL.
- The ticket board can have its own name, **Slate**, as a feature name. The product name stays Cubilot.
- Before the first public use, the human does these checks:
  1. Register the domains (`cubilot.ai`, `cubilot.com`) and the GitHub name `cubilot`.
  2. Get a trademark check. "Cubilot" sounds like "Copilot", and both names are in the market of AI tools for code.

## Names in use

| Use | Value |
|---|---|
| Product name, window title | `Cubilot` |
| Slug: repo, package, cask | `cubilot` (GitHub `mnw/Cubilot`) |
| Rust crates | `cubilot`, `cubilot_lib` |
| Bundle identifier | `com.mnw.cubilot` |
| Data folder | `~/Library/Application Support/Cubilot`. One source: `CUBILOT_DATA_DIR`. |
| Logs folder | `~/Library/Logs/Cubilot` |
| Environment variables | `CUBILOT_*` (for example `CUBILOT_TOKEN`, `CUBILOT_LEDGER_DB`, `CUBILOT_MODE`) |
| Shell marker | `CUBILOT_SHELL` |
| Sidecar binary | `cubilot-bin-*` |
| `localStorage` keys, UI events | `cubilot_*`, `cubilot:` |
| Agent message prefixes | `[Cubilot briefing]`, `[Cubilot nutshell update]` |
| Default attachments folder, captures | `~/cubilot-attachments`, `/tmp/cubilot/` |
| Homebrew | tap `mnw/homebrew-cubilot`, cask `cubilot` |

The plugin name `chatbridge`, the tools `mcp__chatbridge__*` and the variables `CHATBRIDGE_*` are protocol names. They stay.

Rule: the old product name does not occur in the repo. The exceptions are `MIGRATION.md` (the record of the source), the git history, and third-party texts in `seo/suite/` that name the Agent2Agent protocol by its short name.

## Side by side with the previous app

Cubilot runs beside the previous app on one Mac. Cubilot has its own identifier, folders, tmux socket, hub and shell marker. The hub picks a free port, so two hubs do not collide. Cubilot does not read, move or link the folders of the previous app. At first, the Cubilot ledger is empty.

## Open items

1. `~/.zshrc`: read `CUBILOT_SHELL` for the terminal theme. The human does this.
2. The Homebrew tap repo `mnw/homebrew-cubilot` does not exist yet. Create it with `scripts/bootstrap-tap.sh` before the first release. Until then, the `brew` commands in `docs/GUIDE.md` do not work.
3. `src-tauri/src/lib.rs` still accepts the old config key `images_dir` for the attachments folder. No Cubilot install has this key. Remove it.
4. `openspec/specs/images-storage/spec.md` describes `CUBILOT_IMAGES_DIR`, which does not exist. Update the spec to the current attachments setting.
5. First build and launch: `bun test`, `scripts/build-sidecars.sh`, `bun run tauri:build`, then launch. Check that the previous app still runs and that its data folder did not change.

## Retire the previous app (later)

When the work in the previous app is complete, the human decides:
1. Import its ledger and transcripts into Cubilot (a copy, not a move), or keep the empty ledger.
2. Remove its shell marker from `~/.zshrc`.
3. Archive its GitHub repo, with one line in its README that points to `mnw/Cubilot`. `MIGRATION.md` names the repo.
4. Remove its app and its Homebrew cask. Cubilot has its own tap, so `brew upgrade` does not move users to Cubilot.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
