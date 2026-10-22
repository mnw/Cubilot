// Validator's three reproductions for the pending record (review bCzEz1eT72NBrVS1).
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFactoryFeature, agentKey } from '../../hub/features/factory';
import { startBridge, type Bridge } from '../../hub/channel/core';
import type { Host } from '../../hub/channel/host';

const V1 = 'v-1111111111111111';
const V2 = 'v-2222222222222222';
const V3 = 'v-3333333333333333';
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); ++i) await Bun.sleep(5);
  expect(f()).toBe(true);
};
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'validator-v4-'));
  for (const v of [V1, V2, V3, 'agents']) mkdirSync(join(dir, v));
  symlinkSync(join(dir, V1), join(dir, 'agents', agentKey('bob')));
  let clock = 1_000_000;
  const deps = { dir, version: V2, now: () => clock };
  const routes = createFactoryFeature(deps).routes;
  const bridges: Bridge[] = [];
  let relinks = 0;
  const request: Host['request'] = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/factory/relink') ++relinks;
    if (!path.startsWith('/factory/')) return { status: 200, text: '{}' };
    const r = await routes.find(r => r.path === path)!.handler(new Request(url, { method: 'POST', body: init.body }), {} as any, {}) as Response;
    return { status: r.status, text: await r.text() };
  };
  function bridge(reload: Host['reload']) {
    const version = deps.version;
    const host = {
      readText: async (p: string) => p.endsWith('hub.url') ? 'http://hub.test' : 'tok',
      request,
      async *stream(_u: string, _t: string, signal: AbortSignal) {
        yield `data: ${JSON.stringify({ type: 'briefing', room: 'r', factory_version: version })}\n\n`;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      deliver: async () => {}, reload, log: () => {},
    } as unknown as Host;
    const b = startBridge(host, { agent: 'bob', room: 'r', hubEnv: '', sleep: () => new Promise<void>(() => {}) }); // never wakes: the pending poll must not spin in a test
    bridges.push(b);
    return b;
  }
  return { deps, bridge, relinks: () => relinks, tick: (n: number) => clock += n,
    close() { for (const b of bridges) b.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a known reload failure retries at the next idle point, not only after another later turn', async () => {
  const w = world();
  let calls = 0;
  try {
    const b = w.bridge(async () => { ++calls; throw new Error('reload failed'); });
    await until(() => calls === 1);
    await Bun.sleep(10);
    b.onRunStart(); b.onRunEnd();
    await until(() => w.relinks() === 2);
    await Bun.sleep(20);
    expect(calls).toBe(2);
  } finally { w.close(); }
});

test('a newer desired version does not start a second reload while the old runtime reload still runs', async () => {
  const w = world();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => finish = resolve);
  let concurrent = 0;
  let maximum = 0;
  const reload: Host['reload'] = async () => {
    ++concurrent;
    maximum = Math.max(maximum, concurrent);
    await gate;
    --concurrent;
  };
  try {
    w.bridge(reload);
    await until(() => concurrent === 1);
    // Hub restarts with a newer desired version while the replacement bridge starts.
    w.deps.version = V3;
    w.bridge(reload);
    await until(() => w.relinks() === 2);
    await Bun.sleep(20);
    expect(maximum).toBe(1);
  } finally { finish(); await Bun.sleep(5); w.close(); }
});

test('a replacement bridge does not start another reload however long the first reload takes (no time limit on pending)', async () => {
  const w = world();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => finish = resolve);
  let calls = 0;
  const reload: Host['reload'] = async () => { ++calls; await gate; };
  try {
    w.bridge(reload);
    await until(() => calls === 1);
    w.tick(24 * 60 * 60 * 1000); // a day: elapsed time never clears pending
    w.bridge(reload);
    await until(() => w.relinks() === 2);
    await Bun.sleep(20);
    expect(calls).toBe(1);
  } finally { finish(); await Bun.sleep(5); w.close(); }
});
