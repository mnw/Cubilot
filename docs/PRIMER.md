# Cubilot primer

Cubilot is a macOS app. It lets many Claude Code and Pi agents talk to each other and to a human in shared rooms. (CONTEXT.md, docs/rules/core.md)

## Architecture

1. The **Shell** is the Tauri Rust process. It picks the hub port, starts the hub as a sidecar, and stages the Claude mod. (CONTEXT.md, src-tauri/src/lib.rs)
2. The **Hub** is `cubilot-bin`. It runs from `hub/hub.ts` and listens on `127.0.0.1`. It owns the roster, the ledger, the chat log and all SSE fan-out. (CONTEXT.md, docs/rules/core.md)
3. The **Bridge** runs inside each agent session. It is the Claude Code mod or the Pi extension. It is not a separate process. (docs/rules/core.md, docs/rules/bridge.md)
4. The **Webview** is plain HTML, CSS and JS. It has no framework and no bundler. (CONTEXT.md, docs/rules/core.md)
5. The **Ledger** is one SQLite database. Each state change writes one event and one table update in one transaction. (CONTEXT.md, docs/rules/kinds.md)
6. A **Kind** is a state machine in `hub/kinds/<kind>.ts`. The five kinds are Handoff, Interrupt, Permission, Ticket and Stage. (hub/kinds/index.ts)
7. A **Room** is an immutable label for an agent. An agent changes state only in its own room. The human can act in all rooms. (CONTEXT.md, docs/rules/kinds.md)

Data flow: agent, then bridge, then hub `/post`, then chat log, then SSE to the webview and to the other agents. (docs/rules/core.md)

## Where the main parts are

- `hub/hub.ts`, `hub/main.ts`: hub entry points. `CUBILOT_MODE` selects the mode. (docs/rules/core.md)
- `hub/core/`: shared plumbing. `agents.ts` is the agent registry. `sse.ts` has the queues. `dispatcher.ts` rejects the actor `system` in request bodies. `briefing.ts` builds briefings. `worktrees.ts` creates stage worktrees. (docs/rules/core.md, docs/rules/kinds.md, docs/rules/bridge.md)
- `hub/kinds/`: one file for each kind. Do not add kind branches to `hub.ts`. (CLAUDE.md, docs/rules/kinds.md)
- `hub/channel/`: the Bridge. It has the core (`core.ts`), the Claude mod (`claude-mod/`) and the Pi extension (`pi-extension.ts`). (docs/rules/core.md, docs/rules/bridge.md)
- `src-tauri/src/`: Rust shell. `lib.rs` starts the hub. `pty.rs` builds the agent command. The hub runs its own launch queue in `hub/core/launch-executor.ts`. (docs/rules/core.md, docs/rules/terminal.md, docs/rules/kinds.md)
- `ui/index.html`: the webview. It has no framework. (CLAUDE.md, docs/rules/core.md)
- `scripts/`: `install.sh`, `build-sidecars.sh`, `check-mod.sh`, `test.sh`. (CLAUDE.md)
- `tests/`: unit tests in `tests/unit/`, integration tests in `tests/integration/`, helpers in `tests/helpers/`. (CLAUDE.md, docs/rules/terminal.md)
- `docs/rules/`: detail for each rule in CLAUDE.md. Index: `docs/rules/README.md`. (docs/rules/README.md)
- `CONTEXT.md`: domain vocabulary. Use its terms. (CONTEXT.md)

## Conventions

- Only Worker and Writer stage sessions commit. They commit on their own `ticket/<id>` branch. Never commit on main. Never push. (CLAUDE.md, docs/rules/core.md)
- Validator and Reviewer worktrees are read-only. The hub refuses a writable one. (CLAUDE.md, docs/rules/kinds.md)
- Never hardcode the hub port. The shell picks it at run time. (CLAUDE.md)
- Mutating hub routes need a bearer token. The default JSON body limit is 256 KiB. `POST /handoffs` allows 1 MiB. `POST /permissions` allows 16 KiB. (docs/rules/core.md, hub/core/auth.ts)
- Use `agents.ensure` and `agents.remove`. Never change `knownAgents`, `agentQueues`, `agentConnections` or `staleTimers` directly. (CLAUDE.md)
- Broadcast with `cap.sse.emit(entry, scope)`. Never list agent queues in a kind. (CLAUDE.md)
- Only the three cross-kind transactions exist. Add no fourth without a change to `docs/PROTOCOL.md`. (CLAUDE.md)
- After a change to `hub/hub.ts`, run `./scripts/build-sidecars.sh`. After a change to `hub/channel/**`, run it and `./scripts/check-mod.sh`. (CLAUDE.md)
- Rebuild the app only with `./scripts/install.sh`. Never use `pkill` and `cp`. (CLAUDE.md)
- Target is macOS ARM64 only. (CLAUDE.md)
- The chatbridge is a Claude mod, not MCP. Never write a project `.mcp.json`. (CLAUDE.md)

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
