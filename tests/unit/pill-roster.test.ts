import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
const ROOT = '.';
const src = readFileSync(`${ROOT}/ui/features/roster.js`, 'utf8');
const win: any = { innerWidth: 980, innerHeight: 720 };
new Function('window', readFileSync(`${ROOT}/ui/features/pill-card.js`, 'utf8'))(win);

function fixture() {
  const cards: any[] = [];
  const make = () => ({ hidden: false, style: {}, dataset: {}, innerHTML: '', setAttribute() {},
    getBoundingClientRect: () => ({ width: 560, height: 120 }) });
  const document = { createElement: make, body: { appendChild: (el: any) => cards.push(el) }, documentElement: { clientWidth: 980 } };
  const legend = { innerHTML: '', appendChild() {} };
  const renderStart = src.indexOf('function renderLegend()');
  const renderEnd = src.indexOf('\n// The pill', renderStart);
  const stateStart = src.indexOf('let pillRoles');
  const stateEnd = src.indexOf("legendEl.addEventListener('mouseover'", stateStart);
  // Exact production definitions. The fake DOM supplies a long-model card in the app's default 980-pixel viewport.
  const api = new Function('document', 'window', 'legendEl', 'ROSTER', 'HUMAN_NAME', 'pillCardFields', 'escAttr',
    src.slice(renderStart, renderEnd) + '\n' + src.slice(stateStart, stateEnd) + '\nreturn { showPillCard, renderLegend, setRoles: (roles) => { pillRoles = roles; } };')
    (document, win, legend, [], 'human', win.pillCardFields, String);
  api.setRoles({ alice: { role: 'worker', harness: 'pi', model: 'm'.repeat(80), provider: 'openai-codex', effort: 'high' } });
  return { ...api, cards, item: { dataset: { agent: 'alice' }, getBoundingClientRect: () => ({ left: 500, bottom: 40 }) } };
}

test('a right-edge pill keeps its details card inside the viewport', () => {
  const f = fixture(); f.showPillCard(f.item);
  const card = f.cards[0];
  expect(parseFloat(card.style.left) + card.getBoundingClientRect().width).toBeLessThanOrEqual(win.innerWidth);
});

test('a roster redraw dismisses the card belonging to a removed pill', () => {
  const f = fixture(); f.showPillCard(f.item);
  const card = f.cards[0];
  expect(card.hidden).toBe(false);
  f.renderLegend(); // the new roster has no alice pill
  expect(card.hidden).toBe(true);
});

test('missing recorded model and effort are unknown ("-"); a recorded "default" is shown as it is', () => {
  const fields = win.pillCardFields({ role: '', harness: 'pi', model: '', effort: '', provider: '' });
  expect(Object.fromEntries(fields)).toMatchObject({ Model: '-', Effort: '-' });
});

test('a recorded default is shown as recorded', () => {
  const fields = win.pillCardFields({ role: '', harness: 'claude', model: 'default', effort: 'default', provider: '' });
  expect(Object.fromEntries(fields)).toMatchObject({ Model: 'default', Effort: 'default' });
});
