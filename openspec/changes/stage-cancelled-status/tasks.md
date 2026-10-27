## 1. Hub

- [x] 1.1 `hub/kinds/stage.ts`: `StageStatus` `cancelled`, `MOVES`, `TERMINAL`, `terminalStatuses`, `STAGE_STATUSES` → verify: `bun x tsc --noEmit`; `tests/integration/stage-cancelled.test.ts` (a)
- [x] 1.2 `StageSnapshot.reason`, read from the last `stage.cancelled` event (`withReason`); `GET /stages`, `GET /stages/<id>`, `api.load`, `api.listByStatus`, `api.move` and the SSE entry carry it → verify: tests (a), (c)
- [x] 1.3 `StageHooks.onTicketCancelled`, called by the ticket transition route after the commit; `cancelStage` through the stage API → verify: tests (a), (b), (c), (c2)
- [x] 1.4 Release rule (ruling 1479: a launch error after close 1 acked `absent` gets a second close, release only at its ack; test (b2, ruling 1479)): `inflight`, `cancelHolds`, `LaunchQueue.drop`, `onCloseEnd(session, cap, id)`, `onLaunchEnd` for a cancelled stage → verify: tests (b), (b1), (b2), (b3)
- [x] 1.5 Worktree: a temporary one goes at the releasing ack, a ticket branch stays → verify: test (g)
- [x] 1.6 Hub start: `start` cancels the open stages of a cancelled ticket before the `launching` sweep → verify: test (f)
- [x] 1.7 `completedStage` refuses a result for a cancelled stage; the spent-handoff rule treats `cancelled` as ended → verify: `bun x tsc --noEmit`

## 2. UI

- [x] 2.1 `ui/kinds/stage.js` (finished sessions): lists cancelled stages, reads `/stages?status=cancelled`, shows `cancelled: <reason>` as text → verify: `tests/unit/finished-sessions.test.ts`
- [x] 2.0 Ruling (Orchestrator, note YJT4tT2hUPqGnH_8, 2026-10-27): the finished-sessions list is the only UI surface that shows stage status. `ui/kinds/ticket.js` has no stage match, the agent column shows tab states, `ui/index.html` shows stage data only in terminal-finished-list. Criterion 2 and test 9(h) apply to that list only; no new stage surface is added.
- [ ] 2.2 Browser check of the finished list and the cancelled row before the install (Orchestrator)

## 3. Status audit (item 3)

`rg -n "queued|launching|running|retrying|passed|failed|cancelled" hub ui` was run (command of the criteria note, msgs 1476 and 1479). Every match, one line each with a test or a reason, is in `audit.md`. Summary of the groups outside `hub/kinds/stage.ts`:

| Place | Use | Result |
|---|---|---|
| `hub/kinds/handoff.ts` 545 (calls `completedStage`) | refusal for a result of a completed stage | `cancelled` added to `completedStage` in `stage.ts`; `tsc` passes; the passed case is covered by `completed-stage-result.test.ts`; the cancelled refusal is covered by test (i) |
| `hub/kinds/ticket.ts` 1478 `liveStageOf` | newest stage of a session, any status | no change: a cancelled stage keeps its session until the close, like a passed one |
| `hub/kinds/ticket.ts` ticket statuses (`queued`, `claimed`, ...) | ticket status, not stage status | not a stage status |
| `hub/kinds/index.ts` `onFinalFailure` | `failed` only | no change: a cancelled stage never reaches it (test (d) checks no handoff) |
| `ui/kinds/stage.js` `isClosed`, `outcomeOf`, `load` | finished list | changed: `cancelled` with reason; `finished-sessions.test.ts` |
| `ui/kinds/ticket.js` 1635 `STATUS_PILL`, 26, 56; `ui/index.html:204`; `ui/styles/kinds.css:102,118,770` | ticket and handoff `cancelled` (pill, filter, style) | not a stage status |
| `hub/kinds/ticket.ts` `cancelled` matches (2, 31, 45, 46, 70, 362, 620-688, 1346, 1456-1535) | ticket status; 1348 is the new `onTicketCancelled` call | not a stage status, except 1348 (tests (a)-(c2)) |
| `hub/channel/tools.ts` 63-64, 289, 444-580 | ticket tools text and `cancelled` ticket check | not a stage status |
| `hub/features/streams.ts:93` | a comment about a timer | not a stage status |
| `ui/kinds/handoff.js`, `interrupt.js`, `permission.js` | other kinds | not a stage status |
| `ui/terminal.js` `launching` | terminal tab state | not a stage status |
| `ui/features/plan-approval.js` | spec FAIL and `passed` verdict text | no change: `specFailState` reads `verdict`, a cancelled stage has none |
| `hub/channel/*`, `hub/features/*`, `hub/core/*` matches | HTTP status codes, `failed` in error text, `retrying` in a log line | not a stage status |

Every use inside `hub/kinds/stage.ts` was read: the new status is added where a status list decides live, ended or terminal (`MOVES`, `TERMINAL`, `terminalStatuses`, `STAGE_STATUSES`, the spent-handoff rule, `completedStage`, the worktree-at-close rule). It is left out where only live work counts (`evaluateStages` live query, `nextSessionName`, `startWaiting`, `enqueueLaunch`, `sweep`): a cancelled stage is not live.

The UI has no stage chip on a ticket card and no stage column in the agent list. The finished-sessions list is the only stage surface; "agent column" and "card chips" have nothing to change.

## 4. Docs

- [x] 4.1 `docs/PROTOCOL.md`: lifecycle, snapshot `reason`, "Cancelled stages"
- [x] 4.2 This change: proposal, delta spec → verify: `npx @fission-ai/openspec@1.14.3 validate stage-cancelled-status --strict`

## 5. Checks

- [ ] 5.1 `./scripts/test.sh`, `bun x tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `./scripts/check-mod.sh` pass; `./scripts/build-sidecars.sh` exit 0
