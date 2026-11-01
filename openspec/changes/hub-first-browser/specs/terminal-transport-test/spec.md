## ADDED Requirements

### Requirement: One test compares tmux control mode and a raw PTY
The repository SHALL have one test that runs the same cases against tmux control mode (`tmux -C`, output from `%output`, input by `send-keys -H`) and against a raw PTY on `tmux attach`, on a hermetic tmux socket. The cases SHALL be: colours, cursor addressing, alternate screen, a 4-byte UTF-8 glyph, resize, and input keys. The test SHALL need no Claude or Pi login.

#### Scenario: Colours and cursor reach the viewer
- **GIVEN** a fake TUI in a tmux session prints `ESC[38;2;255;0;0m`, `ESC[5;10H` and `ESC[?1049h`
- **WHEN** the test reads the stream of each transport
- **THEN** each transport's bytes, fed to a headless terminal, give a red cell at row 5, column 10 on the alternate screen, or the test records that transport as failing the case

#### Scenario: UTF-8 glyph
- **WHEN** the fake TUI prints `🦀` (4 bytes)
- **THEN** the headless terminal shows the glyph in one cell pair, or the test records the failure

#### Scenario: Resize reaches the program
- **WHEN** the viewer resizes from 80×24 to 120×40
- **THEN** the fake TUI reports `120x40` within 1 second, or the test records the failure

#### Scenario: Input keys reach the program
- **WHEN** the viewer sends Up, Esc, Ctrl+C, Shift+Tab and a bracketed paste of `a b`
- **THEN** the fake TUI receives `ESC[A`, `ESC`, `0x03`, `ESC[Z` and `ESC[200~a bESC[201~` in that order, or the test records the failure

### Requirement: The test result decides the terminal transport
The result SHALL be recorded in `docs/spikes/terminal-transport.md`: the pass or fail of each case for each transport, the same items from one manual run with real Claude Code and Pi, and the bytes per second at a full redraw. The raw PTY SHALL be chosen when it passes every case. Control mode SHALL be chosen only when the raw PTY fails a case that control mode passes, and then only after the human changes the hard rule "Raw PTY only".

#### Scenario: Raw PTY passes every case
- **WHEN** the raw PTY passes every case
- **THEN** the record names the raw PTY as the transport of the hub terminal

#### Scenario: Raw PTY fails a case
- **WHEN** the raw PTY fails a case that control mode passes
- **THEN** the record names the case and the result is a question to the human before any terminal stream work starts
