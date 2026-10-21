# Part 13: mutation testing in the app

## Goal

Mutation testing is in the factory roles today (`tester/skills/mutation-testing/`, the Tester, Validator and Worker role files). The app does not support it yet. Part 13 makes the app:
1. check that each project has its mutation tool,
2. carry the threshold and the results as data, not as free text,
3. sort surviving mutants into "write a test", "decide" and "ignore", so the Worker does not write tests for noise.

## Rollout and risk controls (decision 2026-10-18)

Mutation testing has a high implementation risk for Drupal projects:
1. **Slow.** The tool runs the tests again for each mutant. Drupal kernel and functional tests need a database and a booted site. One ticket can take hours.
2. **Fragile setup.** Each project needs Infection, PCOV or Xdebug in its Drupal environment (DDEV or Docker), and a working `phpunit.xml`.
3. **Low coverage.** Custom Drupal modules often have few unit tests. A hard 80 % gate fails almost every ticket and causes long, expensive loops.
4. **Equivalent mutants.** Some mutants do not change behaviour, so no test can kill them. Workers waste tokens on them.
5. **No triage for PHP.** `jtt` reads Python and JS/TS only, and it sends code to an outside service.
6. **Flaky tests** make mutants look killed or survived for the wrong reason.
7. **A Haiku Tester** reports a broken setup but cannot fix it. Tickets stall.

Controls:

| Control | Rule |
|---|---|
| Opt-in per project | Project setting `mutation_mode: off \| advisory \| enforce`. Default `off`. The human sets it. |
| Advisory first | `advisory`: the Tester runs it and reports the score. The Validator reports findings as `suggestion`. No ticket fails on mutation results. Run `advisory` for some weeks to measure real scores before `enforce`. |
| Enforce later | `enforce`: the threshold applies. Set `mutation_threshold` for each project from the `advisory` results, not from a fixed 80 %. |
| Fast suites only | Run only unit tests and kernel tests (Infection `--test-framework-options="--testsuite=<unit suite>"`, or `testFrameworkOptions` in `infection.json5`). Do not run functional or browser tests. Mutate only PHP classes with logic (services, value objects, plugins with logic). Leave out hooks, forms, templates and configuration. |
| Time budget | 15 minutes for each run, default. At the limit, stop the run and report a partial result. A partial result never fails a ticket. Infection: `timeout` in `infection.json5` for each mutant, and an outer limit on the command. |
| Equivalent mutants | The Worker kills a surviving mutant, or marks it equivalent with a one-line reason. The Validator accepts a reasoned mark unless there is concrete evidence against it. One survivor never blocks a ticket on its own. |
| No `jtt` for PHP | Do not use `jtt` on PHP projects until it supports PHP and the client contract allows the data transfer. |
| Setup failure | When the tool cannot run, the Tester reports it and the ticket continues without mutation results. The Orchestrator makes a setup ticket for the human. |

Phase: Part 13 is the last part in the build order. No other part depends on it.

## Mutation tools are project dependencies

Graphify and Serena are global tools (Part 7). Mutation tools are not: each project adds its tool as a development dependency. The app must not install them globally.

| Stack | Tool | Project install | Extra need |
|---|---|---|---|
| PHP, Drupal | Infection | `composer require --dev infection/infection` | PCOV or Xdebug for coverage |
| JS, TS | StrykerJS | `npm install --save-dev @stryker-mutator/core` plus the runner for the test framework | none |
| Python | mutmut | add `mutmut` to the dev dependencies | none |
| Java | PIT | Maven or Gradle plugin | none |
| Rust | cargo-mutants | `cargo install cargo-mutants` | none |

The Doctor (Part 7) adds a project check. When a factory room opens on a project, it finds the stack from the project files (`composer.json`, `package.json`, `pyproject.toml`, `pom.xml`, `Cargo.toml`). It then checks the mutation tool and, for PHP, the coverage driver. A failed check shows the install command. The Doctor does not change project files without the user's approval.

## Threshold and results as data

1. **`mutation_threshold` on tickets.** An optional number (covered-code score, percent). It applies only in `enforce` mode. The project sets the default from its `advisory` results. A ticket can set its own value. Today the threshold is free text in the acceptance criteria.
2. **Machine report.** The Tester keeps the tool's JSON report with the ticket (`attach_ticket_file`):
   - Infection: `--logger-json`
   - StrykerJS: the `json` reporter (`reports/mutation/mutation.json`, mutation-testing-report-schema)
   - cargo-mutants: `mutants.out/outcomes.json`
3. **Results in the `review` kind** (Part 11): `mutation_score`, `covered_score`, `survivors`, and the triage counts below (`act`, `review`, `ignore`).

## Survivor triage with jev-test-triage

Source: https://github.com/cdubiel08/jev-test-triage (MIT, Chad Dubiel, version 0.1.2, 2026-09-26).

`jtt` sorts surviving mutants. Code drops mutants that cannot matter. A small decision model (TypeSafe Jev) answers 12 narrow questions about each remaining mutant. Code then puts each mutant in one band:
- **act**: write a test that kills it
- **review**: a person or an agent decides
- **ignore**: noise (equivalent rewrites, log text, tuning constants, type names)

