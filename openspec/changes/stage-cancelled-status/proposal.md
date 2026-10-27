## Why

Gap G4: stage `s_7d385f43a7fd0391` of a cancelled ticket retried without end. A ticket cancel did not end its stages, so a stage of a cancelled ticket could still launch, retry and report a final failure. The hub has no terminal status for "ended because the work was cancelled".

## What Changes

- **Status:** a new terminal stage status `cancelled`. No retry, no final-failure handoff, no Needs-you line, no FAIL count, no failure record, no diagnosis input.
- **Reason:** the snapshot gets `reason: string | null`, read from the payload of the last `stage.cancelled` event. No column. `GET /stages`, `GET /stages/<id>` and the SSE stage entry carry it. The UI shows `cancelled` and the reason as text.
- **Ticket cancel:** after `ticket.cancelled` commits, each queued, launching, running or retrying stage of the ticket moves to `cancelled`, reason `ticket cancelled`, actor `system`, in its own transaction through the stage API. A live stage gets one close first.
- **Release rule:** name, slot and worktree stay reserved until a close ack arrives with no launch of that stage in flight. A late launch end gets one more close and only its ack releases. A launch the shell never received is dropped and released at once.
- **Worktree:** a `ticket/<id>` worktree stays. A temporary worktree goes at the releasing ack.
- **Hub start:** the open stages of a cancelled ticket are cancelled before the `launching` sweep.

## Capabilities

### Modified Capabilities

- `stage-sessions`: the `cancelled` status, the reason, the ticket-cancel rule, the release rule and the start rule.

## Impact

- Risk: state machine, launch path, UI.
- Security: no new route. The reason is hub text.
- Performance: one event read per snapshot of a cancelled stage.
- Compatibility: old clients ignore `reason`. A UI that does not know `cancelled` shows the raw status.
- Migration: none. The `status` column has no CHECK.
- Accessibility: the status and the reason are text.
- Follow-up limits (out of scope): `t_b073b26136e9cf61` (launch time-out race) and `t_81bfa8a84ecc06e5` (shell restart). A launch ack lost in a shell restart holds the reservation until the hub restarts. The human closes an orphan pane.
