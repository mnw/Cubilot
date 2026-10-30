# Spike: terminal transport (control mode or raw PTY)

Question: which transport shows colours, cursor, resize and input of a TUI in a viewer? Source: `openspec/changes/hub-first-browser`, design decision 1.

Transport: raw PTY

## How to run

`bun test tests/spike/terminal-transport.test.ts` runs the cases on a hermetic tmux socket (bundled tmux 3.5a, no app data). The viewer is `@xterm/headless` with the Unicode 11 addon. The program is `tests/fixtures/fake-tui.ts`. Run date: 2026-10-30, Bun 1.3.13.

- Control mode: `tmux -C attach`, output from `%output` (octal escapes decoded), input by `send-keys -H`, resize by `refresh-client -C`.
- Raw PTY: `Bun.Terminal` running `tmux attach`, bytes as they come, input written to the terminal, resize by `Terminal.resize`.

## Case table (fake TUI)

| Case | control mode | raw PTY |
|---|---|---|
| SGR 256 colour and truecolour | pass | pass |
| Cursor addressing (red cell at row 5, column 10) | pass | pass |
| Alternate screen enter and exit | pass | pass |
| UTF-8 4-byte glyph (one cell pair) | pass | pass |
| Resize 80x24 to 120x40 (program sees `120x40` in 26 ms) | pass | pass |
| Input (Up, Esc, Ctrl+C, Shift+Tab, bracketed paste, in order) | pass | pass |

Notes:
- Raw PTY: the viewer stays on the alternate screen for the whole attach, because tmux draws its own client on it. After the program leaves its alternate screen, the viewer shows the main-screen text on that screen. The case passes on "the text is visible".
- Truecolour on the raw PTY needs `set-option -sa terminal-features ",xterm-256color:RGB"` on the tmux server. Without it, tmux reduces `38;2;0;128;255` to a 256-colour index and the red cell becomes palette 196. A first run without the option failed SGR and Cursor on the raw PTY. `src-tauri/src/pty.rs` does not set this option. The hub terminal (group 5) must set it.
- Input: a lone Esc reaches the program after the tmux `escape-time` (default 500 ms). The test waits 700 ms after Esc.
- The headless viewer defaults to Unicode 6 and counts the glyph as one cell. The test loads the Unicode 11 addon. The browser xterm.js needs the same addon for the same result.

## Manual run with real programs

Run: `TT_REAL=claude bun test tests/spike/terminal-transport.test.ts -t "real program"` and the same with `pi`. The test starts the program in a new folder, waits 9 s, resizes to 120x40, types U+1F980 as UTF-8 bytes, sends paste, Shift+Tab, Up, Ctrl+C and Esc one by one, and does not send a prompt.

| Item | claude, control mode | claude, raw PTY | pi, control mode | pi, raw PTY |
|---|---|---|---|---|
| Colours (coloured cells at 80x24 / 120x40) | 147 / 187 | 147 / 187 | 641 / 1710 | 641 / 1710 |
| Real cursor addressing (viewer cursor and text equal tmux's `cursor_x,cursor_y` and `capture-pane`) | pass (1,13) | pass (1,13) | pass (0,35) | pass (0,35) |
| Real alternate screen (tmux `alternate_on` / viewer buffer) | claude: off / normal | claude: off / alternate (tmux client screen) | on / alternate | on / alternate |
| Layout redrawn after resize | pass | pass | pass | pass |
| Pane size after resize | 120x40 | 120x40 | 120x40 | 120x40 |
| Bracketed paste `a b` | alive, screen unchanged | same | alive, screen changed | same |
| Shift+Tab | alive, screen unchanged | same | alive, screen changed | same |
| Up | alive, screen changed | same | alive, screen unchanged | same |
| Ctrl+C | alive, screen changed | same | alive, screen changed | same |
| Esc | claude exited | claude exited | alive, screen unchanged | same |
| 4-byte UTF-8 glyph U+1F980 (crab), cells shown / of width 2 | 1 / 1 (in the folder path) | 1 / 1 | 2 / 2 (typed into the input box) | 2 / 2 |

Key rows record that the program lived and whether the screen changed. They do not prove which byte the program read: a real program has no hex log. Claude Code sat on its folder trust prompt, so Esc closed it and the process exited on both transports. Both transports gave the same answer for each item and each program.

Limits of the manual run: Claude Code showed its folder trust prompt, not the chat screen, because the folder is new. The run did not test typing a prompt or a model answer. Paste and Shift+Tab reach the trust prompt, not the chat input, so their effect on the real input box is not verified. Claude Code does not use the alternate screen on its trust prompt: not checked on its chat screen. The result was read from the viewer text and cell counts, not from a screenshot. Pi printed its start screen (`~/.pi/agent/AGENTS.md`, skills list) and stayed alive after Up and Esc.

## Bytes per second at a full redraw

The fake TUI writes 60 full frames of 120x40 cells, one SGR per cell, as fast as the pane allows. The viewer counted bytes from the first byte sent until `REDRAW-DONE` showed.

| Transport | bytes | bytes per second |
|---|---|---|
| control mode | 3 338 434 | about 1 357 000 |
| raw PTY | 453 303 | about 132 000 |

Control mode sends every pane byte, so it carries about 7 times more bytes. The raw PTY carries tmux's own screen diff, so frames that tmux skips never reach the viewer. Numbers vary by run. The raw PTY rate is the one the hub sends over a WebSocket. It is far below any local link limit.

## Pick

The rule of design decision 1: the raw PTY wins when it passes every case. It passes every case, with the terminal-features option above. The hard rule "Raw PTY only" stays. Groups 5 to 10 assume the raw PTY. No question to the human is needed.
