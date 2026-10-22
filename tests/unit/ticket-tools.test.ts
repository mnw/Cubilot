import { describe, expect, test } from "bun:test";
import type { Host } from "../../hub/channel/host";
import { findTool } from "../../hub/channel/tools";

type Reply = { status: number; body?: unknown } | Error;
type Script = Reply | Reply[]; // an array answers the same key in order

// Fake Host: routes "METHOD /path" to a scripted reply and records the calls.
function fake(replies: Record<string, Script>) {
  const calls: Array<{ key: string; body: any }> = [];
  const host = {
    readText: async (p: string) => (p.endsWith("hub.url") ? "http://hub.test" : "tok"),
    handoffGate: async () => null,
    request: async (url: string, init: { method: string; body?: string }) => {
      const key = `${init.method} ${url.replace("http://hub.test", "")}`;
      calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
      const script = replies[key];
      const r = Array.isArray(script) ? script[Math.min(calls.filter((c) => c.key === key).length - 1, script.length - 1)] : script;
      if (!r) throw new Error(`unscripted ${key}`);
      if (r instanceof Error) throw r;
      return { status: r.status, text: JSON.stringify(r.body ?? {}) };
    },
    // Multipart upload: scripted as "UPLOAD /upload"; the file path is recorded as the body.
    upload: async (url: string, _token: string, filePath: string) => {
      const key = `UPLOAD ${url.replace("http://hub.test", "")}`;
      calls.push({ key, body: filePath });
      const r = replies[key] as Reply | undefined;
      if (!r) throw new Error(`unscripted ${key}`);
      if (r instanceof Error) throw r;
      return { status: r.status, text: JSON.stringify(r.body ?? {}) };
    },
  } as unknown as Host;
  return { host, calls };
}

const TID = "t_0123456789abcdef";
const run = (name: string, host: Host, args: Record<string, unknown>, room?: string) =>
  findTool(name)!.handler({ agent: "alice", hubEnv: "", host, room }, args).then((r) => r.content[0].text);

const accept = (replies: Record<string, Script>, ctx: unknown = { ticket_id: TID }) =>
  fake({
    "POST /handoffs/h_0123456789abcdef/accept": { status: 200, body: { snapshot: { context: ctx } } },
    ...replies,
  });

describe("accept_handoff claims the named ticket", () => {
  const go = (f: ReturnType<typeof fake>) => run("accept_handoff", f.host, { handoff_id: "h_0123456789abcdef" });

  test("claimed", async () => {
    const f = accept({ [`POST /tickets/${TID}/claim`]: { status: 200 } });
    expect(await go(f)).toBe(`accepted. ticket ${TID}: claimed`);
    expect(f.calls[1].body).toEqual({ by: "alice" });
  });
  test("409 names the owner", async () => {
    const f = accept({ [`POST /tickets/${TID}/claim`]: { status: 409, body: { snapshot: { assignee: "bob" } } } });
    expect(await go(f)).toBe(`accepted. ticket ${TID}: already claimed by bob`);
  });
  test("409 on a cancelled or done ticket is not reported as claimed", async () => {
    for (const status of ["cancelled", "done"]) {
      const f = accept({ [`POST /tickets/${TID}/claim`]: { status: 409, body: { snapshot: { status, assignee: null } } } });
      expect(await go(f)).toBe(`accepted. ticket ${TID}: ticket is ${status}`);
    }
    const g = accept({ [`POST /tickets/${TID}/claim`]: { status: 409, body: {} } });
    expect(await go(g)).toBe(`accepted. ticket ${TID}: already claimed`);
  });
  test("403 → another room", async () => {
    const f = accept({ [`POST /tickets/${TID}/claim`]: { status: 403 } });
    expect(await go(f)).toContain("ticket in another room");
  });
  test("5xx and transport errors stay a success result", async () => {
    const a = accept({ [`POST /tickets/${TID}/claim`]: { status: 500, body: { error: "boom" } } });
    expect(await go(a)).toBe(`accepted. ticket ${TID}: claim failed: 500 boom`);
    const b = accept({ [`POST /tickets/${TID}/claim`]: new Error("econnreset") });
    expect(await go(b)).toBe(`accepted. ticket ${TID}: claim failed: econnreset`);
  });
  test("no ticket_id → plain accepted, no claim call", async () => {
    for (const ctx of [null, {}, { ticket_id: 5 }]) {
      const f = accept({}, ctx);
      expect(await go(f)).toBe("accepted");
      expect(f.calls.length).toBe(1);
    }
  });
  test("a failed accept is still a tool error", async () => {
    const f = fake({ "POST /handoffs/h_0123456789abcdef/accept": { status: 409, body: { error: "nope" } } });
    await expect(go(f)).rejects.toThrow("accept_handoff failed: 409 nope");
  });
});

