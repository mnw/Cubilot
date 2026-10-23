// Draft tickets over the real hub, seen through the bridge's delivery policy (modeFor): a bridge on the
// assignee and a bridge on the room lead. A draft wakes no one; draft -> queued wakes the assignee once
// (also when it created the ticket), or the lead for an unassigned ticket unless the lead made the move.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { openSSE, postJson } from "../helpers/fetch";
import { modeFor } from "../../hub/channel/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOM = "dw";

type Bridge = { agent: string; wakes: (id: string) => string[]; close: () => void };

// One bridge per agent: tail /agent-stream and keep the ticket events modeFor would wake on.
function bridge(hub: HubHandle, agent: string): Bridge {
  const sse = openSSE(hub, `/agent-stream?agent=${agent}&room=${ROOM}`);
  const woke: Array<{ kind: string; id: string }> = [];
  (async () => {
    try {
      for await (const e of sse.events) {
        if (typeof e.kind === "string" && e.kind.startsWith("ticket.") && modeFor(e, agent) === "wake") {
          woke.push({ kind: e.kind, id: e.snapshot?.id ?? e.ticket_id });
        }
      }
    } catch {}
  })();
  return { agent, wakes: (id) => woke.filter((w) => w.id === id).map((w) => w.kind), close: sse.close };
}

describe("draft tickets and wakes", () => {
  let hub: HubHandle;
  let bob: Bridge, lee: Bridge, carol: Bridge;

  beforeAll(async () => {
    hub = await spawnHub();
    bob = bridge(hub, "dw-bob");       // an assignee
    lee = bridge(hub, "dw-lee");       // the room lead
    carol = bridge(hub, "dw-carol");   // a creator
    await sleep(300);
    expect((await postJson(hub, `/rooms/${ROOM}/lead`, { by: hub.humanName, agent: "dw-lee" })).status).toBe(200);
  });
  afterAll(async () => {
    bob.close(); lee.close(); carol.close();
    await hub.kill();
  });

  const create = async (by: string, extra: Record<string, unknown>) => {
    const r = await postJson(hub, "/tickets", { by, title: "t", acceptance_criteria: "c", blast_radius: "low", ...extra });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const move = (id: string, by: string, to: string) => postJson(hub, `/tickets/${id}/transition`, { by, to });

  test("a draft wakes no one; the move to queued wakes the assignee once; a retry wakes no one again", async () => {
    const id = await create("dw-carol", { status: "draft", assignee: "dw-bob" });
    await sleep(300);
    expect(bob.wakes(id)).toEqual([]);
    expect(lee.wakes(id)).toEqual([]);
    expect((await move(id, hub.humanName, "queued")).status).toBe(200);
    await sleep(300);
    expect(bob.wakes(id)).toEqual(["ticket.promoted"]);
    expect(lee.wakes(id)).toEqual([]);                     // assigned: the lead is not woken
    await move(id, hub.humanName, "queued");               // retry: the ticket is already queued
    await sleep(300);
    expect(bob.wakes(id)).toEqual(["ticket.promoted"]);    // no second wake
  });

  test("the assignee wakes when it created the ticket itself", async () => {
    const id = await create("dw-bob", { status: "draft", assignee: "dw-bob" });
    await sleep(300);
    expect(bob.wakes(id)).toEqual([]);
    expect((await move(id, hub.humanName, "queued")).status).toBe(200);
    await sleep(300);
    expect(bob.wakes(id)).toEqual(["ticket.promoted"]);
  });

  test("an unassigned draft wakes the lead when the human promotes it, not when the lead does", async () => {
    const byHuman = await create("dw-carol", { status: "draft" });
    const byLead = await create("dw-carol", { status: "draft" });
    await sleep(300);
    expect(lee.wakes(byHuman)).toEqual([]);
    expect(lee.wakes(byLead)).toEqual([]);                 // a draft wakes not even the lead
    expect((await move(byHuman, hub.humanName, "queued")).status).toBe(200);
    expect((await move(byLead, "dw-lee", "queued")).status).toBe(200);
    await sleep(300);
    expect(lee.wakes(byHuman)).toEqual(["ticket.promoted"]);
    expect(lee.wakes(byLead)).toEqual([]);                 // the lead made this move itself
    expect(bob.wakes(byHuman)).toEqual([]);
  });

  test("a draft cannot be claimed", async () => {
    const id = await create("dw-carol", { status: "draft" });
    expect((await postJson(hub, `/tickets/${id}/claim`, { by: "dw-bob" })).status).toBe(409);
  });
});
