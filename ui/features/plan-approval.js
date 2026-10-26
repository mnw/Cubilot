// Plan waits for your approval (spec-review-stage 4.4). A request whose spec review passed but that still holds a high
// ticket shows one row above the board: what holds it and an Approve button. The button calls the human-only route
// POST /requests/<room>/<request_id>/approve, which queues every draft ticket of the request.
// The rows come from GET /requests/<room>/waiting and are read again on ticket.* and stage.* events.
// The same area also holds "Needs you" (spec-review-stage 4.3): a request whose spec review failed twice or more shows the
// open findings of its latest FAIL (GET /requests/<room>/needs-you), above the approvals.
// Loaded AFTER kind-renderer.js; shares main.js lexical scope (authedFetch, HUMAN_NAME, SELECTED_ROOM, ROOM_ALL).

const PlanApproval = (() => {
  let room = null;
  let loadSeq = 0;
  let timer = null;
  const busy = new Set();   // request ids whose Approve is in flight
  let waiting = [];
  let needs = [];

  const root = () => document.getElementById('plan-waiting');

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
    const el = document.createElement('div');
    el.className = 'needs-row';
    el.dataset.request = n.request_id;
    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = `Needs you: ${n.request_id} failed its spec review ${n.fail_count} times`;
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
    el.append(title, list);
    return el;
  }

  function render() {
    const r = root();
    if (!r) return;
    r.replaceChildren(...needs.map(needsRow), ...waiting.map(row));
    r.hidden = waiting.length === 0 && needs.length === 0;
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

  return { load, render, _busy: busy };
})();
