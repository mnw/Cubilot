// Decisions waiting for you (human-escalation 1.4). One line for each open or escalated decision of the selected room, above
// the board: the block sentence and the ticket ids. The line is a button that opens the full decision (facts, options with
// their effects, your actions, what happens next). The answer buttons are the options; one click calls the human-only route
// POST /decisions/<id>/answer. The list comes from GET /decisions?room=<room> and is read again on decision.* events
// (no polling). An answered decision is not in the list, so its line goes.
// Loaded AFTER kind-renderer.js; shares main.js lexical scope (authedFetch, HUMAN_NAME, SELECTED_ROOM, ROOM_ALL, addMessage).

const Decisions = (() => {
  let room = null;
  let loadSeq = 0;
  let timer = null;
  let decisions = [];
  const expanded = new Set();   // decision ids whose full text is open
  const busy = new Set();       // decision ids whose answer is in flight
  const lineButtons = new Map(); // decision id -> its line button of the last render, for the focus after a toggle
  let pendingFocus = null;

  const root = () => document.getElementById('decisions-needs');

  const ticketIds = (d) => [...new Set([d.ticket_id, ...(d.body?.human_actions ?? []).map((a) => a.ticket_id)].filter(Boolean))];

  function detail(d) {
    const wrap = document.createElement('div');
    wrap.className = 'decision-detail';
    wrap.id = `decision-detail-${d.id}`;
    const b = d.body;
    if (b) {
      const facts = document.createElement('ol');
      facts.className = 'needs-findings';
      for (const f of b.facts) {
        const li = document.createElement('li');
        li.className = 'needs-finding';
        li.textContent = f;
        facts.appendChild(li);
      }
      const options = document.createElement('ul');
      options.className = 'needs-findings';
      for (const o of b.options) {
        const li = document.createElement('li');
        li.className = 'needs-finding';
        li.textContent = `${o.id}: ${o.label}. ${o.effect}${o.recommended ? ' (recommended)' : ''}`;
        options.appendChild(li);
      }
      const actions = document.createElement('ul');
      actions.className = 'needs-findings';
      for (const a of b.human_actions) {
        const li = document.createElement('li');
        li.className = 'needs-finding';
        li.textContent = `${a.ticket_id}: ${a.action}`;
        actions.appendChild(li);
      }
      const next = document.createElement('div');
      next.className = 'needs-text';
      next.textContent = `Next: ${b.next}`;
      wrap.append(facts, options, actions, next);
    }
    const buttons = document.createElement('div');
    buttons.className = 'needs-head';
    for (const o of d.body?.options ?? []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'needs-btn decision-answer';
      btn.dataset.option = o.id;
      btn.textContent = `${o.id}: ${o.label}${o.recommended ? ' (recommended)' : ''}`;
      btn.disabled = busy.has(d.id);
      btn.addEventListener('click', () => answer(d, o.id));
      buttons.appendChild(btn);
    }
    wrap.appendChild(buttons);
    return wrap;
  }

  function line(d) {
    const open = expanded.has(d.id);
    const el = document.createElement('div');
    el.className = 'needs-row decision-row';
    el.dataset.decision = d.id;
    const head = document.createElement('div');
    head.className = 'needs-head';
    const ids = ticketIds(d);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'needs-btn decision-line';
    toggle.textContent = `Needs you: ${d.body?.block ?? d.text ?? d.id}${ids.length ? ` (${ids.join(', ')})` : ''}`;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-controls', `decision-detail-${d.id}`);
    toggle.addEventListener('click', () => {
      if (expanded.has(d.id)) expanded.delete(d.id); else expanded.add(d.id);
      pendingFocus = d.id;
      render();
    });
    lineButtons.set(d.id, toggle);
    head.appendChild(toggle);
    el.appendChild(head);
    if (open) el.appendChild(detail(d));
    return el;
  }

  function render() {
    const r = root();
    if (!r) return;
    lineButtons.clear();
    r.replaceChildren(...decisions.map(line));
    r.hidden = decisions.length === 0;
    if (pendingFocus !== null) {
      const b = lineButtons.get(pendingFocus);
      pendingFocus = null;
      if (b) b.focus();
    }
  }

  async function load() {
    const shown = typeof SELECTED_ROOM === 'string' && SELECTED_ROOM !== ROOM_ALL ? SELECTED_ROOM : null;
    // Every load invalidates the ones in flight: an old answer of room A must not come back after the view moved.
    const seq = ++loadSeq;
    if (shown !== room) {
      decisions = [];
      room = shown;
      render();
    }
    if (!room) return;
    try {
      const res = await authedFetch(`/decisions?room=${encodeURIComponent(room)}`);
      if (seq !== loadSeq) return;
      if (res.ok) {
        const body = await res.json();
        if (seq !== loadSeq) return;
        decisions = Array.isArray(body?.decisions) ? body.decisions.filter((d) => d.status === 'open' || d.status === 'escalated') : [];
      }
    } catch (e) {
      console.warn('[decisions] load failed:', e);
      return;
    }
    render();
  }

  async function answer(d, option) {
    if (busy.has(d.id) || !room) return;
    busy.add(d.id);
    render();
    try {
      const res = await authedFetch(`/decisions/${encodeURIComponent(d.id)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ by: HUMAN_NAME, option }),
      });
      if (!res.ok) {
        const err = await res.json().then((j) => j?.error, () => null);
        addMessage({ from: 'system', to: HUMAN_NAME, text: `Answering ${d.id} failed: ${err || res.status}`, ts: '' });
      }
    } catch (e) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Answering ${d.id} failed: ${e?.message ?? e}`, ts: '' });
    } finally {
      busy.delete(d.id);
      await load();
    }
  }

  function onEvent() {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  }

  if (typeof document !== 'undefined' && document.getElementById) {
    document.addEventListener('cubilot:room-filter', load);
    // main.js calls this when the UI stream (re)opens: ambient entries are not replayed after a reconnect.
    globalThis.syncDecisions = load;
    KindCardRenderer.observe('decision', onEvent);
    load();
  }

  return { load, render, _busy: busy, _decisions: () => decisions };
})();