describe("transition_ticket", () => {
  test("ok", async () => {
    const f = fake({ [`POST /tickets/${TID}/transition`]: { status: 200 } });
    expect(await run("transition_ticket", f.host, { ticket_id: TID, to: "in_review", note: "built and tested" })).toContain("in_review");
    expect(f.calls[0].body).toEqual({ by: "alice", to: "in_review", note: "built and tested" });
  });
  test("blocked done requests approval and reports the id", async () => {
    const f = fake({
      [`POST /tickets/${TID}/transition`]: { status: 409, body: { error: "approval", approval_request_id: null } },
      [`POST /tickets/${TID}/approval`]: { status: 200, body: { request_id: "p_1", created: true } },
    });
    const text = await run("transition_ticket", f.host, { ticket_id: TID, to: "done" });
    expect(text).toContain("approval_request_id=p_1");
  });
  test("the human allowed in between: the approval call returns the allowed request and the move is retried once", async () => {
    const f = fake({
      [`POST /tickets/${TID}/transition`]: [
        { status: 409, body: { error: "approval", approval_request_id: "p_1" } },
        { status: 200 },
      ],
      [`POST /tickets/${TID}/approval`]: { status: 200, body: { request_id: "p_1", created: false, status: "allowed" } },
    });
    const text = await run("transition_ticket", f.host, { ticket_id: TID, to: "done" });
    expect(text).toContain(`ticket ${TID} is now done`);
    expect(text).toContain("p_1");
    expect(f.calls.map((c) => c.key)).toEqual([
      `POST /tickets/${TID}/transition`, `POST /tickets/${TID}/approval`, `POST /tickets/${TID}/transition`,
    ]);
  });
  test("the retry that fails again is an error, and the move is tried only twice", async () => {
    const f = fake({
      [`POST /tickets/${TID}/transition`]: { status: 409, body: { error: "approval", approval_request_id: "p_1" } },
      [`POST /tickets/${TID}/approval`]: { status: 200, body: { request_id: "p_1", created: false, status: "allowed" } },
    });
    await expect(run("transition_ticket", f.host, { ticket_id: TID, to: "done" })).rejects.toThrow("retry after the human's approval failed: 409");
    expect(f.calls.filter((c) => c.key.endsWith("/transition")).length).toBe(2);
  });
  test("a pending request (created:false) is not retried: the agent waits", async () => {
    const f = fake({
      [`POST /tickets/${TID}/transition`]: { status: 409, body: { error: "approval", approval_request_id: "p_1" } },
      [`POST /tickets/${TID}/approval`]: { status: 200, body: { request_id: "p_1", created: false, status: "pending" } },
    });
    const text = await run("transition_ticket", f.host, { ticket_id: TID, to: "done" });
    expect(text).toContain("approval_request_id=p_1");
    expect(text).toContain("Wait for the human");
    expect(f.calls.filter((c) => c.key.endsWith("/transition")).length).toBe(1);
  });
  test("a plain 409 is an error, no approval call", async () => {
    const f = fake({ [`POST /tickets/${TID}/transition`]: { status: 409, body: { error: "wrong state" } } });
    await expect(run("transition_ticket", f.host, { ticket_id: TID, to: "done" })).rejects.toThrow("409 wrong state");
    expect(f.calls.length).toBe(1);
  });
});

