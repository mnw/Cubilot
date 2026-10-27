# Rules: transcripts

Chat transcript persistence, hydration, redaction and their accepted risks.

## Roster never persists; chat transcript persists only when explicitly opted in per room

- **Roster never persists; chat transcript persists only when explicitly opted in per room** via `room_settings.persist_transcript`. Active file `<hash8>-<sanitized>.jsonl` rotates to `<hash8>-<sanitized>.<6-digit-seq>.jsonl` at 10,000 lines — rotated chunks are preserved indefinitely; only `POST /rooms/<room>/clear-transcript` deletes transcript data. SQLite (`ledger.db`) owns kinds; JSONL owns chat — they never overlap. JSONL line format is per-line versioned (`{"v": 1, ...}`); readers tolerate higher versions and partial final lines.

## Lazy per-Room transcript hydration on first agent reconnect

- **Lazy per-Room transcript hydration on first agent reconnect.** When `persist_transcript` is true and an agent reconnects to a Room whose hydration hasn't happened yet in the current Hub process, `RoomHydrator.maybeHydrate(room)` reads up to `chat_history_limit` lines from the active JSONL chunk and replays them through `broadcastUI` (entries flagged `replay: true`). Idempotent per-Room per-process — concurrent same-Room reconnects share one cached promise. **The trigger is connection, not startup**: if the user kills all agents in a Room then restarts the Hub, no agent reconnects → no hydration → Room stays empty (matches v0.10.2's "agents gone = empty room" directive). If only the Hub bounces and tmux sessions survive, agents reconnect → chat repopulates. See `docs/adr/0001-lazy-room-hydration.md`.

## `<private>...</private>` in chat text is stripped at persistence time, never at delivery

- **`<private>...</private>` in chat text is stripped at persistence time, never at delivery.** Live agents and the Webview see private content during the session via the in-memory chatLog + SSE delivery. Only on-disk persistence sinks (the transcript JSONL today; semantic summaries when Phase 3 lands) call `redactPrivate(entry)` from `hub/core/redaction.ts`. Tags are case-sensitive exact-string `<private>` / `</private>`; unclosed tags are left literal; nested tags are stripped greedy to the first close.

## Persisted transcripts may capture secrets

- **Persisted transcripts may capture secrets.** A user opting `persist_transcript = true` for a room accepts that anything pasted into chat (tokens, API keys, debug dumps) ends up on disk in plain UTF-8 under `transcripts/<basename>.jsonl`. Mode 0600 file + 0700 dir is the only protection in this version — no encryption, no auto-redaction. Default off keeps the boundary at the user's explicit opt-in.

## Rotated transcript chunks accumulate without auto-delete

- **Rotated transcript chunks accumulate without auto-delete.** A busy opted-in room over months reaches hundreds of MB across many 5 MB chunks. Footprint is surfaced in the room-persistence UI; `POST /rooms/<room>/clear-transcript` removes everything atomically. Users wanting capped history can `mv` chunks out of the data dir periodically.
