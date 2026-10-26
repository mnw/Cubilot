// The send_handoff tool sends a spec review through a real hub (spec-review-stage, tool fix): review and request_id at the top level.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, postJson, registerAgent } from "../helpers/fetch";
import type { Host } from "../../hub/channel/host";
import { findTool } from "../../hub/channel/tools";

describe("send_handoff tool: spec review", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "sh");
    open.push(await registerAgent(hub, "sh-alice", { room: "sh" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  // A Host whose request goes to the real hub; the tool builds the body.
  const host = {
    readText: async (p: string) => (p.endsWith("hub.url") ? hub.url : hub.token),
    handoffGate: async () => null,
    request: async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
      return { status: r.status, text: await r.text() };
    },
  } as unknown as Host;
  const send = (args: Record<string, unknown>) =>
    findTool("send_handoff")!.handler({ agent: "sh-alice", hubEnv: "", host, room: "sh" }, args).then((r) => r.content[0].text);

  test("a spec review sent through the tool gets 201 and a spec stage", async () => {
    const t = await postJson(hub, "/tickets", { by: "sh-alice", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "req-1", status: "draft" });
    expect(t.status).toBe(201);
    const out = await send({ to_role: "validator", task: "review", review: "spec", request_id: "req-1", context: { request_text: "Build X" } });
    expect(out).toMatch(/^handoff_id=h_[0-9a-f]{16}$/);
    const stages = (await getJson(hub, "/stages?status=all")).json as Array<{ role: string; review: string | null; request_id: string | null }>;
    expect(stages.some((s) => s.role === "validator" && s.review === "spec" && s.request_id === "req-1")).toBe(true);
  });

  test("control: without review the hub still asks for context.ticket_id", async () => {
    // the draft ticket of the first test is still there
    await expect(send({ to_role: "validator", task: "review", request_id: "req-1", context: { request_text: "Build X" } })).rejects.toThrow("context.ticket_id");
  });
});
