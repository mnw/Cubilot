// stage-sessions 4.3: the first message of a stage session holds the ticket part only; a retry adds one line.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEMPLATE, loadTemplate, renderFirstMessage } from "../../hub/core/first-message";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const ticket = { id: "t_1", title: "Fix the thing", acceptance_criteria: "It works.\nIt is tested.", blast_radius: "high", request_id: "r-1" };

describe("renderFirstMessage", () => {
  test("holds title, criteria, radius, request, stage, branch and worktree, and no role prompt", () => {
    const m = renderFirstMessage({ stageId: "s_0123456789abcdef", role: "worker", ticket, branch: "ticket/t_1", worktree: "/w/t_1" });
    for (const part of ["t_1", "Fix the thing", "It works.\nIt is tested.", "Blast radius: high", "Request: r-1", "s_0123456789abcdef", "Branch: ticket/t_1", "Worktree: /w/t_1"]) {
      expect(m).toContain(part);
    }
    expect(m).not.toContain("Note: the earlier session");
  });

  test("a detached worktree says so; the stable text comes first and the ticket last; two tickets share the first lines", () => {
    const a = renderFirstMessage({ stageId: "s_a", role: "tester", ticket, branch: null, worktree: "/w/a" });
    const b = renderFirstMessage({ stageId: "s_b", role: "tester", ticket: { ...ticket, id: "t_2", title: "Other" }, branch: null, worktree: "/w/b" });
    expect(a).toContain("Branch: none (detached worktree)");
    expect(a.split("## Ticket")[0]).toBe(b.split("## Ticket")[0]);
    expect(a.indexOf("## Ticket")).toBeLessThan(a.indexOf("## Acceptance criteria"));
  });

  test("a retry adds one line with the reason, on one line even if the reason has newlines", () => {
    const base = renderFirstMessage({ stageId: "s", role: "worker", ticket, branch: null, worktree: "/w" });
    const retry = renderFirstMessage({ stageId: "s", role: "worker", ticket, branch: null, worktree: "/w", reason: "no result\nafter two turns" });
    expect(retry.startsWith(base.trimEnd())).toBe(true);
    expect(retry.slice(base.trimEnd().length).trim()).toBe("Note: the earlier session of this stage stopped: no result after two turns");
  });
});

describe("templates (factory/<role>/first-message.md)", () => {
  const roles = ["worker", "tester", "validator", "writer", "editor", "reviewer"];
  const input = { stageId: "s_a", role: "worker", ticket, branch: "ticket/t_1", worktree: "/w" };

  test("the six shipped files exist; five equal the built-in fallback, the validator one adds the recipient line", () => {
    for (const r of roles) {
      const file = readFileSync(`factory/${r}/first-message.md`, "utf8");
      if (r === "validator") continue;
      expect(file, r).toBe(DEFAULT_TEMPLATE);
      expect(renderFirstMessage({ ...input, role: r }, file), r).toBe(renderFirstMessage({ ...input, role: r }, DEFAULT_TEMPLATE));
    }
    const v = renderFirstMessage({ ...input, role: "validator", recipient: "Lead2" }, readFileSync("factory/validator/first-message.md", "utf8"));
    expect(v).toContain("Send the result handoff to Lead2.");
    expect(renderFirstMessage({ ...input, role: "validator" }, readFileSync("factory/validator/first-message.md", "utf8"))).toContain("Send the result handoff to Orchestrator.");
    // the validator file is the default plus that one line
    expect(readFileSync("factory/validator/first-message.md", "utf8").replace("Send the result handoff to {{recipient}}.\n", "")).toBe(DEFAULT_TEMPLATE);
  });

  test("a staged file is used when it exists; a missing, empty or unsafe one falls back to the built-in text", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-factory-"));
    mkdirSync(join(dir, "v1", "worker"), { recursive: true });
    writeFileSync(join(dir, "v1", "worker", "first-message.md"), "CUSTOM {{ticket_id}} / {{unknown}}\n");
    expect(loadTemplate("worker", dir, "v1")).toBe("CUSTOM {{ticket_id}} / {{unknown}}\n");
    expect(renderFirstMessage(input, loadTemplate("worker", dir, "v1")).startsWith("CUSTOM t_1 / {{unknown}}\n")).toBe(true);
    expect(loadTemplate("tester", dir, "v1")).toBe(DEFAULT_TEMPLATE); // no file for this role
    writeFileSync(join(dir, "v1", "worker", "first-message.md"), "  \n");
    expect(loadTemplate("worker", dir, "v1")).toBe(DEFAULT_TEMPLATE); // empty file
    expect(loadTemplate("worker", undefined, "v1")).toBe(DEFAULT_TEMPLATE); // no factory dir
    expect(loadTemplate("worker", dir, undefined)).toBe(DEFAULT_TEMPLATE); // no version
    expect(loadTemplate("../worker", dir, "v1")).toBe(DEFAULT_TEMPLATE); // a role is a plain name
  });

  test("a value that holds a placeholder is not expanded again", () => {
    const m = renderFirstMessage({ ...input, ticket: { ...ticket, title: "{{acceptance_criteria}}", acceptance_criteria: "SECRET {{role}}" } });
    expect(m).toContain("- Title: {{acceptance_criteria}}");
    expect(m).toContain("SECRET {{role}}");
  });
});

