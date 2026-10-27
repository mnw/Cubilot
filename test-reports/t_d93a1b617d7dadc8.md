# t_d93a1b617d7dadc8 report (worker, stage s_11c2408ef853b6a8)

Only this report changed. No production code, no test, no openspec/ file.

## Record for tasks.md 4.2

4.2 verified by existing tests and code reading. No gap needed a new test. Commit base: staging (branch ticket/t_d93a1b617d7dadc8).

| 4.2 verify point | Cover |
|---|---|
| A close names one session only | `src-tauri/src/pty.rs:3873` `pty::existing_session_tests::close_kills_only_the_named_session`. Isolated tmux socket. It kills worker-1 and keeps worker-10 (prefix trap) and tester-1. Also `close_of_a_missing_session_is_absent_and_a_repeat_is_accepted`, `close_reports_a_tmux_failure_as_an_error_not_as_absent`, `close_refuses_an_invalid_name` (same module); `launches::tests::close_acks_say_killed_absent_or_failed`. |
| The launch passes the role, cwd, room, stage id and prompt | `src-tauri/src/launches.rs:383` `launches::tests::launch_hands_the_role_to_the_spawn_call`. It asserts the full `PtySpawnCall`: agent, cwd, room, harness, role, stage_id, first_message. |
| CUBILOT_STAGE_ID reaches the session only for a stage launch | `src-tauri/src/pty.rs:3921-3923` `pty::existing_session_tests::stage_ids_and_the_session_env`. argv has `-e CUBILOT_STAGE_ID=<id>` with a stage id and no such argument without one. |
| App exit does not kill tmux sessions | Code reading only: `src-tauri/src/lib.rs:1553`. The exit handler `kill()` kills the hub child process only. The PTY Drop detaches the attach child. Nothing in lib.rs calls `kill-session`. **No automated test covers this point.** The closure sits inside `run()` on the Tauri handle. A test needs a production refactor, which this ticket does not allow. |

Item 3: the live tester launch in a worktree is not part of this ticket. The 6.5 live record covers it. It was not run again here.

## Pass lines (cargo test --manifest-path src-tauri/Cargo.toml <name>)

```
test pty::existing_session_tests::close_kills_only_the_named_session ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 196 filtered out
test launches::tests::launch_hands_the_role_to_the_spawn_call ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 196 filtered out
test pty::existing_session_tests::stage_ids_and_the_session_env ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 196 filtered out
```

Full run: `cargo test --manifest-path src-tauri/Cargo.toml`: 196 passed, 0 failed, 1 ignored.

## Setup note
A fresh worktree needed `bun install`, `./scripts/build-sidecars.sh` and `./scripts/stage-prep.sh` (builds src-tauri/resources/tmux) before cargo could build. These outputs are git-ignored.