Each run writes `.jtt/summary.md`, `findings.json`, `results.sarif` and `agent-prompt.md`. `agent-prompt.md` tells a coding agent to write one killing test for each finding and to prove that the test fails on the mutant.

Published results: on held-out data, 79 % to 87 % of the "act" findings were real test gaps. About 45 % of the survivors were in "review". The authors call the last gain exploratory. Cost is about USD 0.00006 for each survivor, with a budget limit for each run (`budget_usd` in `.jtt.toml`).

### Access through OpenRouter

Jev is not a chat model. It answers typed questions only, through its own endpoint. Pi cannot use it as its model, and it does not need to: `jtt` is a CLI that the Tester runs.

`jtt` uses the TypeSafe SDK. The SDK reads the base URL from the environment. To use OpenRouter:

```sh
TYPESAFE_BASE_URL=https://openrouter.ai/api
TYPESAFE_API_KEY=<OpenRouter API key>
JTT_MODEL=jev-1.13
```

Keep the model at `jev-1.13`. The `jtt` routing thresholds are tuned for 1.13. Do not use `jev-latest`. Check before you build: the `jtt` default model name is `jev-1.13.0`, and OpenRouter names the model `jev-1.13`. Check that a request with `JTT_MODEL=jev-1.13` goes through.

Sources: https://openrouter.ai/docs/guides/community/jev, https://openrouter.ai/docs/guides/community/typesafe-sdk.md, https://openrouter.ai/models/typesafe/jev-1.13

### Limits

1. **Languages.** `jtt` triages Python (its own small mutator) and JS/TS (Stryker JSON reports). It does not support PHP: its file and function detection knows only TypeScript and JavaScript. For Drupal projects, two changes are necessary:
   - Infection must write a mutation-testing-report-schema JSON report. Check if it can.
   - `jtt` needs PHP file and function detection (`src/jev_test_triage/mutants/stryker.py`, `LANG` and `FUNC_OPEN`).
   Until then, PHP projects use the threshold only.
2. **Code leaves the machine.** For each survivor, `jtt` sends the enclosing function and the changed lines to TypeSafe through OpenRouter. Client contracts can forbid this, for example on European Commission projects. Add a project setting `mutation_triage: off | on`, default `off`. The Doctor shows the setting. The human sets it to `on` only when the client allows it. Read the data policy on the OpenRouter model page before you use it.
3. **Model judgement.** "act" is not proof. The Validator still checks "act" and "review" findings against the code.

## Changes to the factory flow

1. **Tester.** Run mutation testing only when `mutation_mode` is `advisory` or `enforce`, with the fast suites and the time budget. After the run, when `mutation_triage` is `on` and the stack is supported (not PHP), run `jtt triage <report>`. Attach `findings.json` and `agent-prompt.md` to the ticket. Report the counts. Do not judge them.
2. **Validator.** In `advisory` mode, report every mutation finding as `suggestion`, and never fail a ticket on it. In `enforce` mode, when triage ran: an open "act" finding is blocking, unless the Worker marked it equivalent with a reason. Decide each "review" finding. Ignore the "ignore" band. When triage did not run: apply `mutation_threshold`. A partial result (time budget) is never blocking.
3. **Worker.** Use `agent-prompt.md` to write the killing tests. For each "act" finding, show that the new test fails on the mutant, or mark the mutant equivalent with a one-line reason.
4. **Weak-test lint.** `jtt weak-tests <test file>` is a free, deterministic lint that does not need a key. The Tester can run it on changed test files and add the result to the report.
5. Update the role files and `tester/skills/mutation-testing/SKILL.md` for steps 1 to 4 when you build this part.

## Toolchain and Doctor additions (Part 7)

- Add `jtt` to `factory/toolchain.lock`: `uv tool install git+https://github.com/cdubiel08/jev-test-triage@v0.1.2`.
- Keep the OpenRouter key in the macOS Keychain. Set `TYPESAFE_BASE_URL`, `TYPESAFE_API_KEY` and `JTT_MODEL` on the Tester launch command only.
- The Doctor checks `jtt --version`, the key, and the project settings `mutation_mode` and `mutation_triage`.

## Dashboard additions (Part 11)

The Quality panel shows, for each code ticket: mutation score, threshold, and the counts of "act", "review" and "ignore" survivors. A ticket with an open "act" finding shows in "Stuck" when it does not move for N minutes.

## Tests

0. With `mutation_mode` `off`, the Tester runs no mutation tool. With `advisory`, the Validator reports mutation findings as `suggestion` and the ticket can pass. A run that reaches the time budget reports a partial result, and the ticket is not blocked.
1. The Doctor finds PHP from `composer.json` and reports a missing Infection or a missing coverage driver.
2. A ticket with `mutation_threshold` 70 and a covered-code score of 75 passes the threshold check. With 65, it fails.
3. With `mutation_triage` `off`, the Tester does not run `jtt`, and no code leaves the machine.
4. With `mutation_triage` `on` and a Stryker report, the ticket gets `findings.json`, and the `review` verdict holds the "act", "review" and "ignore" counts.
5. A PHP project with `mutation_triage` `on` uses the threshold only, and the Tester reports that triage does not support PHP.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
