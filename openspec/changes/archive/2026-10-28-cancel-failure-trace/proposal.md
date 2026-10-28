## Why

Human msgs 1830 and 1858. The `catch` of `cancelStage` and the `catch` of `sweep` in `hub/kinds/stage.ts` only write a log line. A failed cancel leaves the stage in its old status, and the human sees nothing. The stage-diagnosis change needs a visible cancel failure (group 8).

## What Changes

- **Kind:** new persistent Kind `cancel_trace` in `hub/kinds/cancel-trace.ts`, with a `LedgerEntity`. The table `cancel_traces` comes from the Kind declaration through the Store migrate. No core DDL.
- **Key:** `id = "ct_" + first 16 hex of sha256(stage_id \n site \n status_at_failure)`. The same failure again writes nothing. A cleared row never reopens.
- **Write:** the two `catch` blocks call the Kind through one hook (`traceFailure`). The stage does not change. The error is redacted (`redactPrivateText`) and cut to 500 characters.
- **Routes:** `GET /rooms/<room>/cancel-traces` and `POST /rooms/<room>/cancel-traces/<id>/clear` (human only).
- **UI:** one line per open row in the Needs-you region, with a Clear button.
- **Events:** `cancel_trace.created` and `cancel_trace.cleared`, scope `ui-only`.

## Capabilities

### New Capabilities

- `cancel-trace`: the Kind, its key, its routes, its events, its log lines.

## Impact

- Security: bearer token on both routes. Clear is human only. The error is redacted and capped. Events are `ui-only`.
- Data: one table. Rows only on a `catch`.
- Migration: none beyond the Store `CREATE TABLE IF NOT EXISTS` (`tests/unit/cancel-trace-migrate.test.ts`).
- Compatibility: old clients ignore the new events.
- Performance: a write only on a `catch`.
- Accessibility: Clear is a button with a label. Focus moves to the next line, else the region. A human VoiceOver check is open.