describe("transition_ticket notes", () => {
  const send = (f: ReturnType<typeof fake>, args: Record<string, unknown>) => run("transition_ticket", f.host, { ticket_id: TID, ...args });

  test("a move to in_review without a note fails before any request", async () => {
    const f = fake({});
    for (const note of [undefined, "", "   ", 5]) {
      await expect(send(f, { to: "in_review", note })).rejects.toThrow("needs `note`");
    }
    expect(f.calls).toEqual([]);
  });

  test("a move to in_review sends the trimmed note", async () => {
    const f = fake({ [`POST /tickets/${TID}/transition`]: { status: 200 } });
    expect(await send(f, { to: "in_review", note: "  Built X in a.ts. Tested with b.test.ts: 5 pass.  " })).toContain("in_review");
    expect(f.calls[0].body).toEqual({ by: "alice", to: "in_review", note: "Built X in a.ts. Tested with b.test.ts: 5 pass." });
  });

  test("other moves need no note, and send one only when given", async () => {
    const f = fake({ [`POST /tickets/${TID}/transition`]: { status: 200 } });
    await send(f, { to: "in_progress" });
    expect(f.calls[0].body).toEqual({ by: "alice", to: "in_progress" });
    await send(f, { to: "cancelled", note: "obsolete" });
    expect(f.calls[1].body).toEqual({ by: "alice", to: "cancelled", note: "obsolete" });
  });

  test("a hub refusal of the note is a tool error with the hub's message", async () => {
    const f = fake({ [`POST /tickets/${TID}/transition`]: { status: 400, body: { error: "note too long (max 4096 bytes)" } } });
    await expect(send(f, { to: "in_review", note: "x" })).rejects.toThrow("400 note too long");
  });

  test("the schema offers note (max 4096) and the description names the audit trail", () => {
    const tool = findTool("transition_ticket")!;
    const props = (tool.inputSchema as { properties: Record<string, { maxLength?: number }>; required: string[] }).properties;
    expect(props.note.maxLength).toBe(4096);
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["ticket_id", "to"]);
    expect(tool.description).toContain("audit trail");
    expect(tool.description).toContain("does not replace your chatbridge messages");
  });

  test("the retry after the human's approval carries the same note", async () => {
    const f = fake({
      [`POST /tickets/${TID}/transition`]: { status: 409, body: { error: "approval", approval_request_id: null } },
      [`POST /tickets/${TID}/approval`]: { status: 200, body: { request_id: "p_1", created: false, status: "allowed" } },
    });
    // first call blocked, the approval says allowed, the retry is the same move (here it hits the same blocked route)
    await expect(send(f, { to: "done", note: "ok" })).rejects.toThrow();
    expect(f.calls[0].body).toEqual({ by: "alice", to: "done", note: "ok" });
    expect(f.calls[2].body).toEqual({ by: "alice", to: "done", note: "ok" });
  });
});

