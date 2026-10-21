// The Allow race through the real hub and the real transition_ticket tool: the human allows the
// pending request between the blocked move and the approval call. One request, and done.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";
import { nodeHost } from "../../hub/channel/node-host";
import { findTool } from "../../hub/channel/tools";
import type { Host } from "../../hub/channel/host";

describe("transition_ticket with the Allow landing mid-call", () => {
  let hub: HubHandle;
  let bob: Awaited<ReturnType<typeof registerAgent>>;
  beforeAll(async () => {
    hub = await spawnHub();
    bob = await registerAgent(hub, "bob", { room: "r1" });
  });
  afterAll(async () => { bob.close(); await hub.kill(); });

  // A host for the real tool: the real fetch, the token from the test hub, and a hook that runs
  // after the first blocked `done` answer and before the tool's next call.
  function hostWith(afterBlockedDone: () => Promise<void>): Host {
    const real = nodeHost(async () => {});
    let fired = false;
    return {
      ...real,
      readText: async (p: string) => (p.endsWith("hub.token") ? hub.token : null),
      request: async (url, init) => {
        const r = await real.request(url, init);
        if (!fired && url.endsWith("/transition") && r.status === 409) {
          fired = true;
          await afterBlockedDone();
        }
        return r;
      },
    };
  }
  const tool = (host: Host, id: string) =>
    findTool("transition_ticket")!
      .handler({ agent: "bob", hubEnv: hub.url, host, room: "r1" }, { ticket_id: id, to: "done" })
      .then((r) => r.content[0].text);
  const pendingFor = async (id: string) =>
    ((await getJson(hub, `/permissions?status=all&token=${hub.token}`)).json as Array<{ id: string; tool_name: string; input_preview: string }>)
      .filter((p) => p.tool_name === "ticket:done" && p.input_preview.includes(id));

  async function inReview() {
    const id = ((await postJson(hub, "/tickets", {
      by: "bob", title: "t", acceptance_criteria: "c", blast_radius: "high",
    })).json as { snapshot: { id: string } }).snapshot.id;
    await postJson(hub, `/tickets/${id}/claim`, { by: "bob" });
    for (const to of ["in_progress", "in_review"]) await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to, ...(to === "in_review" ? { note: "built and tested" } : {}) });
    return id;
  }

  test("the Allow lands between the 409 and the approval call: done, with one request", async () => {
    const id = await inReview();
    // The agent's first attempt raises the request and is told to wait.
    const first = await tool(hostWith(async () => {}), id);
    expect(first).toContain("Wait for the human");
    const [r1] = await pendingFor(id);
    expect(r1).toBeDefined();

    // The second attempt is blocked (R1 still pending); the human allows R1 right after.
    const second = await tool(hostWith(async () => {
      expect((await postJson(hub, `/permissions/${r1!.id}/verdict`, { by: hub.humanName, behavior: "allow" })).status).toBe(200);
    }), id);
    expect(second).toContain(`ticket ${id} is now done`);
    expect(second).toContain(r1!.id);
    expect(await pendingFor(id)).toHaveLength(1);   // no second card
  });
});