describe("the launch request carries the first message", () => {
  function env() {
    const db = new Database(":memory:");
    migrateLedger(db);
    createTicketKind(db).migrate(db);
    const rt = createStageRuntime(db, { ackMs: 60_000 });
    rt.module.migrate(db);
    giveProject(db, "r1");
    const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
    const sent: LaunchRequest[] = [];
    rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
    let n = 0;
    const stage = (role: string, criteria = "c") => {
      const id = `t_${(++n).toString(16).padStart(16, "0")}`;
      db.run(
        `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
         VALUES (?, 'r1', 'Title ' || ?, ?, 'low', 'medium', 'a', 'queued', 'r-9', 1, 1, 1)`,
        [id, id, criteria],
      );
      return rt.api.create({ ticket_id: id, role }, "system", cap);
    };
    const launch = (stage_id: string, session: string, reason?: string) =>
      rt.enqueueLaunch({ stage_id, session, room: "r1", harness: "claude", cwd: null, prompt: "", reason }, cap);
    return { rt, sent, stage, launch };
  }
  const first = (r: LaunchRequest) => (r as Extract<LaunchRequest, { kind: "launch" }>).prompt;

  test("a worker launch gets the ticket part with its branch and worktree; two tickets differ only in the ticket part", () => {
    const e = env();
    const a = e.stage("worker");
    const b = e.stage("worker");
    expect(e.launch(a.id, "worker-1").ok).toBe(true);
    expect(e.launch(b.id, "worker-2").ok).toBe(true);
    const [pa, pb] = [first(e.sent[0]), first(e.sent[1])];
    expect(pa).toContain(`Branch: ticket/${a.ticket_id}`);
    expect(pa).toContain(`Title: Title ${a.ticket_id}`);
    expect(pa).toContain((e.sent[0] as any).cwd);
    expect(pa.split("## Ticket")[0]).toBe(pb.split("## Ticket")[0]);
    expect(pa).not.toContain(b.ticket_id!);
  });

  test("a retry launch adds the reason of the earlier stop; a 100 KB criteria text is carried whole", () => {
    const e = env();
    const big = "x".repeat(100_000);
    const s = e.stage("tester", big);
    expect(e.launch(s.id, "tester-1", "timed out").ok).toBe(true);
    const p = first(e.sent[0]);
    expect(p).toContain(big);
    expect(p.length).toBeGreaterThan(100_000);
    expect(p.trimEnd().endsWith("Note: the earlier session of this stage stopped: timed out")).toBe(true);
  });
});

