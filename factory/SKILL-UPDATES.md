# Skill updates: copy to the local skill folders

Status: to do. Written 2026-10-18.

On 2026-10-18 two skills in `factory/` were updated to the current upstream version. The copies on this Mac (Claude Code and Pi) and in the Claude account still have the old versions.

| Skill | Old version | New version in `factory/` | Source |
|---|---|---|---|
| `humanizer` | v2.1.1 (January 2026) | v3.1.0, commit `8c307f3` | https://github.com/blader/humanizer (MIT, Siqi Chen) |
| `asd-ste100` | SKILL.md `3419838`, linter `32511c6` | commit `3944283` | https://github.com/danyuchn/asd-ste100-skill (MIT, Dustin Yuchen Teng) |

`show-me` and `clean-user-facing-text` have no update. Do not copy them.

## Procedure

1. Copy the full folders, not only `SKILL.md`. The `asd-ste100` folder contains the linter `scripts/ste-lint.py`. The `humanizer` folder contains the license.
2. Claude Code:
   ```bash
   cd ~/Workspace/A2A-app/factory
   rsync -a --exclude .DS_Store editor/skills/humanizer  ~/.claude/skills/
   rsync -a --exclude .DS_Store editor/skills/asd-ste100 ~/.claude/skills/
   ```
3. Pi: do step 2 again with the target `~/.pi/agent/skills/`.
4. Restart the open Claude Code and Pi sessions. Sessions that run now keep the old version.
5. Claude account (claude.ai): `rsync` does not change these skills. Ask Claude to propose the two updated skills on a review card, then save the card. A card holds only `SKILL.md`. The new linter script stays in `factory/`.
6. Do a check: run `python3 ~/.claude/skills/asd-ste100/scripts/ste-lint.py --selftest`. The result must be `selftest OK`.

## After the migration

The new repo gets `factory/` with these versions. Use the new repo path in step 2 when the migration is done.
