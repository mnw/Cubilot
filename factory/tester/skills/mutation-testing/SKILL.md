---
name: mutation-testing
description: Run mutation testing on the files a ticket changed and report the mutation score and each surviving mutant. Use when a ticket's tests must be checked for strength, not only for coverage. Supports Infection (PHP/Drupal), StrykerJS (JS/TS), mutmut (Python), PIT (Java) and cargo-mutants (Rust). Reports numbers only. It does not judge.
---

# Mutation testing

A mutation tool changes the code in small ways (a `>` becomes `>=`, a `return true` becomes `return false`). Each change is a mutant. When a test fails, the mutant is killed. When all tests pass, the mutant survived: the tests do not check that behaviour.

## Inputs
- `ticket_id`
- the project's `mutation_mode`. When it is `off`, do not run this skill.
- the time budget, default 15 minutes
- `branch`, checked out in a clean state
- base branch, default `origin/main`

## Procedure
1. Get the changed source files: `git diff --name-only --diff-filter=AM <base>...HEAD`. Remove test files, fixtures, generated files and docs.
2. If no source file changed, write "no source change, mutation testing not run" in the report and stop.
3. Make sure the normal test suite passes first. A mutation run on a red suite gives no useful result. If it fails, record that and stop.
4. Detect the stack and run the tool on the changed files only. Use the commands below. Use the fast test suites only (unit tests, and kernel tests for Drupal). Do not run functional or browser tests. Stop the run at the time budget: `timeout 15m <command>`.
5. Read the tool's machine report (JSON), not only the console summary.
6. Write the report section (format below).

## Commands

### PHP / Drupal: Infection
Needs a coverage driver (PCOV or Xdebug). Run from the directory that has `phpunit.xml(.dist)`.
```bash
vendor/bin/infection --git-diff-lines --git-diff-base=origin/main \
  --threads=max --show-mutations --no-progress \
  --logger-json=test-reports/<ticket_id>-infection.json \
  --test-framework-options="--testsuite=unit"
```
Use the name of the project's fast suite in `--testsuite`. Mutate only PHP classes with logic (services, value objects, plugins with logic). Leave out hooks, forms, templates and configuration.
For a Drupal module, point `source.directories` in `infection.json5` at the module and `phpUnit.configDir` at the directory that has `phpunit.xml`.
Metrics: MSI, Mutation Code Coverage, Covered Code MSI.

### JS / TS: StrykerJS
```bash
npx stryker run --incremental --mutate "<file1>,<file2>" --reporters json,clear-text
```
JSON report: `reports/mutation/mutation.json`.
Metrics: mutation score, mutation score based on covered code.

### Python: mutmut
Set the changed files in `[tool.mutmut]` `paths_to_mutate` (pyproject.toml or setup.cfg), then:
```bash
mutmut run
mutmut results
```
Check the installed version with `mutmut --version`. Version 3 changed the CLI.

### Java: PIT (pitest)
```bash
mvn org.pitest:pitest-maven:mutationCoverage \
  -DtargetClasses=<changed.classes.*> -DoutputFormats=XML,HTML -DwithHistory
```
Metrics: mutation score, test strength.

### Rust: cargo-mutants
```bash
git diff origin/main...HEAD > /tmp/<ticket_id>.diff
cargo mutants --in-diff /tmp/<ticket_id>.diff
```
Results: `mutants.out/outcomes.json`.

## Report format
Append this section to `test-reports/<ticket_id>.md`:

```markdown
## Mutation testing
- Tool and version: <tool> <version>
- Command: `<exact command>`
- Files mutated: <n> (<list>)
- Mutants: <total> total, <killed> killed, <survived> survived, <timeout> timed out, <no_coverage> not covered
- Mutation score: <x> %
- Covered-code score: <y> %
- Duration: <mm:ss>
- Result: complete | partial (time budget reached) | not run (<reason>)

### Surviving mutants
| File | Line | Mutator | Original | Mutated |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |
```

## Rules
- Mutate only the changed files. A full run is too slow for each ticket.
- Do not change the code, the tests or the tool configuration to raise the score.
- Do not say whether a score or a survivor is acceptable. Report the numbers. The Validator applies the threshold and decides about equivalent mutants.
- If the tool is not installed or cannot run, record the error and the reason. Do not skip silently. Do not try to fix the environment. The ticket continues without mutation results.
- If the run reaches the time budget, report the mutants it finished and write `partial`.
- List every surviving mutant. Do not summarise them as "a few".
