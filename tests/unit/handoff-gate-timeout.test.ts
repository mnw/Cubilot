import { test, expect } from 'bun:test';
import { nodeHost } from '../../hub/channel/node-host';

test('the gate timeout also bounds a shell command whose child holds stderr open', async () => {
  const host = nodeHost(async () => {}, async () => {});
  const start = Date.now();
  // A command list keeps /bin/sh as the parent. Its sleep child inherits stderr.
  const result = await host.exec('sleep 2; echo completed >&2', '', 100);
  const elapsed = Date.now() - start;
  expect(result.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(600);
});

test('the timeout kills the whole process group: a descendant does not outlive the bound', async () => {
  const host = nodeHost(async () => {}, async () => {});
  const marker = `/tmp/gate-desc-${process.pid}-${Date.now()}`;
  const result = await host.exec(`(sleep 1; touch ${marker}) & sleep 5`, '', 100);
  expect(result.timedOut).toBe(true);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await Bun.file(marker).exists()).toBe(false);
});
