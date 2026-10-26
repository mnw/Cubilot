// Finished sessions — the closed stage sessions of the selected Room, listed at the foot of the terminal tab rail.
// A stage session is closed when its stage is `passed` or `failed` and it had a session name. The list is read from the
// ledger (GET /stages and GET /tickets), so a reload shows it again; stage.* events update it live.
// Loaded AFTER kind-renderer.js; shares main.js lexical scope (authedFetch, SELECTED_ROOM, ROOM_ALL).
//
// A stage row has no room: a ticket stage belongs to the room of its ticket, a spec-review stage to the room of a
// ticket with its request id. Both are read from the room's ticket list.

const FinishedSessions = (() => {
  const LIST_LIMIT = 500;   // the hub's TICKET_LIST_LIMIT and a stage list limit both allow it
  const stages = new Map();        // stage id -> snapshot, closed stages with a session only
  const ticketTitles = new Map();  // ticket id -> title, tickets of the shown room
  const requestIds = new Set();    // request ids of the shown room's tickets
  let room = null;
  let loadSeq = 0;
  let reloadTimer = null;

  const el = () => document.getElementById('terminal-finished');
  const listEl = () => document.getElementById('terminal-finished-list');
  const countEl = () => document.getElementById('terminal-finished-count');

  const isClosed = (s) => (s.status === 'passed' || s.status === 'failed') && typeof s.session === 'string' && s.session !== '';
  const inRoom = (s) => (s.ticket_id ? ticketTitles.has(s.ticket_id) : requestIds.has(s.request_id));

  function titleOf(s) {
    if (s.ticket_id) return ticketTitles.get(s.ticket_id) || s.ticket_id;
    return `Spec review of ${s.request_id}`;
  }

  // The outcome shown on a row: a verdict (spec review) wins over the stage status.
  function outcomeOf(s) {
    const v = typeof s.verdict === 'string' && s.verdict ? s.verdict.toUpperCase() : null;
    if (v === 'PASS' || v === 'FAIL') return { label: v, ok: v === 'PASS' };
    return { label: s.status, ok: s.status === 'passed' };
  }

  function render() {
    const root = el();
    const list = listEl();
    if (!root || !list) return;
    const shown = room ? [...stages.values()].filter((s) => isClosed(s) && inRoom(s)).sort((a, b) => b.version - a.version) : [];
    countEl().textContent = String(shown.length);
    list.replaceChildren();
    if (!room) {
      const hint = document.createElement('li');
      hint.className = 'finished-empty';
      hint.textContent = 'Pick a room to see its finished sessions.';
      list.appendChild(hint);
      return;
    }
    if (shown.length === 0) {
      const none = document.createElement('li');
      none.className = 'finished-empty';
      none.textContent = 'No finished sessions yet.';
      list.appendChild(none);
      return;
    }
    for (const s of shown) {
      const out = outcomeOf(s);
      const li = document.createElement('li');
      li.className = 'finished-item';
      li.dataset.stage = s.id;
      const head = document.createElement('div');
      head.className = 'finished-head';
      const name = document.createElement('span');
      name.className = 'finished-name';
      name.textContent = s.session;
      const state = document.createElement('span');
      state.className = `finished-state ${out.ok ? 'ok' : 'bad'}`;
      state.textContent = out.label;
      head.append(name, state);
      const title = document.createElement('div');
      title.className = 'finished-title';
      title.textContent = titleOf(s);
      title.title = s.attempt > 1 ? `${titleOf(s)} (attempt ${s.attempt})` : titleOf(s);
      li.append(head, title);
      list.appendChild(li);
    }
  }

  function keep(snap) {
    if (!snap || typeof snap.id !== 'string') return false;
    const prior = stages.get(snap.id);
    if (prior && prior.version > snap.version) return false;   // an older read never replaces a newer event
    if (isClosed(snap)) stages.set(snap.id, snap);
    else stages.delete(snap.id);   // a relaunched stage is not closed any more
    return true;
  }

  async function load() {
    const shownRoom = typeof SELECTED_ROOM === 'string' && SELECTED_ROOM !== ROOM_ALL ? SELECTED_ROOM : null;
    if (shownRoom !== room) { stages.clear(); ticketTitles.clear(); requestIds.clear(); }
    room = shownRoom;
    if (!room) { render(); return; }
    const seq = ++loadSeq;
    try {
      const [t, p, f] = await Promise.all([
        authedFetch(`/tickets?room=${encodeURIComponent(room)}&status=all&archived=1`),
        authedFetch(`/stages?status=passed&limit=${LIST_LIMIT}`),
        authedFetch(`/stages?status=failed&limit=${LIST_LIMIT}`),
      ]);
      if (!t.ok || !p.ok || !f.ok || seq !== loadSeq) return;
      const [tickets, passed, failed] = await Promise.all([t.json(), p.json(), f.json()]);
      if (seq !== loadSeq || !Array.isArray(tickets) || !Array.isArray(passed) || !Array.isArray(failed)) return;
      ticketTitles.clear();
      requestIds.clear();
      for (const x of tickets) {
        ticketTitles.set(x.id, x.title);
        if (x.request_id) requestIds.add(x.request_id);
      }
      for (const s of [...passed, ...failed]) keep(s);
    } catch (e) {
      console.warn('[finished-sessions] load failed:', e);
    }
    if (seq === loadSeq) render();
  }

  // A stage event for a ticket the list does not know yet (created after the last read) needs one tickets read.
  function onStage(event) {
    const snap = event?.snapshot;
    if (!keep(snap)) return;
    const known = snap.ticket_id ? ticketTitles.has(snap.ticket_id) : requestIds.has(snap.request_id);
    if (isClosed(snap) && !known && room) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 300);
    }
    render();
  }

  if (typeof document !== 'undefined' && document.getElementById) {
    document.addEventListener('cubilot:room-filter', load);
    // main.js calls this when the UI stream (re)opens: stage entries are ambient and not replayed after a reconnect.
    globalThis.syncFinishedSessions = load;
    KindCardRenderer.observe('stage', onStage);
    load();
  }

  return { load, onStage, render, _stages: stages };
})();