describe("create_ticket and list_tickets", () => {
  test("create returns the id and sends no room", async () => {
    const f = fake({ "POST /tickets": { status: 201, body: { snapshot: { id: TID } } } });
    const text = await run("create_ticket", f.host, { title: "t", acceptance_criteria: "c", blast_radius: "low" });
    expect(text).toBe(`ticket_id=${TID}`);
    expect(f.calls[0].body).toEqual({ by: "alice", title: "t", acceptance_criteria: "c", blast_radius: "low" });
  });
  test("create_ticket sends the assignee only when given", async () => {
    const f = fake({ "POST /tickets": { status: 201, body: { snapshot: { id: TID } } } });
    await run("create_ticket", f.host, { title: "t", acceptance_criteria: "c", blast_radius: "low", assignee: "bob" });
    expect(f.calls[0].body).toMatchObject({ assignee: "bob" });
    await run("create_ticket", f.host, { title: "t", acceptance_criteria: "c", blast_radius: "low" });
    expect("assignee" in f.calls[1].body).toBe(false);
    expect(Object.keys((findTool("create_ticket")!.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("assignee");
  });

  test("assign_ticket posts the assign verb as the agent; null or empty unassigns", async () => {
    const f = fake({ [`POST /tickets/${TID}/assign`]: { status: 200, body: { snapshot: {} } } });
    expect(await run("assign_ticket", f.host, { ticket_id: TID, assignee: "bob" })).toBe(`ticket ${TID} is assigned to bob`);
    expect(f.calls[0].body).toEqual({ by: "alice", assignee: "bob" });
    expect(await run("assign_ticket", f.host, { ticket_id: TID, assignee: null })).toBe(`ticket ${TID} is unassigned`);
    expect(f.calls[1].body).toEqual({ by: "alice", assignee: null });
    await run("assign_ticket", f.host, { ticket_id: TID, assignee: "" });
    expect(f.calls[2].body).toEqual({ by: "alice", assignee: null });
  });

  test("assign_ticket reports a refusal as a tool error and encodes the id", async () => {
    const evil = "../permissions/x/verdict";
    const f = fake({
      [`POST /tickets/${TID}/assign`]: { status: 403, body: { error: "only the human, the creator or the room lead may assign" } },
      [`POST /tickets/${encodeURIComponent(evil)}/assign`]: { status: 200 },
    });
    await expect(run("assign_ticket", f.host, { ticket_id: TID, assignee: "bob" })).rejects.toThrow("403 only the human");
    await run("assign_ticket", f.host, { ticket_id: evil, assignee: "bob" });
    expect(f.calls[1].key).toBe(`POST /tickets/${encodeURIComponent(evil)}/assign`);
  });

  test("assign_ticket takes a string or null assignee in its schema", () => {
    const s = findTool("assign_ticket")!.inputSchema as { properties: { assignee: { type: unknown } }; required: string[] };
    expect(s.properties.assignee.type).toEqual(["string", "null"]);
    expect(s.required).toEqual(["ticket_id", "assignee"]);
  });

  test("list uses the context room, defaults to open", async () => {
    const f = fake({
      "GET /tickets?room=my%20room&status=open": {
        status: 200,
        body: [{ id: TID, title: "x", status: "queued", priority: "high", blast_radius: "low", assignee: null, acceptance_criteria: "c" }],
      },
    });
    const text = await run("list_tickets", f.host, {}, "my room");
    expect(text).toContain(`${TID} [queued] priority high, low radius, unassigned: x`);
  });
  test("a room argument is ignored: the tool always lists the caller's own room", async () => {
    const f = fake({
      "GET /tickets?room=mine&status=open": { status: 200, body: [] },
    });
    expect(await run("list_tickets", f.host, { room: "other-room" }, "mine")).toBe("no tickets");
    expect(f.calls.map((c) => c.key)).toEqual(["GET /tickets?room=mine&status=open"]);
  });

  test("the list_tickets schema offers no room argument", () => {
    const props = (findTool("list_tickets")!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["status"]);
  });

  test("list_tickets shows the note and file counts only when a ticket has some", async () => {
    const base = { status: "queued", priority: "high", blast_radius: "low", assignee: null, acceptance_criteria: "c" };
    const f = fake({
      "GET /tickets?room=r&status=open": {
        status: 200,
        body: [{ id: TID, title: "x", ...base, notes_count: 2, attachments_count: 1 }, { id: "t_1111111111111111", title: "y", ...base, notes_count: 0, attachments_count: 0 }, { id: "t_2222222222222222", title: "z", ...base }],
      },
    });
    const lines = (await run("list_tickets", f.host, {}, "r")).split("\n");
    expect(lines[1]).toBe("  done when: c");
    expect(lines[2]).toBe("  2 notes, 1 files");
    expect(lines.filter((l) => /notes,/.test(l))).toHaveLength(1);                 // none for the tickets with no notes or files
  });

  test("list without any room is an error", async () => {
    await expect(run("list_tickets", fake({}).host, {})).rejects.toThrow("room is required");
  });
});

describe("ticket ids are path-encoded", () => {
  const evil = "../permissions/x/verdict";
  const enc = encodeURIComponent(evil);
  test("claim, transition and approval send an encoded id", async () => {
    const f = fake({
      [`POST /tickets/${enc}/claim`]: { status: 200 },
      [`POST /tickets/${enc}/transition`]: { status: 409, body: { error: "a", approval_request_id: null } },
      [`POST /tickets/${enc}/approval`]: { status: 200, body: { request_id: "p" } },
    });
    await run("claim_ticket", f.host, { ticket_id: evil });
    await run("transition_ticket", f.host, { ticket_id: evil, to: "done" });
    expect(f.calls.map((c) => c.key)).toEqual([
      `POST /tickets/${enc}/claim`,
      `POST /tickets/${enc}/transition`,
      `POST /tickets/${enc}/approval`,
    ]);
  });
  test("accept_handoff claim encodes a ticket_id from the handoff context", async () => {
    const f = accept({ [`POST /tickets/${enc}/claim`]: { status: 200 } }, { ticket_id: evil });
    await run("accept_handoff", f.host, { handoff_id: "h_0123456789abcdef" });
    expect(f.calls[1].key).toBe(`POST /tickets/${enc}/claim`);
  });
});

describe("attach_ticket_file", () => {
  const UP = { status: 200, body: { url: "/image/abc123.pdf", path: "/Users/x/cubilot-attachments/abc123.pdf" } };
  const attach = (f: ReturnType<typeof fake>, args: Record<string, unknown> = {}) =>
    run("attach_ticket_file", f.host, { ticket_id: TID, path: "/tmp/report.pdf", ...args });

  test("uploads the file, then links it with the file's own name, as the agent", async () => {
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 201, body: {} } });
    const text = await attach(f);
    expect(f.calls.map((c) => c.key)).toEqual(["UPLOAD /upload", `POST /tickets/${TID}/attachments`]);
    expect(f.calls[0].body).toBe("/tmp/report.pdf");
    expect(f.calls[1].body).toEqual({ by: "alice", url: "/image/abc123.pdf", name: "report.pdf" });
    expect(text).toContain("attached report.pdf");
    expect(text).toContain("/Users/x/cubilot-attachments/abc123.pdf");           // the path the agent can read
  });

  test("a 250-character file name is cut to 200 characters before the upload, keeping the extension", async () => {
    const long = `${"x".repeat(246)}.pdf`;                                           // 250 characters
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 201 } });
    await attach(f, { path: `/tmp/${long}` });
    const name = f.calls[1].body.name as string;
    expect(name.length).toBe(200);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name.startsWith("xxxx")).toBe(true);
  });

  test("the name is one line: whitespace, control and bidi characters collapse; a name that is nothing falls back to file", async () => {
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 201 } });
    await attach(f, { path: "/tmp/a.pdf", caption: "  Test\nreport\u202e\ttwo  " });
    expect(f.calls[1].body.name).toBe("Test report two");
    await attach(f, { path: "/tmp/\u202e\u0001.pdf", caption: "" });
    expect(f.calls[3].body.name).toBe(".pdf");
    await attach(f, { path: "/tmp/\u202e", caption: "" });
    expect(f.calls[5].body.name).toBe("file");
  });

  test("attachmentName: a name of exactly 200 is kept; a long name without a usable extension is cut; a long caption is cut too", async () => {
    const { attachmentName } = await import("../../hub/channel/tools");
    expect(attachmentName("a".repeat(195) + ".json")).toBe("a".repeat(195) + ".json");
    expect(attachmentName("b".repeat(300))).toBe("b".repeat(200));
    expect(attachmentName("c".repeat(300) + "." + "z".repeat(30))).toHaveLength(200);        // an absurd extension is not kept
    expect(attachmentName("d".repeat(250) + ".jpeg").endsWith(".jpeg")).toBe(true);
    expect(attachmentName("e".repeat(250) + ".jpeg")).toHaveLength(200);
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 201 } });
    await attach(f, { path: "/tmp/a.pdf", caption: "k".repeat(200) });
    expect(f.calls[1].body.name).toHaveLength(200);
  });

  test("a caption is the name shown on the ticket", async () => {
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 201 } });
    await attach(f, { caption: "  Test report, run 3  " });
    expect(f.calls[1].body.name).toBe("Test report, run 3");
  });

  test("a file that is already attached says so (200 idempotent)", async () => {
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 200, body: { idempotent: true } } });
    expect(await attach(f)).toContain("(it was already attached)");
  });

  test("a refused upload (type or size) is a tool error and nothing is linked", async () => {
    const f = fake({ "UPLOAD /upload": { status: 400, body: { error: "extension .exe is not allowed" } } });
    await expect(attach(f, { path: "/tmp/x.exe" })).rejects.toThrow("attach_ticket_file upload failed: 400 extension .exe is not allowed");
    expect(f.calls.map((c) => c.key)).toEqual(["UPLOAD /upload"]);
  });

  test("a refused link (not the assignee, wrong room) is a tool error with the hub's message", async () => {
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${TID}/attachments`]: { status: 403, body: { error: "only the human, the creator or the assignee may attach a file" } } });
    await expect(attach(f)).rejects.toThrow("403 only the human, the creator or the assignee");
  });

  test("a missing path fails before any request; an upload with no url is an error", async () => {
    const f = fake({});
    await expect(attach(f, { path: "  " })).rejects.toThrow("path is required");
    expect(f.calls).toEqual([]);
    const g = fake({ "UPLOAD /upload": { status: 200, body: {} } });
    await expect(attach(g)).rejects.toThrow("returned no url");
  });

  test("the ticket id is path-encoded", async () => {
    const evil = "../permissions/x/verdict";
    const f = fake({ "UPLOAD /upload": UP, [`POST /tickets/${encodeURIComponent(evil)}/attachments`]: { status: 201 } });
    await attach(f, { ticket_id: evil });
    expect(f.calls[1].key).toBe(`POST /tickets/${encodeURIComponent(evil)}/attachments`);
  });

  test("post_file and the instructions name txt among the default types", async () => {
    expect(findTool("post_file")!.description).toContain("jpg, jpeg, png, pdf, md, txt");
    const instr = await Bun.file("hub/channel/instructions.json").text();
    expect(instr).toContain("(default: jpg, jpeg, png, pdf, md, txt)");
    expect(instr).not.toContain("(default: jpg, jpeg, png, pdf, md)");
  });

  test("the schema asks for ticket_id and path, offers an optional caption, and names the allowed types", () => {
    const tool = findTool("attach_ticket_file")!;
    const s = tool.inputSchema as { properties: Record<string, { maxLength?: number }>; required: string[] };
    expect(s.required).toEqual(["ticket_id", "path"]);
    expect(s.properties.caption.maxLength).toBe(200);
    for (const ext of ["pdf", "md", "txt", "png", "jpg", "jpeg"]) expect(tool.description).toContain(ext);
    expect(tool.description).toContain("creator");
  });
});

describe("a paused agent (hub answers 423)", () => {
  const LINE = "You are paused by the human; wait until the human resumes you";
  const paused = { status: 423, body: { error: "agent is paused" } };
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["post", "POST /post", { to: "all", text: "hi" }, "post"],
    ["send_handoff", "POST /handoffs", { to: "bob", task: "t", context: {} }, "send_handoff"],
    ["send_interrupt", "POST /interrupts", { to: "bob", text: "stop" }, "send_interrupt"],
    ["create_ticket", "POST /tickets", { title: "t", acceptance_criteria: "c", blast_radius: "low" }, "create_ticket"],
    ["claim_ticket", `POST /tickets/${TID}/claim`, { ticket_id: TID }, "claim_ticket"],
    ["transition_ticket", `POST /tickets/${TID}/transition`, { ticket_id: TID, to: "in_progress" }, "transition_ticket"],
    ["assign_ticket", `POST /tickets/${TID}/assign`, { ticket_id: TID, assignee: "bob" }, "assign_ticket"],
    ["edit_ticket", `POST /tickets/${TID}/edit`, { ticket_id: TID, title: "t" }, "edit_ticket"],
  ];
  for (const [name, key, args, action] of cases) {
    test(`${name}: one clear line, one request, no retry`, async () => {
      const f = fake({ [key]: paused });
      await expect(run(name, f.host, args)).rejects.toThrow(`${action} failed: ${LINE}`);
      expect(f.calls.filter((c) => c.key === key).length).toBe(1);
    });
  }
  test("the hub error text is not shown", async () => {
    const f = fake({ "POST /post": paused });
    await expect(run("post", f.host, { to: "all", text: "hi" })).rejects.not.toThrow("agent is paused");
  });
  test("accept_handoff names the paused state when the claim is refused", async () => {
    const f = accept({ [`POST /tickets/${TID}/claim`]: paused });
    expect(await run("accept_handoff", f.host, { handoff_id: "h_0123456789abcdef" })).toContain(LINE);
  });
});

describe("edit_ticket", () => {
  test("posts only the given fields as the agent", async () => {
    const f = fake({ [`POST /tickets/${TID}/edit`]: { status: 200, body: { snapshot: {} } } });
    expect(await run("edit_ticket", f.host, { ticket_id: TID, title: "New", acceptance_criteria: "C" })).toBe(`ticket ${TID} is edited`);
    expect(f.calls[0].body).toEqual({ by: "alice", title: "New", acceptance_criteria: "C" });
  });
  test("an unchanged edit says so", async () => {
    const f = fake({ [`POST /tickets/${TID}/edit`]: { status: 200, body: { idempotent: true } } });
    expect(await run("edit_ticket", f.host, { ticket_id: TID, title: "Same" })).toBe(`ticket ${TID} is unchanged`);
  });
  test("a 403 for blast_radius is a tool error", async () => {
    const f = fake({ [`POST /tickets/${TID}/edit`]: { status: 403, body: { error: "only the human may change blast_radius" } } });
    await expect(run("edit_ticket", f.host, { ticket_id: TID, blast_radius: "low" })).rejects.toThrow("403 only the human may change blast_radius");
  });
  test("the schema requires only ticket_id and limits blast_radius to low or high", () => {
    const s = findTool("edit_ticket")!.inputSchema as { properties: { blast_radius: { enum: string[] } }; required: string[] };
    expect(s.required).toEqual(["ticket_id"]);
    expect(s.properties.blast_radius.enum).toEqual(["low", "high"]);
  });
});
