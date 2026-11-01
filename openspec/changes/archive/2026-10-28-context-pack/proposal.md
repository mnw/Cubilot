## Why

A new stage session starts with no context. Today its first message holds only the ticket facts, so each session explores the codebase again, and the cost repeats for each stage. Nothing tells the next stage what the last stage learned, and nobody measures what a session costs before its first useful action.

Brief: `factory/brief/04-sessions.md`, section "Context pack" items 1 to 7 and section "Costs and limits".
Depends on: `openspec/changes/stage-sessions` (first message, launch) and `openspec/changes/spec-review-stage` (spec first message). Part 7 (`factory/brief/07-toolchain.md`) bundles graphify, rg and Serena. Until Part 7 ships, the hub uses a tool when it is on PATH and marks the graph status `missing` when it is not.

## What Changes

- **Order of the first message:** stable text first, ticket part last. Two sessions of one role have the same stable part, byte for byte.
- **Project primer:** `docs/PRIMER.md` (at most 2,000 tokens) plus the Nutshell, placed after the role text and before the ticket part. The hub does not read `CONTEXT.md`. A Writer ticket (interim: Worker, Validator review; see design.md) writes `docs/PRIMER.md`. When the file is missing, the first message says "primer missing".
- **Context pack:** the hub builds it before the launch, with no model. It holds a graphify query result (1,500-token budget), Serena symbol signatures of the files that the ticket and the spec name, and, for the Validator and the Testers, the diff stat and the changed files. When Serena has no CLI the hub can call, a real signature tool (universal-ctags) fills the section, labelled "signatures (ctags)". The depth for each role follows the table in brief item 5.
- **Notes:** result handoffs carry a required `notes` field (about 300 words at most). The next stage of the ticket gets all earlier notes in its first message.
- **Measurement:** for each session the hub records the first-message tokens, the cache read tokens, and the tokens before the first file change or the first verdict. The numbers are stored for Part 11 and for model routing (Part 6, item 6).
- **Role prompts:** the six role prompts and the Orchestrator prompt tell the agent to use `graphify query`, `rg` and Serena before it opens a full file. The result section of each of the six role prompts tells the agent to include `context.notes` (target 300 words, limit 400). It ships in the same release as the notes check.
- **BREAKING (hub-launched sessions only):** a result handoff without `notes` fails the schema check. Handoffs that name an agent are not affected.

## Capabilities

### New Capabilities

- `context-pack`: the order of the first message, the project primer, the context pack content and the depth for each role.
- `stage-notes`: the `notes` field on result handoffs and its delivery to later stages of the ticket.
- `session-metrics`: the per-session token measurement and its storage.

### Modified Capabilities

None. `stage-sessions` and `spec-review-stage` are in-flight changes, not archived specs. This change adds new requirements next to them and does not rewrite theirs.

## Not in this change

- The dashboard that shows the numbers (Part 11).
- Model routing from the numbers (Part 6, item 6).
- The option to keep a Worker session open after a FAIL (brief "Costs and limits", item 3). The measurement here decides whether it is needed.
- Bundling graphify, rg and Serena (Part 7).
- Windows, Linux and Intel support. macOS ARM64 only.

## Impact

- `hub/core/first-message.ts`, `factory/<role>/first-message.md`: section order, primer, pack, notes sections.
- `docs/PRIMER.md` (new, written by the Writer (interim: Worker, Validator review; see design.md)).
- `hub/core/context-pack.ts` (new): runs graphify in the room's project folder (the graph describes the room base) and the other tools in the stage worktree.
- `hub/kinds/stage.ts` (`checkResult`), `hub/kinds/handoff.ts`: `notes` check. Notes read for the next stage.
- `hub/core/migrate`: new `stage_metrics` table. Snapshot first.
- `factory/*/*.md` role prompts: tool order text.
- `docs/PROTOCOL.md`, `CLAUDE.md`: the `notes` field and the metrics. `CLAUDE.md` "Verified against" line: the Claude Code version checked for the usage fields.
- Hub-launched Claude and pi sessions: where the usage numbers come from is untested (see design).
