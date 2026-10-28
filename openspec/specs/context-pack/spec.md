# context-pack Specification

## Purpose
Gives a new stage session a small, cache-friendly start: stable text first, a short project primer, and a context pack that the hub builds without a model.

## Requirements

### Requirement: The first message puts stable text before ticket text

The hub SHALL order the text that a stage session receives as: role text, then the project primer, then the ticket part. The role text and the primer SHALL be identical, byte for byte, for two sessions of one role in one room when the primer sources have not changed.

#### Scenario: Two sessions of one role share the stable part

- **WHEN** the hub launches two Worker sessions for two different tickets with no change to `docs/PRIMER.md` or the Nutshell between them
- **THEN** the text before the ticket part is identical in both first messages, byte for byte

#### Scenario: The ticket part is last

- **WHEN** the hub renders a first message
- **THEN** the ticket, the notes and the context pack come after the primer, and nothing stable follows them

### Requirement: The project primer is docs/PRIMER.md plus the Nutshell

The hub SHALL build the primer from `docs/PRIMER.md` of the room's project folder and the Nutshell of the room. `docs/PRIMER.md` SHALL be at most about 2,000 tokens. The hub SHALL NOT read `CONTEXT.md` for the primer. When `docs/PRIMER.md` is over the cap, the hub SHALL cut it and add one line that names the cut.

#### Scenario: Both sources present

- **WHEN** `docs/PRIMER.md` is under the cap and the room has a Nutshell
- **THEN** the primer holds both in full

#### Scenario: Primer file over the cap

- **WHEN** `docs/PRIMER.md` is over the cap
- **THEN** the primer file is cut to the cap, the Nutshell stays whole, and one line names the cut

#### Scenario: CONTEXT.md is not read

- **WHEN** the project folder has a `CONTEXT.md` and no `docs/PRIMER.md`
- **THEN** the primer does not contain any text of `CONTEXT.md`

### Requirement: A missing primer file is stated

When `docs/PRIMER.md` is missing, the first message SHALL say "primer missing" in the primer position. The launch SHALL NOT be refused, and the hub SHALL NOT insert other text in its place. The Nutshell stays in the primer.

#### Scenario: No primer file

- **WHEN** a stage launches and the project folder has no `docs/PRIMER.md`
- **THEN** the first message holds the line "primer missing" and the Nutshell, and the stage launches

### Requirement: The hub builds the context pack before the launch with no model

The hub SHALL build the context pack before it queues the launch. graphify SHALL read the graph of the room's project folder, and the graph describes the room base, not the ticket branch; the other pack commands run in the stage worktree. The pack SHALL hold a graphify query result with a budget of 1,500 tokens, built from the ticket title and criteria, and the symbol signatures of the files that the ticket and the spec name. The hub SHALL NOT call a model to build the pack.

#### Scenario: Pack for a Worker

- **WHEN** a Worker stage launches and graphify and Serena are available
- **THEN** the first message holds the graph result and the symbol signatures, and the graph result is within the budget

#### Scenario: Signatures come from ctags

- **WHEN** Serena has no interface the hub can call and universal-ctags is on PATH
- **THEN** the signatures section is labelled "signatures (ctags)" and holds the ctags output for the named files

#### Scenario: No signature tool

- **WHEN** neither Serena nor ctags is available
- **THEN** the signatures section is marked `missing` and holds no text from any other tool

#### Scenario: Named file has no symbols

- **WHEN** a named file is missing or has no symbols
- **THEN** the pack lists the path with the word `none` and the launch continues

### Requirement: The graph status is reported honestly

The first message SHALL state the graph status as `fresh`, `stale` or `missing`. When a tool is not on PATH or a command fails, the hub SHALL mark that part `missing`, SHALL continue the launch, and SHALL NOT insert placeholder content.

#### Scenario: graphify not on PATH

- **WHEN** the `graphify` command is not found
- **THEN** the graph status is `missing`, the pack has no graph section, and the stage launches

#### Scenario: A command exceeds its time limit

- **WHEN** a pack command runs longer than its time limit
- **THEN** the hub stops it, marks that part `missing` and launches the stage

### Requirement: The pack depth follows the role

The hub SHALL include in each first message only what the role table allows. Worker and Writer SHALL get the primer, ticket, notes and full pack. Tester SHALL get the ticket, the commands to run and the changed files. Code Validator SHALL get the ticket, notes, diff stat, changed files and test report. Spec Validator SHALL get the request, draft tickets, spec and a graph query for the request. Editor SHALL get the document and the style guide. Reviewer SHALL get the document, notes and pack.

#### Scenario: Tester gets no exploration text

- **WHEN** a Tester stage launches
- **THEN** the first message has no graph result and no symbol signatures

#### Scenario: Validator gets the diff

- **WHEN** a code Validator stage launches
- **THEN** the first message holds `git diff --stat` and the list of changed files

### Requirement: Role prompts name the tool order

Each role prompt SHALL tell the agent to use `graphify query`, `rg` and Serena `find_symbol` before it opens a full file. The result section of each of the six role prompts SHALL tell the agent to include `context.notes`, with a target of 300 words and a limit of 400.

#### Scenario: Prompt text present

- **WHEN** the staged role prompt of any of the six roles or the Orchestrator is read
- **THEN** it names `graphify query`, `rg` and `find_symbol` and says to use them before a full file

#### Scenario: Notes rule present

- **WHEN** the staged prompt of `worker`, `tester`, `validator`, `writer`, `editor` or `reviewer` is read
- **THEN** its result section names `context.notes`, the 300-word target and the 400-word limit
