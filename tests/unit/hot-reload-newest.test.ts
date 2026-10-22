// Validator's deferred-update case (review yIB_KgSw_0WquZDm). Adapted: the bridges get a sleep the test controls,
// because the core now polls with the injected sleep while the hub answers pending.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startBridge, type Bridge } from '../../hub/channel/core';
import type { Host } from '../../hub/channel/host';
import { createFactoryFeature, agentKey } from '../../hub/features/factory';

const V1 = 'v-1111111111111111', V2 = 'v-2222222222222222', V3 = 'v-3333333333333333';
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(5);
  expect(f()).toBe(true);
};

test('a replacement bridge applies the newest desired version after the earlier reload completes, without another user turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newest-reload-'));
  for (const d of [V1, V2, V3, 'agents']) mkdirSync(join(dir, d));
  symlinkSync(join(dir, V1), join(dir, 'agents', agentKey('bob')));
  const deps = { dir, version: V2 };
  const routes = createFactoryFeature(deps).routes;
  let relinks = 0;
  const request: Host['request'] = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/factory/relink') ++relinks;
    const route = routes.find(r => r.path === path);
    if (!route) return { status: 200, text: '{}' };
    const r = await route.handler(new Request(url, { method: 'POST', body: init.body }), {} as any, {}) as Response;
    return { status: r.status, text: await r.text() };
  };
  const applied = () => { try { return readFileSync(join(dir, 'agents', `${agentKey('bob')}.applied`), 'utf8').trim(); } catch { return null; } };
  const record = (version: string) => request('http://hub.test/factory/applied', { method: 'POST', headers: {}, body: JSON.stringify({ agent: 'bob', version }) });
  const bridges: Bridge[] = [];
  const sleepers: Array<() => void> = [];
  const sleep = (_ms: number) => new Promise<void>((r) => sleepers.push(r));
  const logs: string[] = [];
  function bridge(reload: Host['reload']) {
    const version = deps.version;
    const host = {
      readText: async (p: string) => p.endsWith('hub.url') ? 'http://hub.test' : 'token',
      request, reload, deliver: async () => {}, log: (s: string) => logs.push(s),
      async *stream(_url: string, _token: string, signal: AbortSignal) {
        yield `data: ${JSON.stringify({ type: 'briefing', room: 'r', factory_version: version })}\n\n`;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    } as unknown as Host;
    const b = startBridge(host, { agent: 'bob', room: 'r', hubEnv: '', sleep });
    bridges.push(b); return b;
  }
  let finish!: () => void;
  const gate = new Promise<void>(resolve => finish = resolve);
  const calls: string[] = [];
  try {
    const old = bridge(async version => { calls.push(version); await gate; await record(version); });
    await until(() => calls.length === 1);
    // The hub now wants V3. The replacement bridge starts before V2 finishes.
    deps.version = V3;
    bridge(async version => { calls.push(version); await record(version); });
    await until(() => relinks === 2);
    expect(calls).toEqual([V2]); // no overlap while V2 runs
    old.stop(); // the runtime replacement removes the old bridge
    finish();
    await until(() => applied() === V2);
    sleepers.splice(0).forEach((r) => r()); // the replacement bridge's poll wakes up and asks again
    await Bun.sleep(100);
    expect({ applied: applied(), calls }).toEqual({ applied: V3, calls: [V2, V3] });
  } finally {
    finish();
    for (const b of bridges) b.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
