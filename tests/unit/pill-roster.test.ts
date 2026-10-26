import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
const win: any = {};
new Function('window', readFileSync('./ui/features/pill-card.js', 'utf8'))(win);

test('missing recorded model and effort are unknown ("-"); a recorded "default" is shown as it is', () => {
  const fields = win.pillCardFields({ role: '', harness: 'pi', model: '', effort: '', provider: '' });
  expect(Object.fromEntries(fields)).toMatchObject({ Model: '-', Effort: '-' });
});

test('a recorded default is shown as recorded', () => {
  const fields = win.pillCardFields({ role: '', harness: 'claude', model: 'default', effort: 'default', provider: '' });
  expect(Object.fromEntries(fields)).toMatchObject({ Model: 'default', Effort: 'default' });
});
