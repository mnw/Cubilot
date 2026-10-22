// Pi adapter: host.reload() settles from the /cubilot-reload command, never from session_shutdown.
import { test, expect, mock } from 'bun:test';
import * as realNodeHost from '../../hub/channel/node-host';

// mock.restore() does not undo mock.module: put the real module back so other test files see it.
const NODE_HOST = new URL('../../hub/channel/node-host.ts', import.meta.url).pathname;
const realCopy = { ...realNodeHost };

test('session_shutdown is not successful reload completion', async () => {
  let reload!: () => Promise<void>;
  mock.module(new URL('../../hub/channel/node-host.ts', import.meta.url).pathname, () => ({
    // The failing reload now starts the bridge again, so the host needs a stream that waits.
    nodeHost: (_deliver: unknown, r: () => Promise<void>) => {
      reload = r;
      return {
        readText: async (p: string) => (p.endsWith('hub.url') ? 'http://hub.test' : 'tok'),
        async *stream(_u: string, _t: string, signal: AbortSignal) { await new Promise<void>((x) => signal.addEventListener('abort', () => x(), { once: true })); },
        log: () => {},
      };
    },
    nodeSleep: async () => {},
  }));
  const oldAgent = process.env.CHATBRIDGE_AGENT;
  process.env.CHATBRIDGE_AGENT = 'validator-throwaway';
  try {
    const { default: extension } = await import('../../hub/channel/pi-extension');
    const events: Record<string, Function> = {};
    const commands: Record<string, any> = {};
    extension({
      registerTool: () => {},
      registerCommand: (name: string, definition: any) => { commands[name] = definition; },
      on: (name: string, handler: Function) => { events[name] = handler; },
      sendUserMessage: () => {},
    });
    const result = reload();
    await commands['cubilot-reload'].handler('', {
      reload: async () => {
        events.session_shutdown({ reason: 'reload' });
        throw new Error('resource scan failed after shutdown');
      },
    });
    await expect(result).rejects.toThrow('resource scan failed');
  } finally {
    if (oldAgent === undefined) delete process.env.CHATBRIDGE_AGENT;
    else process.env.CHATBRIDGE_AGENT = oldAgent;
    mock.restore();
    mock.module(NODE_HOST, () => realCopy);
  }
});

