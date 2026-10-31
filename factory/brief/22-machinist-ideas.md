# Part 22: ideas from Machinist

Status: backlog, decision of the human 2026-10-31. Plan after the offline week (from 2026-11-09), except item 1, which goes into the orphan-session ticket now.

Source: github.com/owainlewis/machinist (Go, MIT, "the open-source software factory for supervised coding agents", read 2026-10-31). Cubilot takes the ideas, not the code: Machinist is Go around its own job queue; Cubilot is TypeScript on Bun with Rust, around stages and tickets. If code is ever copied, the MIT notice goes with it into `factory/licenses/`, and the copied part keeps MIT next to Cubilot's BSL 1.1.

## 1. Leases instead of sessions that hold work (now, with the orphan-session ticket)

Problem: an orphan session keeps its name. Later launches of the same ticket pick that name and fail with "already attached" (2026-10-29, 2026-10-30, 2026-10-31: seven tickets blocked until the human closed three sessions by hand).

Idea: a stage holds its session through a lease with an expiry. The session renews the lease while it works (each tool call or a heartbeat). When the lease runs out (crash, hang, lost connection), the hub closes the session, frees its name and puts the stage back to retry. A launch never picks a name with a live lease or a live tmux session.

Tests: a session that stops renewing is closed after the lease time and its stage retries; a launch with an attached orphan of the same name picks another name; a live session that renews keeps its lease.

## 2. An audit agent (after Part 21)

A read-only `audit` role inspects the repository on a schedule and makes draft tickets only for defects it can show: a failing command, a failing test it wrote in a scratch worktree, a file and line that contradict a spec. No style findings, no "could be better". The human approves the tickets like any request. Sibling of the retrospective: Part 21 improves the process, the audit finds defects in the product.

## 3. Shared workflow, local authority (with Part 12, Linux)

Split the configuration in two files:
- shared and versioned in the repo: roles, pipelines, limits, radius rule, the parts of `config.yml` that describe how the factory works;
- local to one machine, never in git: executor paths, model mappings per harness, credentials, the data folder.

Then a second machine (Linux host, Part 12) runs the same factory with its own local file, and a change to how the factory works is a reviewed commit.

## 4. An evaluation suite for the factory itself (with Part 21)

A small, opt-in suite of fixed tasks with known good results (a small bug fix, a doc change, a plan with a missing requirement for the spec review). It runs the real roles against them and scores the outcome. Part 21 then has a repeatable test of an improvement, not only a week of numbers. Close to Part 6, idea 14 (tests for skills).

## Also from Machinist, already in Cubilot

The builder never reviews its own work; each build in its own worktree; a bounded repair loop that ends as "blocked" with the evidence (Part 18: park after two FAILs); the human merges; token use per run. Its principle "execution facts are not product truth" is the reason for the Validator and the live check.