describe("the handoff that started the stage (gap A)", () => {
  function env() {
    const db = new Database(":memory:");
    migrateLedger(db);
    createTicketKind(db).migrate(db);
    const rt = createStageRuntime(db, { ackMs: 60_000 });
    rt.module.migrate(db);
    giveProject(db, "r1");
    const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
    const sent: LaunchRequest[] = [];
    rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
    const tid = "t_0000000000000001";
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 1, 1, 1)`,
      [tid],
    );
    const stage = (role: string) => rt.api.create({ ticket_id: tid, role }, "system", cap);
    const launch = (id: string, session: string, reason?: string) => rt.enqueueLaunch({ stage_id: id, session, room: "r1", harness: "claude", cwd: null, prompt: "", reason }, cap);
    // A role handoff as the hub stores it: the row and its creation event (the stage is pinned to the handoff by that seq).
    const handoff = (id: string, from: string, role: string, task: string, context: Record<string, unknown>) => {
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms, room) VALUES (?, ?, ?, ?, ?, 'pending', 1, 2, 'r1')",
        [id, from, `role:${role}`, task, JSON.stringify({ ticket_id: tid, ...context })],
      );
      db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms, room) VALUES (?, 'handoff.created', ?, '{}', 1, 'r1')", [id, from]);
    };
    const cancel = (id: string) => {
      db.run("UPDATE handoffs SET status = 'cancelled' WHERE id = ?", [id]);
      db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms, room) VALUES (?, 'handoff.cancelled', 'tester-1', '{}', 1, 'r1')", [id]);
    };
    return { rt, sent, stage, launch, handoff, cancel, cap };
  }
  const first = (r: LaunchRequest) => (r as Extract<LaunchRequest, { kind: "launch" }>).prompt;

  test("a validator stage started by a tester result has the sender, task, verdict and report in its first message", () => {
    const e = env();
    e.handoff("h_0000000000000001", "tester-1", "validator", "tester result", { verdict: "PASS", report: "REPORT-TEXT line one\nline two", commit: "HEAD" });
    const s = e.stage("validator");
    expect(e.launch(s.id, "validator-1").ok).toBe(true);
    const p = first(e.sent[0]);
    expect(p).toContain("## Handoff");
    expect(p).toContain("tester-1");
    expect(p).toContain("tester result");
    expect(p).toContain("REPORT-TEXT line one");
    expect(p).toContain('"verdict": "PASS"');
  });

  test("the retry launch of the same stage carries the same handoff section, before the note", () => {
    const e = env();
    e.handoff("h_0000000000000001", "tester-1", "validator", "tester result", { verdict: "FAIL", report: "R-1" });
    const s = e.stage("validator");
    expect(e.launch(s.id, "validator-1").ok).toBe(true);
    e.rt.api.move(s.id, { to: "running" }, "system", e.cap);
    e.rt.api.move(s.id, { to: "retrying", reason: "x" }, "system", e.cap);
    // no close is pending, so the move to retrying relaunches the stage at once, with the reason
    expect(e.sent.filter((r) => r.kind === "launch")).toHaveLength(2);
    const [one, two] = [first(e.sent[0]), first(e.sent[1])];
    expect(two).toContain("Note: the earlier session");
    expect(two).toContain("## Handoff");
    expect(two.slice(two.indexOf("## Handoff"))).toContain("R-1");
    expect(two.indexOf("## Handoff")).toBeLessThan(two.indexOf("Note: the earlier session"));
    const section = (m: string) => m.slice(m.indexOf("## Handoff"), m.includes("Note: the earlier") ? m.indexOf("Note: the earlier") : undefined).trimEnd();
    expect(section(two)).toBe(section(one));
  });

  test("a later handoff does not replace the one that started the stage: the retry keeps the first context and commit", () => {
    const e = env();
    e.handoff("h_0000000000000001", "tester-1", "validator", "first", { verdict: "FAIL", report: "REPORT-ONE", commit: "HEAD" });
    const s = e.stage("validator");
    expect(e.launch(s.id, "validator-1").ok).toBe(true);
    e.handoff("h_0000000000000002", "tester-2", "validator", "second", { verdict: "PASS", report: "REPORT-TWO", commit: "HEAD" });
    e.rt.api.move(s.id, { to: "running" }, "system", e.cap);
    e.rt.api.move(s.id, { to: "retrying", reason: "x" }, "system", e.cap);
    const retry = first(e.sent.filter((r) => r.kind === "launch")[1]);
    expect(retry).toContain("REPORT-ONE");
    expect(retry).not.toContain("REPORT-TWO");
    // the later handoff is for a later stage
    const s2 = e.stage("validator");
    e.rt.api.move(s.id, { to: "failed" }, "system", e.cap);
    // the freed slot starts the queued second stage by itself
    expect(e.rt.api.load(s2.id)!.status).toBe("launching");
    const p2 = first(e.sent.filter((r) => r.kind === "launch").at(-1)!);
    expect(p2).toContain("REPORT-TWO");
  });

  test("cancelling the handoff after its stage started does not change the retry: it keeps the context and the commit", () => {
    const e = env();
    e.handoff("h_0000000000000001", "tester-1", "validator", "first", { verdict: "FAIL", report: "REPORT-ONE", commit: "HEAD" });
    const s = e.stage("validator");
    expect(e.launch(s.id, "validator-1").ok).toBe(true);
    e.cancel("h_0000000000000001");
    e.rt.api.move(s.id, { to: "running" }, "system", e.cap);
    e.rt.api.move(s.id, { to: "retrying", reason: "x" }, "system", e.cap);
    const retry = first(e.sent.filter((r) => r.kind === "launch")[1]);
    expect(retry).toContain("REPORT-ONE");
    // a handoff cancelled BEFORE the stage never started it
    const e2 = env();
    e2.handoff("h_0000000000000009", "tester-1", "validator", "withdrawn", { verdict: "PASS", report: "REPORT-GONE" });
    e2.cancel("h_0000000000000009");
    const s2 = e2.stage("validator");
    expect(e2.launch(s2.id, "validator-1").ok).toBe(true);
    expect(first(e2.sent[0])).not.toContain("## Handoff");
  });

  test("a first worker stage that no handoff started has no handoff section", () => {
    const e = env();
    const s = e.stage("worker");
    expect(e.launch(s.id, "worker-1").ok).toBe(true);
    expect(first(e.sent[0])).not.toContain("## Handoff");
  });

  test("the handoff section names the session's own stage id, after Context and before the JSON; the sender's id stays in the JSON", () => {
    const e = env();
    e.handoff("h_0000000000000003", "worker-1", "tester", "worker result", { stage_id: "s_aaaaaaaaaaaaaaaa", commit: "HEAD" });
    const s = e.stage("tester");
    expect(e.launch(s.id, "tester-1").ok).toBe(true);
    const p = first(e.sent[0]);
    const section = p.slice(p.indexOf("## Handoff"));
    const line = `The stage_id in this context is the sender's stage. Your stage id is ${s.id}. Use your own stage id in your result.`;
    expect(section).toContain(line);
    expect(section.indexOf("- Context:")).toBeLessThan(section.indexOf(line));
    expect(section.indexOf(line)).toBeLessThan(section.indexOf('"stage_id": "s_aaaaaaaaaaaaaaaa"'));
  });

  test("a context over 64 KB is cut and the section names the handoff id", () => {
    const e = env();
    e.handoff("h_00000000000000ff", "tester-1", "validator", "tester result", { verdict: "PASS", report: "y".repeat(200_000) });
    const s = e.stage("validator");
    expect(e.launch(s.id, "validator-1").ok).toBe(true);
    const p = first(e.sent[0]);
    const section = p.slice(p.indexOf("## Handoff"));
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(section).toContain("h_00000000000000ff");
    expect(section).toContain("cut");
    expect(p).not.toContain("y".repeat(70 * 1024));
  });
});
