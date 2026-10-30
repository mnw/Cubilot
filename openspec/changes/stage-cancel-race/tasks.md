## 1. Hub

- [x] 1.1 `hub/core/launch-queue.ts`: `onLateAck` option; a late ack after the time-out is accepted when the stage logic takes it, else 409 → verify: `tests/unit/launch-queue.test.ts` unchanged, `tests/integration/launch-ack-timeout.test.ts` unchanged
- [x] 1.2 `hub/kinds/stage.ts`: a time-out of a cancelled stage sets `timedOut` on its hold and queues no close; `onCloseEnd` releases nothing while `timedOut`; `onLateAck` queues the last close → verify: `tests/integration/launch-late-ack.test.ts`

## 2. Shell

- [x] 2.1 `src-tauri/src/launches.rs`: `begin_launch` and `end_launch`; a close for a name with a launch in progress waits, a close for another name runs → verify: `cargo test launches` (two new tests)

## 3. Spec

- [x] 3.1 `docs/PROTOCOL.md`: "Cancelled stages" items 2 and 6
- [x] 3.2 `npx @fission-ai/openspec@1.14.3 validate stage-cancel-race --strict` → exit 0

## 4. Not checked

- A real `pty_spawn` race on a live machine. The Rust tests use a fake kill function.
