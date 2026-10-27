// human-review-room: a human spec review with N named tickets loads them with ONE ticket query (room check and scope check share the rows).
// The handoff route runs in-process on a counting db handle, like tests/unit/stage-final-pass.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createHandoffKind } from "../../hub/kinds/handoff";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities } from "../../hub/core/types";

function makeEnv() {
  const raw = new Database(":memory:");
  migrateLedger(raw);
  const ticketKind = createTicketKind(raw);
  ticketKind.migrate(raw);
  const rt = createStageRuntime(raw, { ackMs: 60_000 });
  rt.module.migrate(raw);
  const ticketQueries: string[] = [];
  let counting = false;
  const db = new Proxy(raw, {
    get(target, prop) {
      if (prop === "query") {
        return (sql: string) => {
          if (counting && /\bFROM\s+tickets\b/i.test(sql)) ticketQueries.push(sql);
          return target.query(sql);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Database;
  const handoffKind = createHandoffKind(db, rt.hooks);
  handoffKind.migrate(db);
  const cap = {
    db,
    sse: { emit: (_e: Entry) => {} },
    briefing: { refresh: () => {} },
    agents: {
      get: (n: string) => (n === "human" ? { name: n, permanent: true, room: null } : undefined),
      isPermanent: (n: string) => n === "human",
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human", defaultRoom: "default" },
  } as unknown as HubCapabilities;
  const draft = (n: number) => {
    const id = `t_${n.toString(16).padStart(16, "0")}`;
    raw.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', NULL, 'draft', 'req-q', ?, ?, 1)`,
      [id, n, n],
    );
    return id;
  };
  const send = async (ticket_ids: string[]) => {
    const route = handoffKind.routes.find((r) => r.method === "POST" && r.path === "/handoffs")!;
    ticketQueries.length = 0;
    counting = true;
    const res = await route.handler(
      new Request("http://hub.test/handoffs", {
        method: "POST",
        body: JSON.stringify({ from: "human", to_role: "validator", review: "spec", request_id: "req-q", task: "review", context: { request_text: "Build X", ticket_ids } }),
        headers: { "Content-Type": "application/json" },
      }),
      cap,
      {},
    );
    counting = false;
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { raw, draft, send, ticketQueries };
}

describe("human spec review ticket queries", () => {
  test("3 named tickets: accepted with one ticket query", async () => {
    const e = makeEnv();
    const ids = [e.draft(1), e.draft(2), e.draft(3)];
    const r = await e.send(ids);
    expect(r.status).toBe(201);
    expect(e.ticketQueries.length).toBe(1);
  });

  test("3 named tickets, one unknown: 400 with one ticket query, nothing recorded", async () => {
    const e = makeEnv();
    const ids = [e.draft(1), e.draft(2), "t_00000000000000ff"];
    const r = await e.send(ids);
    expect(r.status).toBe(400);
    expect(e.ticketQueries.length).toBe(1);
    expect(e.raw.query("SELECT COUNT(*) AS n FROM handoffs").get()).toEqual({ n: 0 });
  });
});
