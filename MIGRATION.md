# Migration from A2AChannel

Date: 2026-10-21
Source repo: mnw/A2AChannel, branch claude_mods, commit 2133157 chore(factory): add the factory folder; ignore its _to_delete/ and .obsidian link

The new repo starts with one import commit: a copy of the working tree at that commit, including the uncommitted changes listed below. The old repo keeps the full history. Work continues in A2AChannel. Later changes there are carried over by hand.

## Uncommitted changes in the snapshot

```
 M factory/MIGRATION-BRIEF.md
 M factory/README.md
 M factory/a11y/a11y.md
 M factory/brief/00-index.md
 D factory/brief/01-factory-roles.md
 D factory/brief/02-rebrand.md
 M factory/brief/03-ticket-grouping-checkpoints.md
 M factory/brief/04-sessions.md
 M factory/brief/05-delivery-backup.md
 M factory/brief/06-warp-patterns.md
 M factory/brief/07-toolchain.md
 M factory/brief/08-setup-admin.md
 M factory/brief/09-a11y-council.md
 M factory/brief/10-seo-council.md
 M factory/brief/11-dashboard.md
 M factory/brief/12-hub-first-linux.md
 M factory/editor/editor.md
 M factory/orchestrator/orchestrator.md
 M factory/reviewer/reviewer.md
 M factory/seo/seo.md
 M factory/tester/tester.md
 M factory/validator/validator.md
 M factory/work/README.md
 M factory/work/factory-roles/design.md
 M factory/work/factory-roles/proposal.md
 M factory/worker/worker.md
 M factory/writer/writer.md
?? .serena/
?? factory/.fuse_hidden0000001000000001
?? factory/brief/01-rebrand.md
?? factory/brief/02-factory-roles.md
?? review-2026-10-14.md
```

## Left behind

- `.*.bun-build` files (old Bun build output, about 8 GB)
- `src-tauri/target/`, `node_modules/`, `dist/` (build output, rebuilt locally)
- `src-tauri/resources/tmux`, `src-tauri/binaries/a2a-bin-*` (rebuilt by `scripts/build-*.sh`)
- `.serena/`, `factory/_to_delete/`, `.DS_Store` (local state and old files)
- `CLAUDE.md`, `skills-lock.json`, `.claude/` are copied but stay git-ignored, as in A2AChannel
