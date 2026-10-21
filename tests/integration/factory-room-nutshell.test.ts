// New factory room seeds its Nutshell (task 6.3) through the handoff primitive, exactly like the Nutshell editor:
// the human sends a "[nutshell]" handoff to the human and accepts it. Only when the room has no Nutshell.
// The request shapes come from the UI module itself (ui/terminal/factory-room.js), run here without a DOM.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, registerAgent } from "../helpers/fetch";

const win: any = {};
new Function("window", readFileSync("ui/terminal/factory-room.js", "utf8"))(win);
const { nutshellTemplate, nutshellSeedRequests } = win.__CUBILOT_TERM__.factoryRoom;

async function seed(hub: HubHandle, room: string, cwd: string): Promise<boolean> {
  const cur = (await getJson(hub, `/nutshell?room=${encodeURIComponent(room)}`)).json as any;
  const req = nutshellSeedRequests(room, cwd, hub.humanName, cur?.text);
  if (!req) return false;
  const made = await authedFetch(hub, "/handoffs", { method: "POST", body: JSON.stringify(req.create) });
  expect(made.status).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const a = req.accept(id);
  const done = await authedFetch(hub, `/handoffs/${a.id}/accept`, { method: "POST", body: JSON.stringify(a.body) });
  expect(done.status).toBe(200);
  return true;
}

describe("New factory room Nutshell", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("the template has the five fields, with the known ones filled in", () => {
    const t = nutshellTemplate("acme", "/work/acme");
    for (const f of ["Product:", "Repo: /work/acme", "Branch policy:", "Style guide:", "Definition of done:"]) {
      expect(t).toContain(f);
    }
    expect(t.split("\n")).toHaveLength(5);
    expect(t.match(/<TODO/g)!.length).toBe(4);
  });

  test("a new room gets the Nutshell, and the orchestrator's first briefing contains it", async () => {
    expect(((await getJson(hub, "/nutshell?room=acme")).json as any).text).toBe("");
    expect(await seed(hub, "acme", "/work/acme")).toBe(true);
    const n = (await getJson(hub, "/nutshell?room=acme")).json as any;
    expect(n.text).toBe(nutshellTemplate("acme", "/work/acme"));
    expect(n.version).toBe(1);
    expect(n.room).toBe("acme");
    // the orchestrator connects after the seed: its briefing carries the Nutshell
    const orch = await registerAgent(hub, "orchestrator-acme", { room: "acme" });
    const briefing = await orch.firstEvent;
    orch.close();
    expect(briefing.type).toBe("briefing");
    expect(briefing.room).toBe("acme");
    expect(briefing.nutshell).toContain("Repo: /work/acme");
    expect(briefing.nutshell).toContain("Definition of done:");
  });

  test("the seed goes to its own room only", async () => {
    expect(((await getJson(hub, "/nutshell?room=other")).json as any).text).toBe("");
  });

  test("a room that already has a Nutshell is never overwritten", async () => {
    // the human writes one by hand through the same primitive
    const made = await authedFetch(hub, "/handoffs", {
      method: "POST",
      body: JSON.stringify({ from: "human", to: "human", task: "[nutshell] human edit", context: { patch: "mine", room: "kept" }, ttl_seconds: 3600 }),
    });
    const { id } = (await made.json()) as { id: string };
    await authedFetch(hub, `/handoffs/${id}/accept`, { method: "POST", body: JSON.stringify({ by: "human" }) });
    expect(await seed(hub, "kept", "/work/kept")).toBe(false);
    expect(((await getJson(hub, "/nutshell?room=kept")).json as any).text).toBe("mine");
    // and a second seed of the seeded room is a no-op too
    expect(await seed(hub, "acme", "/work/acme")).toBe(false);
    expect(((await getJson(hub, "/nutshell?room=acme")).json as any).version).toBe(1);
  });
});
