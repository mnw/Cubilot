// Plan waits for your approval (spec-review-stage 4.4). A request whose spec review passed but that still holds a high
// ticket shows one row above the board: what holds it and an Approve button. The button calls the human-only route
// POST /requests/<room>/<request_id>/approve, which queues every draft ticket of the request.
// The rows come from GET /requests/<room>/waiting and are read again on ticket.* and stage.* events.
// The same area also holds "Needs you" (spec-review-stage 4.3): a request whose spec review failed twice or more shows the
// open findings of its latest FAIL (GET /requests/<room>/needs-you), below the approvals.
// Each block has a Collapse and a Clear button. Both are UI-only and live in localStorage per room: the collapse map
// (request_id -> the FAIL stage it was collapsed at) and the list of cleared FAIL stage ids. A newer FAIL has a new stage
// id, so it expands and shows the block again. Unreadable storage shows every block, expanded.
// Loaded AFTER kind-renderer.js; shares main.js lexical scope (authedFetch, HUMAN_NAME, SELECTED_ROOM, ROOM_ALL).

const PlanApproval = (() => {
  let room = null;
  let loadSeq = 0;
  let timer = null;
  const busy = new Set();   // request ids whose Approve is in flight
  let waiting = [];
  let needs = [];

  const root = () => document.getElementById('plan-waiting');

  const COLLAPSED_KEY = (r) => `cubilot.needs.collapsed.${r}`;
  const CLEARED_KEY = (r) => `cubilot.needs.cleared.${r}`;
  const collapseButtons = new Map();   // request id -> its Collapse button of the last render, for the focus after Clear
  let storeBroken = false;             // a write failed: stored filtering is unreliable, show every block
  let pendingFocus = null;             // request id whose Collapse button gets focus after the next render

  // Parsed storage value of the wanted shape, else null (missing, malformed, wrong shape, or storage throws).
  function readStore(key, isShape) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return null;
      const v = JSON.parse(raw);
      return isShape(v) ? v : null;
    } catch { return null; }
  }
  const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isIdList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  // A malformed or unreadable store leaves a block expanded.
  function isCollapsed(r, n) {
    const m = readStore(COLLAPSED_KEY(r), isMap);
    return !!m && m[n.request_id] === n.latest_fail_stage_id;
  }
  function setCollapsed(r, n, on) {
    try {
      const m = readStore(COLLAPSED_KEY(r), isMap) ?? {};
      if (on) m[n.request_id] = n.latest_fail_stage_id; else delete m[n.request_id];
      localStorage.setItem(COLLAPSED_KEY(r), JSON.stringify(m));
    } catch { /* storage unavailable: the state is not kept */ }
  }
  // The blocks whose latest FAIL stage was not cleared. A malformed or unreadable list shows every block.
  function visibleNeeds(r, list) {
    const cleared = storeBroken ? null : readStore(CLEARED_KEY(r), isIdList);
    return cleared ? list.filter((n) => !cleared.includes(n.latest_fail_stage_id)) : list;
  }
  function clearNeed(r, n) {
    try {
      const cleared = readStore(CLEARED_KEY(r), isIdList) ?? [];
      if (!cleared.includes(n.latest_fail_stage_id)) cleared.push(n.latest_fail_stage_id);
      localStorage.setItem(CLEARED_KEY(r), JSON.stringify(cleared));
    } catch { storeBroken = true; /* storage unavailable: show every block */ }
  }

  function row(w) {
    const el = document.createElement('div');
    el.className = 'plan-row';
    el.dataset.request = w.request_id;
    const text = document.createElement('div');
    text.className = 'plan-text';
    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = `Plan ${w.request_id} waits for your approval`;
    const why = document.createElement('div');
    why.className = 'plan-why';
    const n = w.draft_tickets.length;
    const held = w.high_tickets.map((t) => t.title || t.id).join(', ');
    why.textContent = `${n} draft ticket${n === 1 ? ' waits' : 's wait'}. Held by high-risk: ${held}`;
    why.title = why.textContent;
    text.append(title, why);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plan-approve';
    btn.textContent = 'Approve';
    btn.disabled = busy.has(w.request_id);
    btn.addEventListener('click', () => approve(w.request_id, btn));
    el.append(text, btn);
    return el;
  }

  // One block per request that failed its spec review twice or more: the open findings of the latest FAIL, blocking first.
  function needsRow(n) {
    const collapsed = isCollapsed(room, n);
    const el = document.createElement('div');
    el.className = 'needs-row';
    el.dataset.request = n.request_id;
    const head = document.createElement('div');
    head.className = 'needs-head';
    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = `Needs you: ${n.request_id} failed its spec review ${n.fail_count} times`;
    head.appendChild(title);
    if (collapsed) {
      const count = document.createElement('span');
      count.className = 'needs-count';
      count.textContent = `${n.findings.length} open finding${n.findings.length === 1 ? '' : 's'}`;
      head.appendChild(count);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'needs-btn needs-collapse';
    toggle.textContent = collapsed ? 'Expand' : 'Collapse';
    toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${n.request_id}`);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      setCollapsed(room, n, !collapsed);
      pendingFocus = n.request_id;
      render();
    });
    collapseButtons.set(n.request_id, toggle);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'needs-btn needs-clear';
    clear.textContent = 'Clear';
    clear.setAttribute('aria-label', `Clear ${n.request_id}`);
    clear.addEventListener('click', () => clearBlock(n));
    head.append(toggle, clear);
    el.appendChild(head);
    if (collapsed) return el;
    const list = document.createElement('ul');
    list.className = 'needs-findings';
    for (const f of n.findings) {
      const li = document.createElement('li');
      li.className = `needs-finding ${f.severity}`;
      const sev = document.createElement('span');
      sev.className = 'needs-sev';
      sev.textContent = f.severity;
      const what = document.createElement('span');
      what.className = 'needs-text';
      what.textContent = `${f.title || f.ticket_id}: ${f.text}`;
      what.title = what.textContent;
      li.append(sev, what);
      list.appendChild(li);
    }
    if (n.findings.length === 0) {
      const li = document.createElement('li');
      li.className = 'needs-finding';
      li.textContent = 'No findings were listed.';
      list.appendChild(li);
    }
    el.appendChild(list);
    return el;
  }

  // Clear hides the block for its FAIL stage. Focus moves to the next block's Collapse button, else the previous one's,
  // else the first column heading of the board.
  function clearBlock(n) {
    if (!room) return;
    const shown = visibleNeeds(room, needs);
    const i = shown.findIndex((x) => x.request_id === n.request_id);
    const target = shown[i + 1] ?? shown[i - 1] ?? null;
    clearNeed(room, n);
    pendingFocus = target ? target.request_id : '';
    render();
  }

  function applyFocus() {
    const want = pendingFocus;
    pendingFocus = null;
    if (want === null) return;
    const btn = want ? collapseButtons.get(want) : null;
    if (btn) { btn.focus(); return; }
    // Nothing is left: the first column heading takes focus (it is not a tab stop).
    const h = document.querySelector ? document.querySelector('#ticket-board-columns h3') : null;
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }

  function render() {
    const r = root();
    if (!r) return;
    collapseButtons.clear();
    const shown = room ? visibleNeeds(room, needs) : needs;
    r.replaceChildren(...waiting.map(row), ...shown.map(needsRow));
    r.hidden = waiting.length === 0 && shown.length === 0;
    applyFocus();
  }

  async function load() {
    const shown = typeof SELECTED_ROOM === 'string' && SELECTED_ROOM !== ROOM_ALL ? SELECTED_ROOM : null;
    // Every load invalidates the ones still in flight, also the one that ends at "no room": an old answer of room A
    // must never come back after the view moved to All rooms or to room B.
    const seq = ++loadSeq;
    if (shown !== room) {
      // The rows of the old room go at once, not when the new answer arrives.
      waiting = [];
      needs = [];
      room = shown;
      render();
    }
    if (!room) return;
    try {
      const base = `/requests/${encodeURIComponent(room)}`;
      const [res, nres] = await Promise.all([authedFetch(`${base}/waiting`), authedFetch(`${base}/needs-you`)]);
      if (seq !== loadSeq) return;
      if (res.ok) {
        const body = await res.json();
        if (seq !== loadSeq) return;
        if (Array.isArray(body?.waiting)) waiting = body.waiting;
      }
      if (nres.ok) {
        const body = await nres.json();
        if (seq !== loadSeq) return;
        needs = Array.isArray(body?.requests) ? body.requests : [];
      }
    } catch (e) {
      console.warn('[plan-approval] load failed:', e);
      return;
    }
    render();
  }

  async function approve(requestId, btn) {
    if (busy.has(requestId) || !room) return;
    busy.add(requestId);
    btn.disabled = true;
    try {
      const res = await authedFetch(`/requests/${encodeURIComponent(room)}/${encodeURIComponent(requestId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ by: HUMAN_NAME }),
      });
      if (!res.ok) {
        const err = await res.json().then((j) => j?.error, () => null);
        addMessage({ from: 'system', to: HUMAN_NAME, text: `Approving ${requestId} failed: ${err || res.status}`, ts: '' });
      }
    } catch (e) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Approving ${requestId} failed: ${e?.message ?? e}`, ts: '' });
    } finally {
      busy.delete(requestId);
      await load();
    }
  }

  // Ticket and stage events change what waits (a high ticket done, a spec review passed, drafts queued).
  function onEvent() {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  }

  if (typeof document !== 'undefined' && document.getElementById) {
    document.addEventListener('cubilot:room-filter', load);
    // main.js calls this when the UI stream (re)opens: ambient entries are not replayed after a reconnect.
    globalThis.syncPlanApproval = load;
    KindCardRenderer.observe('stage', onEvent);
    KindCardRenderer.observe('ticket', onEvent);
    load();
  }

  return { load, render, _busy: busy, _isCollapsed: isCollapsed, _setCollapsed: setCollapsed, _visibleNeeds: visibleNeeds, _clearNeed: clearNeed };
})();
