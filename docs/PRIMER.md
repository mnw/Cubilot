# Cubilot primer

Cubilot is a macOS app. It lets many Claude Code and Pi agents talk to each other and to a human in shared rooms. (CONTEXT.md, docs/rules/core.md)

## Architecture

1. The **Shell** is the Tauri Rust process. It picks the hub port, starts the hub as a sidecar, and stages the Claude mod. (CONTEXT.md, src-tauri/src/lib.rs)
2. The **Hub** is `cubilot-bin`. It runs from `hub/hub.ts` and listens on `127.0.0.1`. It owns the roster, the ledger, the chat log and all SSE fan-out. (CONTEXT.md, docs/rules/core.md)
3. The **Bridge** runs inside each agent session. It is the Claude Code mod or the Pi extension. It is not a separate process. (docs/rules/core.md, docs/rules/bridge.md)
4. The **Webview** is plain HTML, CSS and JS. It has no framework and no bundler. (CONTEXT.md, docs/rules/core.md)
5. The **Ledger** is one SQLite database. Each state change writes one event and one table update in one transaction. (CONTEXT.md, docs/rules/kinds.md)
6. A **Kind** is a state machine in `hub/kinds/<kind>.ts`. The three kinds are Handoff, Interrupt and Permission. Ticket and Stage also live there. (CONTEXT.md, hub/kinds/)
7. A **Room** is an immutable label for an agent. An agent changes state only in its own room. The human can act in all rooms. (CONTEXT.md, docs/rules/kinds.md)

Data flow: agent, then bridge, then hub `/post`, then chat log, then SSE to the webview and to the other agents. (docs/rules/core.md)

## Where the main parts are

- `hub/hub.ts`, `hub/main.ts`: hub entry points. `CUBILOT_MODE` selects the mode. (docs/rules/core.md)
- `hub/core/`: registry (`agents.ts`), dispatcher, ledger, SSE, briefing, worktrees.
- `hub/kinds/`: one file for each kind. Do not add kind branches to `hub.ts`. (docs/rules/kinds.md)
- `hub/channel/`: bridge core (`core.ts`), Claude mod (`claude-mod/`), Pi extension (`pi-extension.ts`). (docs/rules/bridge.md)
- `src-tauri/src/`: Rust shell (`lib.rs`, `pty.rs`, `factory.rs`, `launches.rs`).
- `ui/`: webview (`index.html`, `main.js`, `terminal.js`).
- `scripts/`: `install.sh`, `build-sidecars.sh`, `check-mod.sh`, `test.sh`.
- `tests/`: `unit/`, `integration/`, `contract/`, `helpers/`.
- `docs/rules/`: detail for each rule in CLAUDE.md. Index: `docs/rules/README.md`.
- `CONTEXT.md`: domain vocabulary. Use its terms. (CONTEXT.md)

## Conventions

- Stage sessions commit only on `ticket/<id>`. Never commit on main. Never push. (CLAUDE.md)
- Never hardcode the hub port. The shell picks it at run time. (CLAUDE.md)
- Mutating hub routes need a bearer token. JSON bodies have a limit of 256 KiB. (docs/rules/core.md)
- Use `agents.ensure` and `agents.remove`. Never change `knownAgents`, `agentQueues`, `agentConnections` or `staleTimers` directly. (CLAUDE.md)
- Broadcast with `cap.sse.emit(entry, scope)`. Never list agent queues in a kind. (CLAUDE.md)
- Only the three cross-kind transactions exist. Add no fourth without a change to `docs/PROTOCOL.md`. (CLAUDE.md)
- After a change to `hub/hub.ts`, run `./scripts/build-sidecars.sh`. After a change to `hub/channel/**`, run it and `./scripts/check-mod.sh`. (CLAUDE.md)
- Rebuild the app only with `./scripts/install.sh`. Never use `pkill` and `cp`. (CLAUDE.md)
- Target is macOS ARM64 only. (CLAUDE.md)
- Use the words in CONTEXT.md. Avoid its "Avoid" words, for example "bridge" for the Channel sidecar. (CONTEXT.md)

## How to run the tests

Heavy processes run one at a time. The lock is `/tmp/cubilot-heavy.lock`. (CLAUDE.md)

```
./scripts/test.sh [bun test args]                  # full run, takes the lock, time and memory limits
bun test tests/unit/briefing-signature.test.ts     # one file
bun test -t "<name pattern>"                       # by name
cargo test --manifest-path src-tauri/Cargo.toml    # Rust
./scripts/check-mod.sh                             # Claude mod, after hub/channel/** changes
bun x tsc --noEmit                                 # type check
```

- Integration tests start a real hub on port 0 through `tests/helpers/hub.ts`. They do not need the app. (CLAUDE.md)
- `pty-plumbing.test.ts` needs tmux on PATH. (CLAUDE.md)
- There is no linter. (CLAUDE.md)