test('host.reload() resolves only after ctx.reload() resolves', async () => {
  let reload!: () => Promise<void>;
  const requests: Array<[string, string]> = [];
  let applyStatus = 200;
  mock.module(new URL('../../hub/channel/node-host.ts', import.meta.url).pathname, () => ({
    nodeHost: (_deliver: unknown, r: (v: string) => Promise<void>) => {
      reload = () => r('v-2');
      return {
        readText: async (p: string) => (p.endsWith('hub.url') ? 'http://hub.test' : 'tok'),
        request: async (url: string, init: { body?: string }) => { requests.push([url, init.body ?? '']); return { status: applyStatus, text: '{}' }; },
      };
    },
    nodeSleep: async () => {},
  }));
  const oldAgent = process.env.CHATBRIDGE_AGENT;
  process.env.CHATBRIDGE_AGENT = 'validator-throwaway';
  try {
    const { default: extension } = await import('../../hub/channel/pi-extension');
    const events: Record<string, Function> = {};
    const commands: Record<string, any> = {};
    const sent: unknown[] = [];
    extension({
      registerTool: () => {},
      registerCommand: (name: string, definition: any) => { commands[name] = definition; },
      on: (name: string, handler: Function) => { events[name] = handler; },
      sendUserMessage: (...a: unknown[]) => { sent.push(a); },
    });
    let settled = false;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const result = reload().then(() => { settled = true; });
    expect(sent).toEqual([['/cubilot-reload', { deliverAs: 'followUp', expandPromptTemplates: true }]]);
    const run = commands['cubilot-reload'].handler('', {
      reload: async () => { events.session_shutdown({ reason: 'reload' }); await gate; },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // shutdown has fired, the reload has not finished
    expect(requests).toHaveLength(0); // and nothing is recorded yet
    finish();
    await run;
    await result;
    expect(settled).toBe(true);
    expect(requests).toEqual([['http://hub.test/factory/applied', JSON.stringify({ agent: 'validator-throwaway', version: 'v-2' })]]);
  } finally {
    if (oldAgent === undefined) delete process.env.CHATBRIDGE_AGENT;
    else process.env.CHATBRIDGE_AGENT = oldAgent;
    mock.restore();
    mock.module(NODE_HOST, () => realCopy);
  }
});

test('a refused applied record makes host.reload() reject', async () => {
  let reload!: () => Promise<void>;
  mock.module(new URL('../../hub/channel/node-host.ts', import.meta.url).pathname, () => ({
    nodeHost: (_deliver: unknown, r: (v: string) => Promise<void>) => {
      reload = () => r('v-2');
      return {
        readText: async (p: string) => (p.endsWith('hub.url') ? 'http://hub.test' : 'tok'),
        request: async () => ({ status: 409, text: '{}' }),
      };
    },
    nodeSleep: async () => {},
  }));
  const oldAgent = process.env.CHATBRIDGE_AGENT;
  process.env.CHATBRIDGE_AGENT = 'validator-throwaway';
  try {
    const { default: extension } = await import('../../hub/channel/pi-extension');
    const commands: Record<string, any> = {};
    extension({ registerTool: () => {}, registerCommand: (n: string, d: any) => { commands[n] = d; }, on: () => {}, sendUserMessage: () => {} });
    const result = reload();
    await commands['cubilot-reload'].handler('', { reload: async () => {} });
    await expect(result).rejects.toThrow('HTTP 409');
  } finally {
    if (oldAgent === undefined) delete process.env.CHATBRIDGE_AGENT;
    else process.env.CHATBRIDGE_AGENT = oldAgent;
    mock.restore();
    mock.module(NODE_HOST, () => realCopy);
  }
});

test('a reload that does not end in 30 s rejects with ReloadTimeout; a late success still records applied', async () => {
  let reload!: () => Promise<void>;
  const requests: string[] = [];
  mock.module(NODE_HOST, () => ({
    nodeHost: (_deliver: unknown, r: (v: string) => Promise<void>) => {
      reload = () => r('v-2');
      return {
        readText: async (p: string) => (p.endsWith('hub.url') ? 'http://hub.test' : 'tok'),
        request: async (url: string) => { requests.push(url); return { status: 200, text: '{}' }; },
      };
    },
    nodeSleep: async () => {},
  }));
  const oldAgent = process.env.CHATBRIDGE_AGENT;
  process.env.CHATBRIDGE_AGENT = 'validator-throwaway';
  const realSetTimeout = globalThis.setTimeout;
  let fire: (() => void) | null = null;
  try {
    const { default: extension } = await import('../../hub/channel/pi-extension');
    const { ReloadTimeout, RELOAD_MS } = await import('../../hub/channel/core');
    const commands: Record<string, any> = {};
    extension({ registerTool: () => {}, registerCommand: (n: string, d: any) => { commands[n] = d; }, on: () => {}, sendUserMessage: () => {} });
    (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...a: unknown[]) => {
      if (ms === RELOAD_MS) { fire = fn; return 0 as any; }
      return realSetTimeout(fn, ms, ...a);
    };
    const result = reload();
    (globalThis as any).setTimeout = realSetTimeout;
    expect(fire).not.toBeNull();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const run = commands['cubilot-reload'].handler('', { reload: () => gate });
    fire!();
    await expect(result).rejects.toBeInstanceOf(ReloadTimeout);
    expect(requests).toHaveLength(0);
    finish();
    await run;
    expect(requests).toEqual(['http://hub.test/factory/applied']); // the late success is recorded
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    if (oldAgent === undefined) delete process.env.CHATBRIDGE_AGENT;
    else process.env.CHATBRIDGE_AGENT = oldAgent;
    mock.restore();
    mock.module(NODE_HOST, () => realCopy);
  }
});

// A reload that fails after session_shutdown: Pi has invalidated this runtime's API and starts no new session, so the
// handler does NOT restart the bridge with the old host. It tells the hub (failed), tells the human through the hub
// request path (not pi.sendMessage), and logs. A reload that succeeds does none of this.
test.each([['fails', true], ['succeeds', false]])('a reload that %s after session_shutdown', async (_n, fails) => {
  let reload!: () => Promise<void>;
  let streams = 0;
  const logs: string[] = [];
  const posts: Array<[string, any]> = [];
  mock.module(NODE_HOST, () => ({
    nodeHost: (_deliver: unknown, r: (v: string) => Promise<void>) => {
      reload = () => r('v-2');
      return {
        readText: async (p: string) => (p.endsWith('hub.url') ? 'http://hub.test' : 'tok'),
        request: async (url: string, init: { body?: string }) => { posts.push([new URL(url).pathname, JSON.parse(init.body ?? '{}')]); return { status: 200, text: '{}' }; },
        log: (m: string) => { logs.push(m); },
        async *stream(_u: string, _t: string, signal: AbortSignal) {
          streams++;
          await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        },
      };
    },
    nodeSleep: async () => {},
  }));
  const oldAgent = process.env.CHATBRIDGE_AGENT;
  process.env.CHATBRIDGE_AGENT = 'validator-throwaway';
  try {
    const { default: extension } = await import('../../hub/channel/pi-extension');
    const events: Record<string, Function> = {};
    const commands: Record<string, any> = {};
    const piCalls: string[] = [];
    extension({
      registerTool: () => {}, registerCommand: (n: string, d: any) => { commands[n] = d; }, on: (n: string, h: Function) => { events[n] = h; },
      sendUserMessage: () => { piCalls.push('sendUserMessage'); }, sendMessage: () => { piCalls.push('sendMessage'); },
    });
    events.session_start();
    await new Promise((r) => setTimeout(r, 30));
    expect(streams).toBe(1);
    const outcome = reload().then(() => 'ok', () => 'failed');
    await commands['cubilot-reload'].handler('', {
      reload: async () => {
        events.session_shutdown({ reason: 'reload' }); // the bridge stops here
        if (fails) throw new Error('resource scan failed');
      },
    });
    expect(await outcome).toBe(fails ? 'failed' : 'ok');
    await new Promise((r) => setTimeout(r, 30));
    expect(streams).toBe(1); // never a second bridge from the old host
    expect(logs.some((l) => l.includes('hot reload failed'))).toBe(fails);
    const failedPost = posts.find(([path, body]) => path === '/factory/applied' && body.failed === true);
    const human = posts.find(([path, body]) => path === '/post' && body.to === 'you');
    expect(!!failedPost).toBe(fails);
    expect(human?.[1]?.text).toBe(fails ? 'validator-throwaway: hot reload failed, restart this agent' : undefined);
    expect(piCalls).toEqual(['sendUserMessage']); // only the reload order itself: no stale pi API call after the failure
  } finally {
    if (oldAgent === undefined) delete process.env.CHATBRIDGE_AGENT;
    else process.env.CHATBRIDGE_AGENT = oldAgent;
    mock.restore();
    mock.module(NODE_HOST, () => realCopy);
  }
});
