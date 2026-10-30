## Why

Gap G4 follow-up (`t_b073b26136e9cf61`): a cancelled stage whose launch timed out can still start its session late. The hub refused the late `spawned` ack (409) and the first close had already run, so an orphan session stayed and the human closed it by hand. Two shell effects add to it: the shell starts a launch asynchronously, and a close for the same name can run before `pty_spawn` creates the session and report "absent".

## What Changes

- **Hub, time-out of a cancelled stage:** the hub no longer queues a close at the time-out. The reservation (name, slot, worktree) stays, even after a close ack (`absent` included), until the late launch ack arrives.
- **Hub, late ack:** a late `spawned` or `error` ack of a cancelled stage is accepted (200). The hub queues one more close. Only the ack of that close releases. A repeat of the late ack is idempotent and queues no third close. The stage stays `cancelled`: no `running` move, no retry, no final-failure handoff.
- **Hub, stage that is not cancelled:** a late ack of a timed-out attempt still gets 409. The next attempt does not change.
- **Shell close order:** the shell remembers the session names of its launches in progress. A close for such a name waits until that launch ends, then runs. A close for another name runs at once. A close waits for at most one launch of its name. Start-sweep closes follow the same rule.

## Capabilities

### Modified Capabilities

- `stage-sessions`: the late launch end of a cancelled stage, and the shell close order.

## Impact

- Risk: launch and close path, high radius.
- Security: none. Migration: none. UI: none. Routes, launch and close schemas, auth and permissions: no change.
- Performance: one extra map flag per hold; one small lock per close in the shell.
- Compatibility: the shell and the hub ship together in one install.
- Limit: when the late ack never arrives (for example the shell restarts), the reservation stays until the hub restarts.
