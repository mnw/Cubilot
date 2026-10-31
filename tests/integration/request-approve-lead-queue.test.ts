// L1: after the human's Approve of a request, the room lead may queue any ticket of that request.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubHandle } from "../helpers/hub";
import { postJson, registerAgent } from "../helpers/fetch";

const HUMAN_TOKEN = "hum-lead-queue-token-0123456789";
const TOKEN = `l1-${Math.random().toString(36).slice(2, 10)}`;
const base = mkdtempSync(join(tmpdir(), "cubilot-l1-"));
const ledgerPath = join(base, "ledger.db");
const attachmentsDir = join(base, "attachments");
mkdirSync(attachmentsDir, { recursive: true });

async function spawn(): Promise<HubHandle> {
  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env,
      PORT: "0",
      CUBILOT_TOKEN: TOKEN,
      CUBILOT_LEDGER_DB: ledgerPath,
      CUBILOT_ATTACHMENTS_DIR: attachmentsDir,
      CUBILOT_TRANSCRIPTS_DIR: join(base, "transcripts"),
      CUBILOT_DATA_DIR: join(base, "data"),
      CUBILOT_HUMAN_NAME: "human",
      CUBILOT_DEFAULT_ROOM: "default",
      CUBILOT_ALLOWED_EXTENSIONS: "jpg,jpeg,png,pdf,md,txt,json",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(`${HUMAN_TOKEN}\n`);
  proc.stdin.end();
  const decoder = new TextDecoder();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  let url = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
    if (m) { url = m[1]; break; }
  }
  reader.releaseLock();
  if (!url) { proc.kill(); throw new Error("hub did not announce a port"); }
  return {
    url, token: TOKEN, humanToken: HUMAN_TOKEN, pid: proc.pid, ledgerPath, attachmentsDir, transcriptsDir: join(base, "transcripts"), humanName: "human",
    kill: async () => { proc.kill(); await proc.exited; },
  };
}

describe("request approve: the lead queues after the human's Approve", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawn();
    open.push(await registerAgent(hub, "lq-lead", { room: "lq" }));
    open.push(await registerAgent(hub, "lq-worker", { room: "lq" }));
    expect((await postJson(hub, "/rooms/lq/lead", { by: "human", agent: "lq-lead" })).status).toBe(200);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };
  const mk = async (request_id: string | undefined, blast_radius: string, status = "draft") => {
    const r = await postJson(hub, "/tickets", { by: "lq-worker", title: "T", acceptance_criteria: "c", blast_radius, status, ...(request_id ? { request_id } : {}) });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const move = (id: string, by: string, to: string) => postJson(hub, `/tickets/${id}/transition`, { by, to });
  const approve = (request: string, by: string) => postJson(hub, `/requests/lq/${request}/approve`, { by });

  test("lead queues after approve", async () => {
    const high = await mk("l1-a", "high");
    const low = await mk("l1-a", "low");
    expect((await approve("l1-a", "human")).status).toBe(200);
    // The approve queued both. Send them back to draft as the lead does after an edit, then queue again.
    expect((await move(high, "lq-lead", "draft")).status).toBe(200);
    expect((await move(high, "lq-lead", "queued")).status).toBe(200);
    expect((await move(low, "lq-lead", "draft")).status).toBe(200);
    expect((await move(low, "lq-lead", "queued")).status).toBe(200);
    expect(rows("SELECT status FROM tickets WHERE id = ?", high)[0].status).toBe("queued");
  });

  test("lead refused before approve", async () => {
    const high = await mk("l1-b", "high");
    const r = await move(high, "lq-lead", "queued");
    expect(r.status).toBe(403);
    expect(rows("SELECT status FROM tickets WHERE id = ?", high)[0].status).toBe("draft");
    // A request with no high ticket keeps today's rule: the lead queues it with no Approve.
    const low = await mk("l1-b-low", "low");
    expect((await move(low, "lq-lead", "queued")).status).toBe(200);
  });

  test("new ticket after approve", async () => {
    await mk("l1-c", "high");
    expect((await approve("l1-c", "human")).status).toBe(200);
    const later = await mk("l1-c", "high");
    expect((await move(later, "lq-lead", "queued")).status).toBe(200);
    // Another request in the same room is not approved.
    const other = await mk("l1-c-other", "high");
    expect((await move(other, "lq-lead", "queued")).status).toBe(403);
  });

  test("approve stores one event and one row", async () => {
    await mk("l1-d", "high");
    const before = rows("SELECT COUNT(*) AS n FROM events WHERE kind = 'request.approved'")[0].n;
    expect((await approve("l1-d", "human")).status).toBe(200);
    expect((await approve("l1-d", "human")).status).toBe(200);
    expect(rows("SELECT COUNT(*) AS n FROM events WHERE kind = 'request.approved'")[0].n).toBe(before + 1);
    expect(rows("SELECT * FROM request_approvals WHERE room = 'lq' AND request_id = 'l1-d'")).toHaveLength(1);
  });

  test("approve survives restart", async () => {
    const high = await mk("l1-e", "high");
    expect((await approve("l1-e", "human")).status).toBe(200);
    expect((await move(high, "lq-lead", "draft")).status).toBe(200);
    for (const c of open) c.close();
    open.length = 0;
    await hub.kill();
    hub = await spawn();
    open.push(await registerAgent(hub, "lq-lead", { room: "lq" }));
    open.push(await registerAgent(hub, "lq-worker", { room: "lq" }));
    expect((await move(high, "lq-lead", "queued")).status).toBe(200);
  });

  test("agent cannot approve", async () => {
    const high = await mk("l1-f", "high");
    for (const who of ["lq-lead", "lq-worker"]) expect((await approve("l1-f", who)).status).toBe(403);
    expect((await move(high, "lq-lead", "queued")).status).toBe(403);
    expect(rows("SELECT COUNT(*) AS n FROM request_approvals WHERE request_id = 'l1-f'")[0].n).toBe(0);
  });
});
