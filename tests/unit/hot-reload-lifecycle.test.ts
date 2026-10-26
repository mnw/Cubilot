// Validator's lifecycle case: the replacement bridge starts and calls relink before the old reload finishes.
// The hub's pending rule answers reload:false, so no second reload starts; the old reload then records .applied.
// The hub rule is the same for Pi (ctx.reload) and Claude (a replaced module), so both runs use one hub and two bridges.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../hub/channel/core";
import type { Host } from "../../hub/channel/host";
import { agentKey, createFactoryFeature } from "../../hub/features/factory";

const V1 = "v-1111111111111111";
const V2 = "v-2222222222222222";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function hub() {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  dirs.push(dir);
  mkdirSync(join(dir, V1)); mkdirSync(join(dir, V2)); mkdirSync(join(dir, "agents"));
  symlinkSync(join(dir, V1), join(dir, "agents", agentKey("bob")));
  const routes = createFactoryFeature({ dir, version: V2 }).routes;
  const request: Host["request"] = async (url, init) => {
    const path = new URL(url).pathname;
    if (!path.startsWith("/factory/")) return { status: 200, text: "{}" };
    const r = (await routes.find((x) => x.path === path)!.handler(new Request(url, { method: "POST", body: init.body }), {} as any, {})) as Response;
    return { status: r.status, text: await r.text() };
  };
  const applied = () => { try { return readFileSync(join(dir, "agents", `${agentKey("bob")}.applied`), "utf8").trim(); } catch { return null; } };
  return { request, applied };
}

// A bridge whose stream delivers one briefing and then waits. `reload` is what its runtime does.
function bridgeOn(request: Host["request"], reload: Host["reload"]) {
  let sent = false;
  const host = {
    readText: async (p: string) => (p.endsWith("hub.url") ? "http://hub.test" : "tok"),
    request,
    async *stream(_u: string, _t: string, signal: AbortSignal) {
      if (!sent) { sent = true; yield `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: V2 })}\n\n`; }
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    },
    deliver: async () => {},
    reload,
    log: () => {},
  } as unknown as Host;
  return startBridge(host, { agent: "bob", room: "r1", hubEnv: "", sleep: () => new Promise<void>(() => {}) }); // never wakes: the pending poll must not spin in a test
}

const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); expect(fn()).toBe(true); };

describe.each(["Pi (ctx.reload still running)", "Claude (module replaced, old reload still running)"])("%s", () => {
  test("the replacement bridge's relink gets reload:false; the old reload then records .applied; a later briefing reloads nothing", async () => {
    const h = hub();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const oldReloads: string[] = [];
    // The old bridge: its reload waits for the gate, then records applied (what the adapter does).
    const old = bridgeOn(h.request, async (version, _id, attempt) => {
      oldReloads.push(version);
      await gate;
      await h.request("http://hub.test/factory/applied", { method: "POST", headers: {}, body: JSON.stringify({ agent: "bob", version, attempt }) });
    });
    await until(() => oldReloads.length === 1);
    // The replacement bridge starts now, before the old reload completed.
    const newReloads: string[] = [];
    const fresh = bridgeOn(h.request, async (version) => { newReloads.push(version); });
    await new Promise((r) => setTimeout(r, 80));
    expect(newReloads).toEqual([]);
    expect(h.applied()).toBeNull();
    finish();
    await until(() => h.applied() === V2);
    // Both records now match: another briefing orders nothing.
    const later = bridgeOn(h.request, async (version) => { newReloads.push(version); });
    await new Promise((r) => setTimeout(r, 80));
    expect(newReloads).toEqual([]);
    expect(oldReloads).toEqual([V2]);
    old.stop(); fresh.stop(); later.stop();
  });
});
