// Ticket board — Room backlog as five columns, rendered in the right-hand pane.
// Each column has a "+" that opens the ticket form; a saved ticket lands in that column.
// Loaded AFTER kind-renderer.js; shares main.js lexical scope
// (authedFetch, parseErrorBody, escHtml, HUMAN_NAME, SELECTED_ROOM, ROOM_ALL, addMessage).
//
// Two event streams feed it: ticket.* (the tickets themselves, reconciled by version)
// and permission.* for tool_name "ticket:done" (approval state). The permission's
// input_preview.ticket_id is only a lookup hint — an approval is applied only when its
// request id equals the ticket's current approval_request_id; an unknown id for a ticket
// triggers one list re-read, because setting the pointer writes no ticket event.

const TicketBoard = (() => {
  // `status`: the status a ticket gets when it is created from the column's "+" (one call).
  const COLUMNS = [
    { key: 'draft', label: 'Draft', statuses: ['draft'], status: 'draft' },
    { key: 'queued', label: 'Queued', statuses: ['queued'], status: 'queued' },
    { key: 'progress', label: 'In progress', statuses: ['claimed', 'in_progress'], status: 'in_progress' },
    { key: 'review', label: 'In review', statuses: ['in_review'], status: 'in_review' },
    { key: 'done', label: 'Done', statuses: ['done'], status: 'done' },
  ];

  // API values are names; rank orders the columns. Anything unknown reads as medium.
  const PRIORITIES = { highest: [5, 'Highest'], high: [4, 'High'], medium: [3, 'Medium'], low: [2, 'Low'], lowest: [1, 'Lowest'] };
  const prio = (t) => (Object.hasOwn(PRIORITIES, t.priority) ? PRIORITIES[t.priority] : PRIORITIES.medium);

  // Board filters (blast radius, priority, request, show archived, show cancelled), kept per room in localStorage. No filter = all five
  // priorities ticked and radius "all". An unticked-everything choice is honoured: it shows nothing.
  const FILTER_KEY = (r) => `cubilot_board_filter:${r}`;
  const RADII = ['all', 'low', 'high'];
  const defaultFilter = () => ({ radius: 'all', request: '', priorities: Object.keys(PRIORITIES), showArchived: false, showCancelled: false });
  function sanitizeFilter(f) {
    const d = defaultFilter();
    if (!f || typeof f !== 'object') return d;
    return {
      radius: RADII.includes(f.radius) ? f.radius : d.radius,
      request: typeof f.request === 'string' ? f.request : d.request,
      priorities: Array.isArray(f.priorities) ? d.priorities.filter((k) => f.priorities.includes(k)) : d.priorities,
      showArchived: f.showArchived === true,
      showCancelled: f.showCancelled === true,
    };
  }
  function readFilter(r) {
    try {
      const f = JSON.parse(localStorage.getItem(FILTER_KEY(r)) || 'null');
      // Before filter format 2, "all" meant every request. A stored "all" without the marker is that old value, not a label.
      if (f && typeof f === 'object' && f.v !== 2 && f.request === 'all') f.request = '';
      return sanitizeFilter(f);
    } catch { return defaultFilter(); }
  }
  // An unknown priority reads as medium (as everywhere on the board).
  const priorityKey = (t) => (Object.hasOwn(PRIORITIES, t.priority) ? t.priority : 'medium');
  const matchesFilter = (t, f) => (f.radius === 'all' || t.blast_radius === f.radius) && (f.request === '' || t.request_id === f.request) && f.priorities.includes(priorityKey(t));
  const isDefaultFilter = (f) => f.radius === 'all' && f.request === '' && f.priorities.length === Object.keys(PRIORITIES).length && !f.showArchived && !f.showCancelled;
  // Hidden unless asked for: an archived ticket (archived_at_ms set) and a cancelled one.
  const isVisible = (t, f) => (f.showArchived || !t.archived_at_ms) && (f.showCancelled || t.status !== 'cancelled');

  const LIST_LIMIT = 500;   // mirrors TICKET_LIST_LIMIT in hub/kinds/ticket.ts
  const CANCELLED = { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] };   // no "+": nothing is created cancelled

  /** @type {Map<string, any>} id → snapshot (+ approval {id,status,resolved_by,version}) */
  const tickets = new Map();
  /** request ids already re-read for, so a late superseded event cannot loop reloads */
  const reloadedFor = new Set();
  /** permission events for tickets not known yet, held while a list read is in flight */
  const deferred = [];
  let loading = false;
  let room = null;
  let newColumn = COLUMNS[0];
  let opener = null;
  let saving = false;
  let loadSeq = 0;
  /** ids whose events arrived while a list read was in flight: the read may not hold them yet */
  const freshDuringLoad = new Set();
  /** @type {Map<string, {items:any[], loaded:boolean, loading:boolean, seq:number}>} notes per ticket, read on demand */
  const notes = new Map();
  /** ticket ids whose card shows its notes expanded (kept across redraws) */
  const openNotes = new Set();
  /** @type {Map<string, {items:any[], loaded:boolean, loading:boolean, failed:boolean, seq:number}>} attachments per ticket */
  const files = new Map();
  /** files chosen in the new-ticket popup, uploaded and linked after the ticket exists */
  let pendingFiles = [];
  let filter = defaultFilter();
  let lead = null;   // the room's lead agent (or null), read from the hub
  let leadSeq = 0;     // orders reads: a newer read, save or room.lead entry makes an older read stale
  let leadWrite = 0;   // orders writes: a newer save or room.lead entry makes an older save's answer stale; a read does not
  let archivingAll = false;

  const boardRoom = () => (typeof SELECTED_ROOM === 'string' && SELECTED_ROOM !== ROOM_ALL ? SELECTED_ROOM : null);

  // The newer of two approvals for the ticket's current pointer; anything else is dropped.
  function pickApproval(pointer, ...candidates) {
    let best = null;
    for (const a of candidates) {
      if (a && a.id === pointer && (!best || Number(a.version) > Number(best.version))) best = a;
    }
    return best;
  }

  async function load() {
    const target = boardRoom();
    if (target !== room) { tickets.clear(); reloadedFor.clear(); deferred.length = 0; notes.clear(); openNotes.clear(); files.clear(); }
    const roomChanged = target !== room;
    if (roomChanged) { listLoaded = false; filter = target ? readFilter(target) : defaultFilter(); syncFilterControls(); }
    room = target;
    if (roomChanged) { closeView(); loadLead(); } else renderLead();   // the roster may have changed since
    const seq = ++loadSeq;
    if (!room) { loading = false; deferred.length = 0; render(); return; }
    loading = true;
    freshDuringLoad.clear();
    try {
      const r = await authedFetch(`/tickets?room=${encodeURIComponent(room)}&status=all${filter.showArchived ? '&archived=1' : ''}`);
      if (!r.ok || seq !== loadSeq) return;
      const list = await r.json();
      if (seq !== loadSeq || !Array.isArray(list)) return;
      // A list read can be older than events that arrived while it was in flight:
      // keep whichever ticket and approval carries the higher version.
      for (const item of list) {
        const prior = tickets.get(item.id);
        const listApproval = item.approval ? { ...item.approval, version: Number(item.approval.version) || 0 } : null;
        const base = prior && prior.version > item.version ? prior : { ...item };
        base.notes_count = Math.max(Number(prior?.notes_count) || 0, Number(item.notes_count) || 0);   // counts only grow
        base.attachments_count = Number(base.attachments_count) || 0;   // follows the newer of list and event: a count can fall
        base.approval = pickApproval(base.approval_request_id, prior?.approval, listApproval);
        tickets.set(item.id, base);
        syncNotes(base);
        syncFiles(base);
      }
      // A list that hit the hub's row limit (TICKET_LIST_LIMIT in hub/kinds/ticket.ts) is cut short, so an
      // absent ticket proves nothing: only a list that came back shorter than the limit is complete.
      // The default list leaves archived tickets out. A known ticket the hub no longer lists was archived
      // while no event reached us (a stream reconnect does not replay ambient entries): treat it as archived,
      // unless its own event arrived during this read (the list may predate it).
      if (!filter.showArchived && list.length < LIST_LIMIT) {
        const listed = new Set(list.map((i) => i.id));
        for (const [id, t] of tickets) {
          if (!listed.has(id) && !freshDuringLoad.has(id) && !t.archived_at_ms) tickets.set(id, { ...t, archived_at_ms: t.updated_at_ms || 1 });
        }
      }
      listLoaded = true;
      dropStaleRequest();   // before the final render, so the first load with a stored filter on a gone label shows the board
      render();
    } catch (e) {
      console.warn('[tickets] load failed:', e);
    } finally {
      // Only the newest read replays: a verdict that arrived before its ticket was known
      // is applied now, after the version merge.
      if (seq === loadSeq) {
        loading = false;
        for (const e of deferred.splice(0)) onPermission(e);
      }
    }
  }

  function snapshotOf(event) {
    if (event.snapshot) return event.snapshot;
    try { return JSON.parse(event.text || '{}'); } catch { return null; }
  }

  function onTicket(event) {
    if (event.kind === 'ticket.noted') { onNoted(event); return; }
    if (event.kind === 'ticket.attached') { onAttached(event); return; }
    if (event.kind === 'ticket.detached') { onDetached(event); return; }
    const s = snapshotOf(event);
    if (!s || !s.id || s.room !== room) return;
    if (loading) freshDuringLoad.add(s.id);
    const prior = tickets.get(s.id);
    const version = Number(event.version ?? s.version ?? 0);
    if (prior && prior.version >= version) return;
    const approval = prior && prior.approval_request_id === s.approval_request_id ? prior.approval : null;
    // notes_count rides on the entry (a ticket.update that carried a note), not in the snapshot.
    tickets.set(s.id, { ...s, version, approval, notes_count: Math.max(Number(prior?.notes_count) || 0, Number(event.notes_count ?? s.notes_count) || 0),
      attachments_count: Number(event.attachments_count ?? s.attachments_count ?? prior?.attachments_count) || 0 });
    syncNotes(tickets.get(s.id));
    syncFiles(tickets.get(s.id));
    if (s.approval_request_id && !approval) load();
    else {
      if (listLoaded && !loading) dropStaleRequest();   // the event may have hidden the last ticket of the selected request
      render();
    }
  }

  // Returns 'applied' | 'ignored' | 'reload' | 'deferred' — exposed for the unit test.
  function onPermission(event) {
    const p = snapshotOf(event);
    if (!p || p.tool_name !== 'ticket:done') return 'ignored';
    let hint = null;
    try { hint = JSON.parse(p.input_preview || '{}').ticket_id ?? null; } catch {}
    const t = hint ? tickets.get(hint) : null;
    if (!t) {
      if (!hint || !loading) return 'ignored';
      deferred.push(event);
      return 'deferred';
    }
    if (p.id !== t.approval_request_id) {
      // Unknown to this ticket: either a new pointer we have not seen, or an unrelated /
      // superseded request. Never applied; re-read once so the list decides.
      if (reloadedFor.has(p.id)) return 'ignored';
      reloadedFor.add(p.id);
      load();
      return 'reload';
    }
    const version = Number(event.version ?? p.version ?? 0);
    if (t.approval && t.approval.id === p.id && t.approval.version >= version) return 'ignored';
    t.approval = { id: p.id, status: p.status, resolved_by: p.resolved_by ?? null, version };
    render();
    return 'applied';
  }

  let lastActError = '';   // the text of the last refused call, for inline display
  async function act(path, body, label) {
    lastActError = '';
    try {
      const r = await authedFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: HUMAN_NAME, ...body }),
      });
      if (r.ok) return (await r.json().catch(() => null)) ?? {};
      const err = await parseErrorBody(r);
      lastActError = String(err);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Ticket ${label} failed: ${err}`, ts: '' });
    } catch (e) {
      lastActError = String(e?.message ?? e);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Ticket ${label} error: ${e?.message ?? e}`, ts: '' });
    }
    return null;
  }

  // Human moves: an open ticket goes to any of the five columns with the "Move to" select or by drag and
  // drop (the hub keeps the assignee). Cancel stays a button. A claimed ticket sits in the In progress column.
  const movable = (t) => t.status !== 'done' && t.status !== 'cancelled';
  const columnStatus = (t) => (t.status === 'claimed' ? 'in_progress' : t.status);
  const actionsFor = (t) => (movable(t) ? [['cancelled', 'Cancel ticket']] : []);

  function moveHtml(t, label = 'Move to') {
    if (!movable(t)) return '';
    const cur = columnStatus(t);
    const options = COLUMNS.map((c) =>
      `<option value="${escAttr(c.status)}"${c.status === cur ? ' selected disabled' : ''}>${escHtml(c.label)}</option>`).join('');
    return `<label class="ticket-move-label">${escHtml(label)} <select class="ticket-move" data-ticket="${escAttr(t.id)}" data-current="${escAttr(cur)}" aria-label="Move ${escAttr(t.title)} to column">${options}</select></label>`;
  }

  // Send the human move. Nothing moves on screen until the hub's event arrives, so a refused move
  // (the hub error goes to the chat) only redraws the board: the card and the select are back where they were.
  const moving = new Set();   // tickets with a move in flight: a second move waits for the hub's answer
  async function moveTicket(id, to) {
    const t = tickets.get(id);
    if (!t || !movable(t) || columnStatus(t) === to || moving.has(id)) return;
    moving.add(id);
    try {
      const ok = await act(`/tickets/${encodeURIComponent(id)}/transition`, { to }, `move to ${to}`);
      if (!ok) render();
    } finally {
      moving.delete(id);
    }
  }

  // Assignees are the agents of the board's room (never the human): the hub refuses anyone else.
  const roomAgents = () =>
    (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER) ? ROSTER : [])
      .filter((a) => a.room === room && a.name !== HUMAN_NAME)
      .map((a) => a.name);

  function assignHtml(t) {
    if (t.status === 'done' || t.status === 'cancelled') return '';
    const names = roomAgents();
    if (t.assignee && !names.includes(t.assignee)) names.push(t.assignee);  // removed from the roster: keep it shown
    if (!names.length) return '';
    // "Unassigned" on every unassigned card (so no agent looks selected), and on a queued card (the hub
    // unassigns a queued ticket and nothing later). Choosing it on an unassigned card is the current value: no call.
    const options = (!t.assignee || t.status === 'queued' ? `<option value=""${t.assignee ? '' : ' selected'}>Unassigned</option>` : '')
      + names.map((n) => `<option value="${escAttr(n)}"${n === t.assignee ? ' selected' : ''}>${escHtml(n)}</option>`).join('');
    return `<label class="ticket-assign-label">Assignee <select class="ticket-assign" data-ticket="${escAttr(t.id)}" data-current="${escAttr(t.assignee ?? '')}" aria-label="Assignee of ${escAttr(t.title)}">${options}</select></label>`;
  }

  // ---- Acceptance criteria: a small Markdown editor (toolbar and shortcuts) and a safe renderer ----
  // The editor only inserts text; the renderer escapes EVERYTHING first and then adds a fixed set of tags
  // (paragraphs, line breaks, strong, code, lists, checklists), so no user text can become HTML.
  const MD_CHECK = /^- \[[ xX]\] /;
  const MD_BULLET = /^- /;

  // Pure: value, selection and action in; new value and selection out. Toggles: applying an action
  // again to its own result removes it.
  function applyMarkdownAction(value, start, end, action) {
    if (action === 'bold' || action === 'code') {
      const mark = action === 'bold' ? '**' : '`';
      const n = mark.length;
      const sel = value.slice(start, end);
      if (value.slice(start - n, start) === mark && value.slice(end, end + n) === mark && start >= n) {   // marks around the selection
        return { value: value.slice(0, start - n) + sel + value.slice(end + n), start: start - n, end: end - n };
      }
      if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {   // marks inside the selection
        return { value: value.slice(0, start) + sel.slice(n, -n) + value.slice(end), start, end: end - 2 * n };
      }
      return { value: value.slice(0, start) + mark + sel + mark + value.slice(end), start: start + n, end: end + n };
    }
    if (action !== 'bullet' && action !== 'checklist') return { value, start, end };
    // List actions work on whole lines: every line the selection touches.
    const lastLineEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;   // a selection that ends after a newline does not take the next line
    const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;   // position -1 would search index 0
    const nl = value.indexOf('\n', lastLineEnd);
    const lineEnd = nl === -1 ? value.length : nl;
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const filled = lines.filter((l) => l !== '');
    const isCheck = action === 'checklist';
    const prefix = isCheck ? '- [ ] ' : '- ';
    const strip = (l) => l.replace(MD_CHECK, '').replace(MD_BULLET, '');
    const allOn = filled.length > 0 && filled.every((l) => (isCheck ? MD_CHECK.test(l) : MD_BULLET.test(l) && !MD_CHECK.test(l)));
    const out = lines.map((l) => (l === '' && filled.length > 0 ? l : allOn ? strip(l) : prefix + strip(l)));
    const text = out.join('\n');
    const next = value.slice(0, lineStart) + text + value.slice(lineEnd);
    if (start === end) {   // a caret stays on its line, after the prefix
      const delta = text.length - (lineEnd - lineStart);
      const caret = Math.max(lineStart + (allOn ? 0 : prefix.length), start + delta);
      return { value: next, start: caret, end: caret };
    }
    return { value: next, start: lineStart, end: lineStart + text.length };
  }

  function applyToCriteria(action, id = 'ticket-f-criteria') {
    const ta = document.getElementById(id);
    if (!ta) return;
    const r = applyMarkdownAction(ta.value, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length, action);
    ta.value = r.value;
    ta.setSelectionRange?.(r.start, r.end);
    ta.focus?.();
    // Programmatic edits do not fire `input`: tell anyone listening (validation, drafts).
    if (typeof Event === 'function') ta.dispatchEvent?.(new Event('input', { bubbles: true }));
  }

  // Shortcuts (Cmd or Ctrl): B bold, E inline code, Shift+8 bulleted list, Shift+9 checklist item.
  function onCriteriaKeydown(e, id) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = String(e.key ?? '').toLowerCase();
    const action = e.shiftKey ? (e.code === 'Digit8' ? 'bullet' : e.code === 'Digit9' ? 'checklist' : null)
      : key === 'b' ? 'bold' : key === 'e' ? 'code' : null;
    if (!action) return;
    e.preventDefault();
    applyToCriteria(action, id);
  }

  // Inline: code spans first (their content is literal), then **strong** in the rest. `s` is already escaped.
  const mdInline = (s) =>
    s.split(/(`[^`\n]+`)/).map((seg, i) => (i % 2
      ? `<code>${seg.slice(1, -1)}</code>`
      : seg.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>'))).join('');

  function mdHtml(text) {
    const lines = escHtml(String(text ?? '')).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para = [];
    let list = null;   // { kind: 'bullet' | 'check', items: [] }
    const flushPara = () => { if (para.length) html.push(`<p>${para.join('<br>')}</p>`); para = []; };
    const flushList = () => {
      if (!list) return;
      html.push(`<ul class="${list.kind === 'check' ? 'md-checklist' : 'md-list'}">${list.items.join('')}</ul>`);
      list = null;
    };
    for (const line of lines) {
      const check = /^- \[([ xX])\] (.*)$/.exec(line);
      const bullet = !check && /^- (.*)$/.exec(line);
      if (check || bullet) {
        flushPara();
        const kind = check ? 'check' : 'bullet';
        if (list && list.kind !== kind) flushList();
        list ??= { kind, items: [] };
        list.items.push(check
          ? `<li><input type="checkbox" disabled${check[1] === ' ' ? ' aria-label="to do"' : ' checked aria-label="done"'}> ${mdInline(check[2])}</li>`
          : `<li>${mdInline(bullet[1])}</li>`);
      } else if (line.trim() === '') {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(mdInline(line));
      }
    }
    flushPara();
    flushList();
    return html.join('');
  }

  // ---- Notes: the audit trail of how a ticket was built and tested (append-only, read on demand) ----
  const noteCount = (t) => Number(t.notes_count) || 0;

  async function loadNotes(id) {
    const c = notes.get(id) ?? { items: [], loaded: false, loading: false, failed: false, seq: 0 };
    notes.set(id, c);
    const seq = ++c.seq;
    c.loading = true;
    c.failed = false;
    try {
      const r = await authedFetch(`/tickets/${encodeURIComponent(id)}/notes`);
      if (seq !== c.seq) return;
      if (!r.ok) { c.failed = true; return; }
      const list = await r.json();
      if (seq !== c.seq) return;
      if (!Array.isArray(list)) { c.failed = true; return; }
      // Merge by note id, never replace: a live note that arrived while this read was in flight may be
      // newer than the read's snapshot. Notes are append-only, so the union is always right.
      c.items = mergeNotes(c.items, list);
      c.loaded = true;
    } catch (e) {
      if (seq === c.seq) c.failed = true;   // no automatic retry: only an explicit open or Retry reads again
      console.warn('[tickets] notes read failed:', e);
    } finally {
      if (seq === c.seq) { c.loading = false; render(); }
    }
  }

  const mergeNotes = (a, b) => {
    const byId = new Map();
    for (const n of [...a, ...b]) byId.set(n.id, n);
    return [...byId.values()].sort((x, y) => x.id - y.id);
  };

  // A redraw may read the notes the first time, but never again after a failure: only an explicit
  // open (card section, ticket view) or the Retry button clears `failed`.
  const ensureNotes = (id) => {
    const c = notes.get(id);
    if (!c || (!c.loaded && !c.loading && !c.failed)) loadNotes(id);
  };
  const retryNotes = (id) => {
    const c = notes.get(id);
    if (c) c.failed = false;
    ensureNotes(id);
  };

  // A known list of notes that no longer matches the ticket's count is stale (a note arrived in a move
  // we only saw as a count): read it again if anybody is looking at it.
  function syncNotes(t) {
    const c = notes.get(t.id);
    if (!c || !c.loaded || c.items.length >= noteCount(t)) return;
    c.loaded = false;
    if (!c.failed && (openNotes.has(t.id) || viewId === t.id)) loadNotes(t.id);
  }

  function onNoted(event) {
    const t = tickets.get(event.ticket_id);
    if (!t || event.room !== room) return;
    const c = notes.get(t.id);
    // Keep a live note even while a read is in flight (the read merges, it does not replace it).
    if (c && event.note) c.items = mergeNotes(c.items, [event.note]);
    // Notes only ever grow, so a count never goes down: an older entry cannot lower it.
    t.notes_count = Math.max(noteCount(t), Number(event.notes_count ?? noteCount(t) + 1) || 0);
    syncNotes(t);
    render();
  }

  // The author's role from the agent name (Worker1, Tester2, Validator, Orchestrator): it picks the colour. The colour is a 30 % tint of a token
  // mixed into --text, so the name stays at 4.5:1 or more in all three themes.
  const noteRole = (author) => { const m = /^(orchestrator|worker|tester|validator)/i.exec(String(author)); return m ? m[1].toLowerCase() : (String(author) === HUMAN_NAME ? 'human' : 'other'); };
  const noteItemHtml = (n) =>
    `<li><span class="ticket-note-author note-role-${noteRole(n.author)}">${escHtml(n.author)}</span> <time>${escHtml(when(n.created_at_ms))}</time>`
    + `<div class="ticket-note-text">${escHtml(n.text)}</div></li>`;
  const NOTES_SHOWN = 3;
  const allNotes = new Set();   // ticket ids whose full notes list the human asked for

  function notesBodyHtml(t) {
    if (noteCount(t) === 0) return '<div class="ticket-notes-empty">No notes yet. Agents add notes while they work on the ticket.</div>';
    const c = notes.get(t.id);
    if (c?.failed) return `<div class="ticket-notes-empty">Could not read the notes. <button type="button" class="ticket-notes-retry" data-ticket="${escAttr(t.id)}">Retry</button></div>`;
    if (!c?.loaded) return '<div class="ticket-notes-empty">Loading…</div>';
    // Newest first. Three show; "Show all N notes" shows the rest (in the dialog).
    const newest = [...c.items].sort((a, b) => b.id - a.id);
    const more = newest.length > NOTES_SHOWN && !allNotes.has(t.id);
    const shown = more ? newest.slice(0, NOTES_SHOWN) : newest;
    return `<ul class="ticket-notes-list">${shown.map(noteItemHtml).join('')}</ul>`
      + (more ? `<button type="button" class="ticket-notes-all" data-ticket="${escAttr(t.id)}">Show all ${newest.length} notes</button>` : '');
  }

  // On a card: a collapsed section, shown only when there are notes. In the full view: always shown.
  function notesHtml(t, inView) {
    if (inView) return `<h3 class="ticket-view-h">Notes <span class="ticket-view-count">${noteCount(t)}</span></h3>${notesBodyHtml(t)}`;
    if (noteCount(t) === 0) return '';
    return `<details class="ticket-notes" data-ticket="${escAttr(t.id)}"${openNotes.has(t.id) ? ' open' : ''}>`
      + `<summary>Notes (${noteCount(t)})</summary>${notesBodyHtml(t)}</details>`;
  }

  function wireNotes(root) {
    root.querySelectorAll?.('.ticket-notes').forEach((d) => {
      d.addEventListener('toggle', () => {
        const id = d.dataset.ticket;
        if (!d.open) { openNotes.delete(id); return; }
        // A redraw recreates an expanded section as <details open>, and the browser queues a toggle for it:
        // that is not the human opening it. Only a section that was closed counts as an explicit open.
        const wasOpen = openNotes.has(id);
        openNotes.add(id);
        if (wasOpen) ensureNotes(id); else retryNotes(id);
      });
    });
    root.querySelectorAll?.('.ticket-notes-all').forEach((b) => b.addEventListener('click', () => { allNotes.add(b.dataset.ticket); refreshView(); }));
    root.querySelectorAll?.('.ticket-notes-retry').forEach((b) => {
      b.addEventListener('click', () => retryNotes(b.dataset.ticket));
    });
  }

  // ---- Attachments: files linked to a ticket (pdf, md, txt, png, jpg, jpeg), append-only, read on demand ----
  const ATTACH_EXTS = ['pdf', 'md', 'txt', 'png', 'jpg', 'jpeg'];
  const ATTACH_ACCEPT = ATTACH_EXTS.map((e) => `.${e}`).join(',');
  const ATTACH_MAX_BYTES = 8 * 1024 * 1024;   // the hub's /upload cap
  const attachCount = (t) => Number(t.attachments_count) || 0;
  // The hub keeps an attachment name to one line of at most 200 characters; a longer one is refused AFTER the
  // upload (an orphan file). Collapse whitespace, control and format characters, and cut the stem so the
  // extension survives. Same rule as attachmentName in hub/channel/tools.ts.
  const ATTACH_NAME_MAX = 200;
  function attachmentName(raw) {
    const one = String(raw).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
    if (one.length <= ATTACH_NAME_MAX) return one;
    const dot = one.lastIndexOf('.');
    const ext = dot > 0 && one.length - dot <= 11 ? one.slice(dot) : '';
    return one.slice(0, ATTACH_NAME_MAX - ext.length).trimEnd() + ext;
  }
  const fileExt = (name) => String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase();

  // Why a file cannot be attached, or '' when it can. The hub checks again; this answers at once.
  function fileProblem(file) {
    const name = attachmentName(file.name);   // trailing spaces and the like do not hide the extension
    if (!ATTACH_EXTS.includes(fileExt(name)) || !name.includes('.')) return `${file.name}: only ${ATTACH_EXTS.join(', ')} can be attached`;
    if (file.size > ATTACH_MAX_BYTES) return `${file.name}: larger than 8 MiB`;
    return '';
  }

  const mergeFiles = (a, b) => {
    const byId = new Map();
    for (const f of [...a, ...b]) byId.set(f.id, f);
    return [...byId.values()].sort((x, y) => x.id - y.id);
  };

  async function loadFiles(id) {
    const c = files.get(id) ?? { items: [], loaded: false, loading: false, failed: false, seq: 0, changes: 0 };
    files.set(id, c);
    const seq = ++c.seq;
    const changes = c.changes;   // goes up on each ticket.attached / ticket.detached: an answer that started before one is stale
    c.loading = true;
    c.failed = false;
    try {
      const r = await authedFetch(`/tickets/${encodeURIComponent(id)}/attachments`);
      if (seq !== c.seq) return;
      if (!r.ok) { c.failed = true; return; }
      const list = await r.json();
      if (seq !== c.seq) return;
      if (!Array.isArray(list)) { c.failed = true; return; }
      if (c.changes !== changes) { c.loading = false; return loadFiles(id); }   // an attach or detach arrived during the read: this answer predates it, read again
      c.items = list;   // the newest read replaces the cache (a removal must show); a live attachment this read missed lowers items below the count, and syncFiles reads again
      c.loaded = true;
    } catch (e) {
      if (seq === c.seq) c.failed = true;
      console.warn('[tickets] attachments read failed:', e);
    } finally {
      if (seq === c.seq) { c.loading = false; render(); }
    }
  }

  const ensureFiles = (id) => {
    const c = files.get(id);
    if (!c || (!c.loaded && !c.loading && !c.failed)) loadFiles(id);
  };
  const retryFiles = (id) => {
    const c = files.get(id);
    if (c) c.failed = false;
    ensureFiles(id);
  };

  // A known list of files that no longer matches the ticket's count is stale (an attachment arrived while
  // no event reached us, e.g. across a reconnect): read it again if its view is open.
  function syncFiles(t) {
    const c = files.get(t.id);
    if (!c || !c.loaded || c.items.length === attachCount(t)) return;   // a count that differs either way: read again
    c.loaded = false;
    if (!c.failed && viewId === t.id) loadFiles(t.id);
  }

  function onAttached(event) {
    const t = tickets.get(event.ticket_id);
    if (!t || event.room !== room) return;
    const c = files.get(t.id);
    if (c) c.changes = (c.changes ?? 0) + 1;
    if (c && event.attachment) c.items = mergeFiles(c.items, [event.attachment]);
    t.attachments_count = Number(event.attachments_count ?? attachCount(t) + 1) || 0;
    syncFiles(t);
    render();
  }

  // A file left the ticket. The event names the file (`attachment_id`) and the new count; without the id the list is read again.
  function onDetached(event) {
    const t = tickets.get(event.ticket_id);
    if (!t || event.room !== room) return;
    const c = files.get(t.id);
    if (Number.isFinite(Number(event.attachments_count))) t.attachments_count = Number(event.attachments_count);
    if (c) {
      c.changes = (c.changes ?? 0) + 1;
      if (event.attachment_id != null) c.items = c.items.filter((f) => String(f.id) !== String(event.attachment_id));
      else c.loaded = false;
    }
    syncFiles(t);
    render();
  }

  // Replace and Remove act at once, not with "Save changes". Remove needs a second click (5 s), like "Cancel ticket".
  // Replace attaches the new file first and removes the old one only when that worked, so a failure never loses the file.
  let removeArmed = null;   // attachment id after one click on Remove
  let removeTimer = null;
  let replaceTarget = null; // { ticketId, attachmentId } while the file picker is open
  // The line next to Attach file: files save at once, so say it. Cleared when the dialog opens or closes.
  const fileNote = (text) => { const el = document.getElementById('ticket-view-attach-status'); if (el) el.textContent = text; };
  // A file action answers late: its message belongs to the dialog that started it. Record the ticket and the dialog-open
  // count at the start; write only while that same ticket is open in that same dialog instance.
  let viewEpoch = 0;   // goes up each time the dialog opens
  const fileCtx = () => ({ id: viewId, epoch: viewEpoch });
  const sameView = (c) => c.id != null && viewId === c.id && viewEpoch === c.epoch;
  const noteIf = (c, text) => { if (sameView(c)) fileNote(text); };
  const errorIf = (c, text) => { if (sameView(c)) { viewError = text; viewErrorField = ''; renderNotice(); } };
  const removeFile = async (ticketId, attachmentId, c = fileCtx()) => {
    const ok = await act(`/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/remove`, {}, 'remove file');
    if (ok) noteIf(c, 'File removed');
    return ok;
  };
  async function replaceFile(ticketId, attachmentId, file) {
    const c = fileCtx();
    const old = files.get(ticketId)?.items.find((f) => String(f.id) === String(attachmentId));
    const oldName = old?.name ?? `file ${attachmentId}`;
    const ids = [];
    if (!file || (await attachFiles(ticketId, [file], ids)) !== 1) { errorIf(c, lastActError || `"${file?.name ?? 'the new file'}" was not attached. The old file "${oldName}" stays.`); return; }
    if (String(ids[0]) === String(attachmentId)) { errorIf(c, `"${file.name}" is the file "${oldName}" already attached. Nothing was replaced.`); return; }   // the hub answered with the same attachment: removing it would lose the file
    noteIf(c, 'File saved');
    if (await removeFile(ticketId, attachmentId, c)) noteIf(c, 'File replaced');
    else errorIf(c, `The new file "${file.name}" is attached, but the old file "${oldName}" was not removed${lastActError ? `: ${lastActError}` : ''}. Remove the old file by hand.`);
  }
  function wireFileButtons(root) {
    root.querySelectorAll?.('.ticket-file-remove').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.attachment;
      if (removeArmed === id) { clearTimeout(removeTimer); removeArmed = null; removeFile(btn.dataset.ticket, id, fileCtx()); return; }
      removeArmed = id;
      clearTimeout(removeTimer);
      removeTimer = setTimeout(() => { removeArmed = null; refreshView(); }, 5000);
      refreshView();
    }));
    root.querySelectorAll?.('.ticket-file-replace').forEach((btn) => btn.addEventListener('click', () => {
      replaceTarget = { ticketId: btn.dataset.ticket, attachmentId: btn.dataset.attachment };
      document.getElementById('ticket-view-replace')?.click?.();
    }));
  }

  function fileItemHtml(f, t) {
    const href = escAttr(imgUrl(f.url));
    const thumb = IMAGE_EXT_RE.test(f.url)
      ? `<a href="${href}" target="_blank" rel="noopener"><img class="ticket-attach-thumb" src="${href}" alt="${escAttr(f.name)}" loading="lazy"></a>`
      : `<span class="ticket-attach-ext">${escHtml(fileExt(f.url).toUpperCase())}</span>`;
    return `<li>${thumb}<div class="ticket-attach-info"><a class="ticket-attach-name" href="${href}" target="_blank" rel="noopener">${escHtml(f.name)}</a>`
      + `<span class="ticket-attach-meta">${escHtml(f.author)} · ${escHtml(when(f.created_at_ms))}</span></div>`
      + (t && movable(t) ? `<div class="ticket-attach-actions"><button type="button" class="ticket-file-replace" data-ticket="${escAttr(t.id)}" data-attachment="${escAttr(f.id)}" aria-label="Replace ${escAttr(f.name)}">${icon('replace')}</button>`
        + `<button type="button" class="ticket-file-remove${removeArmed === String(f.id) ? ' armed' : ''}" data-ticket="${escAttr(t.id)}" data-attachment="${escAttr(f.id)}" aria-label="${removeArmed === String(f.id) ? 'Confirm remove' : 'Remove'} ${escAttr(f.name)}">${icon('trash')}${removeArmed === String(f.id) ? '<span>Confirm remove</span>' : ''}</button></div>` : '')
      + `</li>`;
  }

  function filesHtml(t) {
    const n = attachCount(t);
    const head = `<h3 class="ticket-view-h">Attachments <span class="ticket-view-count">${n}</span></h3>`;
    if (n === 0) return `${head}<div class="ticket-notes-empty">No attachments</div>`;
    const c = files.get(t.id);
    if (c?.failed) return `${head}<div class="ticket-notes-empty">Could not read the attachments. <button type="button" class="ticket-files-retry" data-ticket="${escAttr(t.id)}">Retry</button></div>`;
    if (!c?.loaded) return `${head}<div class="ticket-notes-empty">Loading…</div>`;
    return `${head}<ul class="ticket-attach-list">${c.items.map((f) => fileItemHtml(f, t)).join('')}</ul>`;
  }

  // Upload each file with /upload, then link it to the ticket. One at a time; a refusal is reported and the
  // rest still go. Returns how many were attached.
  async function attachFiles(ticketId, list, ids = []) {
    let done = 0;
    for (const file of list) {
      const problem = fileProblem(file);
      if (problem) { addMessage({ from: 'system', to: HUMAN_NAME, text: `Attach failed: ${problem}`, ts: '' }); continue; }
      try {
        const fd = new FormData();
        fd.append('file', file);
        const up = await authedFetch('/upload', { method: 'POST', body: fd });
        if (!up.ok) throw new Error(await parseErrorBody(up));
        const { url } = await up.json();
        const ok = await act(`/tickets/${encodeURIComponent(ticketId)}/attachments`, { url, name: attachmentName(file.name) || 'file' }, 'attach');
        if (ok) { done++; ids.push(ok.attachment?.id); }
      } catch (e) {
        addMessage({ from: 'system', to: HUMAN_NAME, text: `Attach failed: ${file.name}: ${e?.message ?? e}`, ts: '' });
      }
    }
    return done;
  }

  function approvalHtml(t) {
    if (t.blast_radius !== 'high' || !t.approval_request_id) return '';
    const a = t.approval;
    if (a?.status === 'pending' && a.id === t.approval_request_id) {   // the human's question, with the same verdict call as the chat card
      return `<div class="ticket-approval-banner" role="group" aria-label="Approval needed"><div class="ticket-approval-text"><strong>Waiting for your approval.</strong> ${escHtml(t.assignee || 'The assignee')} asks to move this high-radius ticket to Done.</div>`
        + `<div class="ticket-approval-actions"><button type="button" data-approval="deny" data-request="${escAttr(t.approval_request_id)}">Deny</button><button type="button" class="primary" data-approval="allow" data-request="${escAttr(t.approval_request_id)}">Allow</button></div></div>`;
    }
    const state = !a ? 'waiting for approval'
      : a.status === 'pending' ? 'waiting for your approval'
      : a.status === 'allowed' && a.resolved_by === HUMAN_NAME ? `Approved by ${HUMAN_NAME}`
      : a.status === 'denied' && a.resolved_by === HUMAN_NAME ? `Denied by ${HUMAN_NAME}`
      : `request ${a.status}${a.resolved_by ? ` by ${a.resolved_by}` : ''} — not your approval`;
    return `<div class="ticket-approval">${escHtml(state)} · ${escHtml(t.approval_request_id)}</div>`;
  }

  // Allow and Deny in the banner: both are disabled while the call runs. The redraw that follows the permission event removes the banner.
  function wireApproval(root) {
    const btns = [...(root.querySelectorAll?.('[data-approval]') ?? [])];
    for (const b of btns) {
      b.addEventListener('click', async () => {
        btns.forEach((x) => { x.disabled = true; });
        try { await handlePermissionAction(b.dataset.request, b.dataset.approval); }
        finally { btns.forEach((x) => { x.disabled = false; }); }
      });
    }
  }

  // Only a finished ticket can be archived (the hub enforces it too); an archived one can be restored.
  const archivable = (t) => t.status === 'done' || t.status === 'cancelled';
  function archiveButton(t) {
    if (!archivable(t)) return '';
    const archived = !!t.archived_at_ms;
    return `<button type="button" class="ticket-archive" data-ticket="${escAttr(t.id)}" data-archive="${archived ? 'false' : 'true'}">${archived ? 'Unarchive' : 'Archive'}</button>`;
  }

  // Status light, macOS window-button style (the human's rules, id=233). Red: the ticket cannot advance without the
  // human: a pending approval, or the human is the assignee. Orange: an agent works on it now (claimed, in_progress).
  // Green: nobody works on it now: queued, and in_review, which waits for a check; it is green because no "check
  // started" state exists on the hub. Done and cancelled: no light. Only the active dot is lit.
  function lightOf(t) {
    if (t.status === 'done' || t.status === 'cancelled') return null;
    if (t.approval?.status === 'pending' || t.assignee === HUMAN_NAME) return ['red', 'waiting for the human'];
    if (t.status === 'claimed' || t.status === 'in_progress') return ['orange', 'an agent is busy with it'];
    return ['green', 'no one is working on it'];
  }
  function lightHtml(t) {
    const l = lightOf(t);
    if (!l) return '';
    return `<span class="ticket-light" role="img" aria-label="Status: ${escAttr(l[1])}" title="${escAttr(l[1])}">`
      + ['red', 'orange', 'green'].map((c) => `<i${c === l[0] ? ` class="on light-${c}"` : ''}></i>`).join('') + '</span>';
  }

  // Pure helpers for the card and the dialog (no DOM). parseTitle splits "[tag] 8.3a Main text [sub]"; when nothing is left
  // for `main`, the whole title is `main` and the other fields are null.
  function parseTitle(title) {
    const full = String(title ?? '');
    let rest = full.trim();
    let tag = null;
    const t = /^\[([^\]]+)\]\s*/.exec(rest);
    if (t) { tag = t[1].trim().toLowerCase(); rest = rest.slice(t[0].length); }
    let code = null;
    const c = /^(\S+)(?:\s+|$)/.exec(rest);
    if (c && /^\d+(\.\d+)*[a-z]?$/.test(c[1])) { code = c[1]; rest = rest.slice(c[0].length); }
    let sub = null;
    const u = /\s*\[([^\]]+)\]$/.exec(rest);
    if (u) { sub = u[1].trim(); rest = rest.slice(0, u.index); }
    const main = rest.trim();
    return main ? { tag, code, main, sub } : { tag: null, code: null, main: full, sub: null };
  }
  // Checklist lines of the criteria: "- [x]", "- [X]" and "- [ ]".
  function criteriaProgress(markdown) {
    let done = 0, total = 0;
    for (const line of String(markdown ?? '').split('\n')) {
      const m = /^- \[( |x|X)\]/.exec(line);
      if (!m) continue;
      total++;
      if (m[1] !== ' ') done++;
    }
    return { done, total };
  }
  const priorityBars = (t) => PRIORITIES[priorityKey(t)][0] - 1;
  // The one line under a card title. Same order as lightOf(): the approval and the human lines are the red light. A finished
  // ticket has no light and no line.
  function statusLine(t) {
    if (t.status === 'done' || t.status === 'cancelled') return null;
    if (t.approval?.status === 'pending') return 'Waiting for your approval';
    if (t.assignee === HUMAN_NAME) return 'Assigned to you';
    const n = openBlockers(t).length;
    return n > 0 ? `Blocked by ${n} open ${n === 1 ? 'ticket' : 'tickets'}` : null;
  }

  // The card's Cancel is a 26 px icon button; the armed state adds the word "Confirm" next to it (5 s).
  const buttonsHtml = (t) =>
    actionsFor(t).map(([to]) => to === 'cancelled' && cancelArmed === t.id
      ? `<button type="button" class="ticket-cancel-icon armed" data-ticket="${escAttr(t.id)}" data-to="cancelled" aria-label="Confirm cancel ticket ${escAttr(t.title)}">${icon('x')}<span>Confirm</span></button>`
      : `<button type="button" class="ticket-cancel-icon" data-ticket="${escAttr(t.id)}" data-to="${escAttr(to)}" aria-label="Cancel ticket ${escAttr(t.title)}">${icon('x')}</button>`).join('')
    + archiveButton(t);

  // The dialog's bottom row: "Cancel ticket" is terminal, so the first click arms it ("Confirm cancel", 5 s) and
  // the second cancels. No browser dialog.
  const rowButtonsHtml = (t) =>
    (isEditMode(t) && t.status !== 'draft'
      ? '<button type="button" class="ticket-discard-btn" id="ticket-discard-btn">Discard changes</button>'
      : movable(t) ? `<button type="button" class="ticket-cancel-btn${cancelArmed === t.id ? ' armed' : ''}" data-ticket="${escAttr(t.id)}" data-cancel="1">${cancelArmed === t.id ? 'Confirm cancel' : 'Cancel ticket'}</button>` : '')
    + (isEditMode(t) && t.status === 'draft' ? '<button type="button" class="ticket-discard-btn" id="ticket-discard-btn" hidden>Discard changes</button>' : '')
    + archiveButton(t);
  // Cancel is terminal: the first click on a card or on the dialog arms it ("Confirm cancel", 5 s), the second cancels.
  function cancelClick(id) {
    if (cancelArmed === id) {
      clearTimeout(cancelTimer); cancelArmed = null;
      act(`/tickets/${encodeURIComponent(id)}/transition`, { to: 'cancelled' }, 'cancelled');
      return;
    }
    cancelArmed = id;
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => { cancelArmed = null; render(); }, 5000);
    render();
  }
  function wireCancel(root) {
    root.querySelectorAll?.('.ticket-cancel-btn').forEach((btn) => btn.addEventListener('click', () => cancelClick(btn.dataset.ticket)));
  }

  // Open blockers, calculated from the tickets the board holds so a card and an open dialog follow a blocker's
  // status with no extra hub broadcast (design decision 8). A blocker is open until it is `done`: a cancelled
  // one still blocks. A blocker the board does not hold keeps the server's answer (`open_blockers`); absence
  // never counts as done.
  const blockerIds = (t) => (Array.isArray(t.blocked_by) ? t.blocked_by : []);
  function openBlockers(t) {
    const serverOpen = Array.isArray(t.open_blockers) ? t.open_blockers : [];
    return blockerIds(t).filter((id) => {
      const b = tickets.get(id);
      return b ? b.status !== 'done' : serverOpen.includes(id);
    });
  }
  function lockHtml(t) {
    const n = openBlockers(t).length;
    if (!n) return '';
    const label = `${n} open ${n === 1 ? 'blocker' : 'blockers'}`;
    return `<span class="ticket-lock" role="img" aria-label="${escAttr(label)}" title="${escAttr(label)}">&#128274; ${n}</span>`;
  }

  // Small inline icons (currentColor): no icon font and no image file.
  const ICONS = {
    layers: '<path d="M8 2 2 5l6 3 6-3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3"/>',
    lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
    check: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.5 8 2 2 3.5-4"/>',
    clip: '<path d="m13 7-5 5a3 3 0 0 1-4-4l5-5a2 2 0 0 1 3 3L7 11a1 1 0 0 1-2-2l4-4"/>',
    note: '<path d="M3 3h10v8H7l-3 3v-3H3z"/>',
    x: '<circle cx="8" cy="8" r="6"/><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4"/>',
    replace: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"/>',
  };
  const icon = (name) => `<svg class="ticket-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // The card, top to bottom: tag, code and priority; title and subtitle; chips; one status line; footer (assignee, counters, light).
  // The controls (Move to, Assignee, Cancel) stay in the markup but show only on hover or keyboard focus (P4).
  function cardHtml(t) {
    const p = parseTitle(t.title);
    const bars = priorityBars(t);
    const prioLabel = prio(t)[1];
    const status = statusLine(t);
    const approval = t.approval?.status === 'pending';
    const crit = criteriaProgress(t.acceptance_criteria);
    const files = attachCount(t), notes = noteCount(t);
    const chips = [
      t.request_id ? `<span class="ticket-chip">${icon('layers')}<span class="ticket-request-label">${escHtml(t.request_id)}</span></span>` : '',
      t.external_ref ? `<span class="ticket-chip">${escHtml(t.external_ref)}</span>` : '',
      t.blast_radius === 'high' ? '<span class="ticket-chip ticket-radius">High radius</span>' : '',
      t.archived_at_ms ? '<span class="ticket-chip">archived</span>' : '',
    ].join('');
    const who = t.assignee
      ? `<span class="ticket-who"><span class="ticket-avatar" aria-hidden="true">${escHtml(t.assignee.slice(0, 1).toUpperCase())}</span><span class="ticket-who-name">${escHtml(t.assignee)}</span>${assignHtml(t)}</span>`
      : `<span class="ticket-who ticket-unassigned"><span class="ticket-who-name">Unassigned</span>${assignHtml(t)}</span>`;
    const counters = [
      crit.total > 0 ? `<span class="ticket-count" title="Criteria checked">${icon('check')}${crit.done}/${crit.total}</span>` : '',
      files > 0 ? `<span class="ticket-count" title="Attachments">${icon('clip')}${files}</span>` : '',
      notes > 0 ? `<span class="ticket-count" title="Notes">${icon('note')}${notes}</span>` : '',
    ].join('');
    return `
      <div class="ticket-card status-${escAttr(t.status)}${t.archived_at_ms ? ' archived' : ''}" role="button" tabindex="0"${movable(t) ? ' draggable="true"' : ''} data-ticket="${escAttr(t.id)}" aria-label="Open ticket: ${escAttr(t.title)}">
        <div class="ticket-card-top">${p.tag ? `<span class="ticket-tag${p.tag === 'code' ? ' tag-code' : ''}">${escHtml(p.tag)}</span>` : ''}${p.code ? `<span class="ticket-code">${escHtml(p.code)}</span>` : ''}<span class="ticket-prio" title="Priority ${escAttr(prioLabel)}"><span class="ticket-bars" aria-hidden="true">${[1, 2, 3, 4].map((n) => `<i${n <= bars ? ' class="on"' : ''}></i>`).join('')}</span>${escHtml(prioLabel)}</span></div>
        <div class="ticket-title">${escHtml(p.main)}</div>
        ${p.sub ? `<div class="ticket-sub">${escHtml(p.sub)}</div>` : ''}
        ${chips ? `<div class="ticket-chips">${chips}</div>` : ''}
        ${status ? `<div class="ticket-status-line ${approval ? 'is-approval' : t.assignee === HUMAN_NAME ? 'is-human' : 'is-blocked'}">${icon(approval || t.assignee === HUMAN_NAME ? 'clock' : 'lock')}${escHtml(status)}</div>` : ''}
        <div class="ticket-card-foot">${who}<span class="ticket-counts">${counters}</span>${lightHtml(t)}</div>
        <div class="ticket-card-controls">
          ${moveHtml(t)}
          <div class="ticket-actions">${buttonsHtml(t)}</div>
        </div>
      </div>`;
  }

  // Drag and drop (native). A redraw during a drag would remove the dragged card and cancel the drag, so
  // render() waits until the drag ends.
  let dragId = null;
  let renderAfterDrag = false;
  function endDrag() {
    dragId = null;
    document.getElementById('ticket-board-columns')?.querySelectorAll?.('.dragging, .drop-target').forEach((n) => n.classList.remove('dragging', 'drop-target'));
    if (renderAfterDrag) { renderAfterDrag = false; render(); }
  }

  function wireDrag(el) {
    el.querySelectorAll('.ticket-card[draggable="true"]').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        if (e.target?.closest?.(INTERACTIVE) || moving.has(card.dataset.ticket)) { e.preventDefault(); return; }   // a control is not a drag handle
        dragId = card.dataset.ticket;
        card.classList.add('dragging');
        if (e.dataTransfer) { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; }
      });
      card.addEventListener('dragend', endDrag);
    });
    el.querySelectorAll('.ticket-col').forEach((col) => {
      // A column takes a card only from another column (no Cancelled column target: cancel is a button).
      const accepts = () => {
        const t = dragId ? tickets.get(dragId) : null;
        return !!(t && movable(t) && col.dataset.status && columnStatus(t) !== col.dataset.status);
      };
      col.addEventListener('dragover', (e) => {
        if (!accepts()) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        col.classList.add('drop-target');
      });
      col.addEventListener('dragleave', (e) => {
        if (!col.contains?.(e.relatedTarget)) col.classList.remove('drop-target');
      });
      col.addEventListener('drop', (e) => {
        if (!accepts()) return;
        e.preventDefault();
        const id = dragId, to = col.dataset.status;
        endDrag();
        moveTicket(id, to);
      });
    });
  }

  function render() {
    const el = document.getElementById('ticket-board-columns');
    if (!el) return;
    if (dragId) { renderAfterDrag = true; return; }
    if (!room) { el.innerHTML = '<div class="ticket-board-empty">Select a room to see its tickets</div>'; return; }
    const everything = [...tickets.values()].filter((t) => isVisible(t, filter));
    const all = everything.filter((t) => matchesFilter(t, filter)).sort((a, b) =>
      prio(b)[0] - prio(a)[0] || a.created_at_ms - b.created_at_ms);
    // The board has five columns; a sixth, Cancelled, appears only while "Show cancelled" is on.
    const columns = filter.showCancelled ? [...COLUMNS, CANCELLED] : COLUMNS;
    const archivable = all.filter((t) => t.status === 'done' && !t.archived_at_ms).length;
    updateFiltersButton(everything.length, all.length);
    syncRequestOptions();
    el.innerHTML = columns.map((c) => {
      const items = all.filter((t) => c.statuses.includes(t.status));
      const add = c.status ? `<button type="button" class="ticket-add" data-col="${escAttr(c.key)}" aria-label="Add a ticket to ${escAttr(c.label)}">+</button>` : '';
      // "Archive all done" lives in the Done column's header (the filters panel has no actions).
      const archiveAllBtn = c.key === 'done'
        ? `<button type="button" class="ticket-archive-all"${archivable === 0 || archivingAll ? ' disabled' : ''}>${archivable ? `Archive all done (${archivable})` : 'Archive all done'}</button>`
        : '';
      // An empty column is a 40 px strip (count, vertical label, "+"): it stays a drop target. A column with tickets has its "+" in the header.
      if (!items.length) return `<section class="ticket-col collapsed" data-status="${escAttr(c.status ?? '')}"><h3>${escHtml(c.label)} <span class="count">0</span></h3>${add}</section>`;
      return `<section class="ticket-col" data-status="${escAttr(c.status ?? '')}"><h3>${escHtml(c.label)} <span class="count">${items.length}</span>${archiveAllBtn}${add}</h3>${items.map(cardHtml).join('')}</section>`;
    }).join('');
    el.querySelectorAll('.ticket-add').forEach((btn) => {
      btn.addEventListener('click', () => openNew(btn.dataset.col));
    });
    wireActions(el);
    el.querySelectorAll('.ticket-archive-all').forEach((btn) => btn.addEventListener('click', archiveAllDone));
    el.querySelectorAll('.ticket-card').forEach(wireCard);
    wireDrag(el);
    wireNotes(el);
    refreshView();
  }

  // The card actions, wired on any root that holds them (the board, or the open ticket's dialog).
  function wireActions(root) {
    root.querySelectorAll('.ticket-assign').forEach((sel) => {
      sel.addEventListener('change', async () => {
        if (sel.value === (sel.dataset.current ?? '')) return;
        // The empty choice (queued cards only) unassigns: the hub takes null.
        const ok = await act(`/tickets/${encodeURIComponent(sel.dataset.ticket)}/assign`, { assignee: sel.value || null }, 'assign');
        if (!ok) render();  // refused: put the select back on the real assignee
      });
    });
    root.querySelectorAll('.ticket-move').forEach((sel) => {
      sel.addEventListener('change', () => moveTicket(sel.dataset.ticket, sel.value));
    });
    root.querySelectorAll('.ticket-archive').forEach((btn) => {
      btn.addEventListener('click', () => act(`/tickets/${encodeURIComponent(btn.dataset.ticket)}/archive`, { archived: btn.dataset.archive === 'true' }, 'archive'));
    });
    root.querySelectorAll('.ticket-actions button[data-to], #ticket-view-row-actions button[data-to]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ticket, to = btn.dataset.to;
        if (to === 'cancelled') { cancelClick(id); return; }   // terminal: needs a second click
        const base = `/tickets/${encodeURIComponent(id)}`;
        act(`${base}/transition`, { to }, to);
      });
    });
  }

  // The controls mirror `filter`: set them whenever the filter changes or the room does.
  function syncFilterControls() {
    for (const v of RADII) {
      const r = document.getElementById(`ticket-filter-radius-${v}`);
      if (r) r.checked = filter.radius === v;
    }
    syncRequestOptions();
    const sa = document.getElementById('ticket-show-archived');
    if (sa) sa.checked = filter.showArchived;
    const sc = document.getElementById('ticket-show-cancelled');
    if (sc) sc.checked = filter.showCancelled;
    for (const key of Object.keys(PRIORITIES)) {
      const cb = document.getElementById(`ticket-filter-p-${key}`);
      if (cb) cb.checked = filter.priorities.includes(key);
    }
  }

  // The request select lists the labels of the tickets the board can show (a chosen label with no visible ticket resets to All requests in render()).
  // A request filter whose tickets are all hidden or gone would show an empty board: fall back to "All requests".
  // Called after a successful list read and after the human changes a filter, never from render() (which also runs
  // before the first list arrives, when the board knows nothing yet).
  let listLoaded = false;   // a list read of the current room has succeeded
  function dropStaleRequest() {
    if (filter.request === '' || [...tickets.values()].some((t) => isVisible(t, filter) && t.request_id === filter.request)) return;
    filter = { ...filter, request: '' };
    try { localStorage.setItem(FILTER_KEY(room), JSON.stringify({ ...filter, v: 2 })); } catch { /* keep it in memory */ }
    syncFilterControls();
  }

  function syncRequestOptions() {
    const sel = document.getElementById('ticket-filter-request');
    if (!sel) return;
    const labels = new Set([...tickets.values()].filter((t) => isVisible(t, filter)).map((t) => t.request_id).filter(Boolean));
    sel.innerHTML = '<option value="">All requests</option>'
      + [...labels].sort().map((l) => `<option value="${escAttr(l)}">${escHtml(l)}</option>`).join('');
    sel.value = filter.request;
  }

  // The room lead triages unassigned tickets. Only the human sets it. The select lives in the top bar, so
  // it follows the SELECTED room (not the board's loaded room) and works with the board closed. With
  // "All rooms" there is no room to lead: the control is hidden.
  const leadAgents = () => {
    const r = boardRoom();
    return (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER) ? ROSTER : [])
      .filter((a) => a.room === r && a.name !== HUMAN_NAME)
      .map((a) => a.name);
  };

  function renderLead() {
    const sel = document.getElementById('ticket-lead');
    const wrap = document.getElementById('ticket-lead-wrap');
    const r = boardRoom();
    if (wrap) wrap.hidden = !r;
    if (!sel) return;
    const names = leadAgents();
    if (lead && !names.includes(lead)) names.push(lead);   // removed from the roster: keep it shown
    sel.innerHTML = '<option value="">No lead</option>'
      + names.map((n) => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('');
    sel.value = lead ?? '';
    sel.disabled = !r;
  }

  async function loadLead() {
    const target = boardRoom(), seq = ++leadSeq;
    lead = null;
    renderLead();
    if (!target) return;
    try {
      const r = await authedFetch(`/rooms/${encodeURIComponent(target)}/lead`);
      if (!r.ok || seq !== leadSeq || target !== boardRoom()) return;
      const body = await r.json();
      if (seq !== leadSeq || target !== boardRoom()) return;
      lead = typeof body?.lead === 'string' && body.lead ? body.lead : null;
    } catch (e) {
      console.warn('[tickets] lead read failed:', e);
    }
    renderLead();
  }

  // The hub announces a lead change (ambient "room.lead" entry): follow it, whoever made it.
  // main.js stops at a kind that has an observer, so the entry never renders as a chat line.
  function onRoomLead(event) {
    if (!event || event.room !== boardRoom()) return;
    leadSeq++;   // a read still in flight is older than this entry
    leadWrite++;   // so is a save
    lead = typeof event.lead === 'string' && event.lead ? event.lead : null;
    renderLead();
  }

  async function setLead(agent) {
    const target = boardRoom();   // the answer belongs to this room, whatever is selected by then
    if (!target) return;
    leadSeq++;   // a read still in flight is older than this save
    const seq = ++leadWrite;
    const ok = await act(`/rooms/${encodeURIComponent(target)}/lead`, { agent: agent || null }, 'lead');
    if (target !== boardRoom()) return;   // switched rooms meanwhile: do not overwrite the other room's lead
    if (seq !== leadWrite) return;   // a newer room.lead event or save already set the lead
    if (ok) { lead = agent || null; leadSeq++; }   // a read that began during the save may predate it: stale
    renderLead();   // refused: the select goes back to the real lead
  }

  // The "Filters" button: how many of the five filter dimensions are active (radius, request, priority, archived,
  // cancelled), and the "Showing N of M" summary beside it.
  const activeFilterCount = (f) =>
    (f.radius !== 'all' ? 1 : 0) + (f.request !== '' ? 1 : 0) + (f.priorities.length !== Object.keys(PRIORITIES).length ? 1 : 0)
    + (f.showArchived ? 1 : 0) + (f.showCancelled ? 1 : 0);

  function updateFiltersButton(total, shown) {
    const n = activeFilterCount(filter);
    const btn = document.getElementById('ticket-filters-btn');
    if (btn) {
      btn.textContent = n ? `Filters · ${n}` : 'Filters';
      btn.classList.toggle('active', n > 0);
      btn.setAttribute?.('aria-label', n ? `Filters, ${n} active` : 'Filters');
    }
    const summary = document.getElementById('ticket-filter-summary');
    if (summary && total !== undefined) summary.textContent = isDefaultFilter(filter) ? `All ${shown} ${shown === 1 ? 'ticket' : 'tickets'}` : `Showing ${shown} of ${total} tickets`;
  }

  // ---- The filters panel: a popover below the button; changes apply live ----
  let filterPanelOpen = false;

  function setFilterPanel(open, { focusButton = false } = {}) {
    const panel = document.getElementById('ticket-filter-panel');
    const btn = document.getElementById('ticket-filters-btn');
    if (!panel || !btn) return;
    if (open === filterPanelOpen && panel.hidden === !open) return;
    filterPanelOpen = open;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) document.getElementById(`ticket-filter-radius-${filter.radius}`)?.focus?.();
    else if (focusButton) btn.focus?.();
  }

  // A click outside closes it. Focus goes back to the button unless the click already put it on another
  // control (the human clicked into a field): taking it away from there would be rude.
  function onDocumentClick(e) {
    if (!filterPanelOpen) return;
    const panel = document.getElementById('ticket-filter-panel');
    const btn = document.getElementById('ticket-filters-btn');
    if (panel?.contains?.(e.target) || btn?.contains?.(e.target)) return;
    const a = document.activeElement;
    const free = !a || a === document.body || panel?.contains?.(a);
    setFilterPanel(false, { focusButton: free });
  }

  function onDocumentKeydown(e) {
    if (e.key === 'Escape' && filterPanelOpen) {
      e.preventDefault?.();
      setFilterPanel(false, { focusButton: true });
    }
  }

  function setFilter(next) {
    const before = filter.showArchived;
    filter = sanitizeFilter(next);
    dropStaleRequest();
    if (room) {
      try { localStorage.setItem(FILTER_KEY(room), JSON.stringify({ ...filter, v: 2 })); } catch { /* storage full or blocked: keep it in memory */ }
    }
    syncFilterControls();
    render();
    updateFiltersButton();
    if (filter.showArchived !== before) load();   // archived tickets come from the hub only on request
  }

  // One call per ticket, in order, stopping at the first refusal (act() has reported it). Only the
  // done tickets on screen are archived: the filters decide what "all" is.
  async function archiveAllDone() {
    if (archivingAll || !room) return;
    const ids = [...tickets.values()]
      .filter((t) => isVisible(t, filter) && matchesFilter(t, filter) && t.status === 'done' && !t.archived_at_ms)
      .sort((a, b) => a.created_at_ms - b.created_at_ms)
      .map((t) => t.id);
    archivingAll = true;
    render();
    try {
      for (const id of ids) {
        if (!(await act(`/tickets/${encodeURIComponent(id)}/archive`, { archived: true }, 'archive'))) break;
      }
    } finally {
      archivingAll = false;
      render();
    }
  }

  // ---- The ticket's full view: a native <dialog> over the board, opened from a card ----
  // A click on a control inside the card (move, archive, reassign, criteria) never opens it.
  const INTERACTIVE = 'button, select, a, summary, details, input, label';
  let viewId = null;      // the ticket whose view is open
  let viewOpener = null;  // the card to give the focus back to

  function wireCard(card) {
    card.addEventListener('click', (e) => {
      if (e.target?.closest?.(INTERACTIVE)) return;
      openView(card.dataset.ticket, card);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;   // keys inside a control belong to it
      e.preventDefault();
      openView(card.dataset.ticket, card);
    });
  }

  const when = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '—');

  // ---- Blockers (P8): rows with a status icon, the code, the title, a status pill, and in edit mode a remove button ----
  let pickerOpen = false;   // the "Add blocker" search is open
  let pickerQuery = '';
  let pickerIndex = 0;      // the highlighted option

  // The blocker ids the dialog shows: the typed list in edit mode, the ticket's own list otherwise.
  const shownBlockerIds = (t) => (isEditMode(t) ? formValues(t).blockers.split(',').map((x) => x.trim()).filter(Boolean) : blockerIds(t));
  // Is this blocker still open? Done is closed; a cancelled blocker still blocks. A blocker the board does not hold keeps the server's answer.
  const blockerOpen = (t, id) => { const b = tickets.get(id); return b ? b.status !== 'done' : Array.isArray(t.open_blockers) && t.open_blockers.includes(id); };

  function blockerRowHtml(t, id, edit) {
    const b = tickets.get(id);
    const open = blockerOpen(t, id);
    const p = b ? parseTitle(b.title) : null;
    const code = p?.code ?? null;
    const title = b ? p.main : id;
    const state = b ? (STATUS_PILL[b.status] ?? b.status) : (open ? 'Open' : 'Done');
    const name = code ?? title;
    return `<li class="ticket-blocker-row ${open ? 'blocker-open' : 'blocker-done'}">`
      + `<span class="ticket-blocker-icon" aria-hidden="true">${icon(open ? 'lock' : 'check')}</span>`
      + (code ? `<span class="ticket-code">${escHtml(code)}</span>` : '')
      + `<span class="ticket-blocker-title" title="${escAttr(title)}">${escHtml(title)}</span>`
      + `<span class="ticket-pill ticket-blocker-state ${open ? 'is-open' : 'is-done'}">${escHtml(state)}</span>`
      + (edit ? `<button type="button" class="ticket-blocker-remove" data-id="${escAttr(id)}" aria-label="Remove blocker ${escAttr(name)}">${icon('x')}</button>` : '')
      + `</li>`;
  }

  // Candidates for the picker: the room's tickets without this ticket and its current blockers, and without a ticket that already
  // waits (through the board's own blocker lists) on this one, which would close a loop. The hub still has the last word.
  function blockerCandidates(t, query) {
    const have = new Set(shownBlockerIds(t));
    const waitsOn = (from, target, seen = new Set()) => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return blockerIds(tickets.get(from) ?? {}).some((x) => waitsOn(x, target, seen));
    };
    const q = String(query ?? '').trim().toLowerCase();
    const rank = (x) => (x.status === 'done' ? 1 : 0);
    return [...tickets.values()]
      .filter((c) => c.id !== t.id && c.status !== 'cancelled' && !have.has(c.id) && !waitsOn(c.id, t.id))   // a cancelled blocker would block for ever
      .map((c) => ({ c, p: parseTitle(c.title) }))
      .filter(({ c, p }) => !q || (p.code ?? '').toLowerCase().includes(q) || p.main.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
      .sort((a, b) => rank(a.c) - rank(b.c) || String(a.p.code ?? '~').localeCompare(String(b.p.code ?? '~'), undefined, { numeric: true }) || a.p.main.localeCompare(b.p.main))
      .map(({ c }) => c);
  }

  function pickerOptionsHtml(t) {
    const list = blockerCandidates(t, pickerQuery);
    if (pickerIndex >= list.length) pickerIndex = Math.max(0, list.length - 1);
    if (!list.length) return '<li class="ticket-blocker-none" role="presentation">No ticket matches</li>';
    return list.map((c, n) => {
      const p = parseTitle(c.title);
      return `<li role="option" id="ticket-blocker-opt-${n}" class="ticket-blocker-opt${n === pickerIndex ? ' active' : ''}" data-id="${escAttr(c.id)}" aria-selected="${n === pickerIndex}">`
        + (p.code ? `<span class="ticket-code">${escHtml(p.code)}</span>` : '')
        + `<span class="ticket-blocker-title">${escHtml(p.main)}</span><span class="ticket-pill pill-${escAttr(c.status === 'claimed' ? 'in_progress' : c.status)}">${escHtml(STATUS_PILL[c.status] ?? c.status)}</span></li>`;
    }).join('');
  }

  function blockersHtml(t) {
    const edit = isEditMode(t);
    const ids = shownBlockerIds(t);
    if (!ids.length && !edit) return '';
    const open = ids.filter((id) => blockerOpen(t, id)).length;
    const head = `<h3 class="ticket-view-h ticket-view-h-strong">Blocked by <span class="ticket-view-count">${open ? `${open} open` : 'none open'}</span></h3>`;
    const rows = `<ul class="ticket-view-blockers">${ids.map((id) => blockerRowHtml(t, id, edit)).join('')}</ul>`;
    if (!edit) return head + rows;
    const options = pickerOptionsHtml(t);
    const picker = pickerOpen
      ? `<div class="ticket-blocker-box" id="ticket-blocker-box"><input id="ticket-edit-blockers-search" type="text" role="combobox" aria-expanded="true" aria-controls="ticket-blocker-listbox" aria-autocomplete="list"`
        + ` aria-activedescendant="ticket-blocker-opt-${pickerIndex}" aria-label="Search tickets to add as a blocker" placeholder="Search by code or title" value="${escAttr(pickerQuery)}" autocomplete="off" />`
        + `<ul id="ticket-blocker-listbox" role="listbox" aria-label="Tickets in this room">${options}</ul>`
        + `<div class="ticket-view-hint">Tickets in this room. The ticket itself and tickets that would make a loop are left out. Esc to close.</div></div>`
      : '';
    // The group keeps the id ticket-edit-blockers: Save reads its ids from data-ids, and a refused list shows its error under it.
    return head + `<div id="ticket-edit-blockers" class="ticket-blocker-edit" role="group" aria-label="Blockers" tabindex="-1" data-ids="${escAttr(ids.join(','))}"${invalidAttr('blockers')}>`
      + rows
      + `<button type="button" id="ticket-blocker-add" class="ticket-blocker-add" aria-expanded="${pickerOpen}"${pickerOpen ? ' aria-controls="ticket-blocker-box"' : ''}>+ Add blocker</button>${picker}</div>${fieldError('blockers')}`;
  }

  // The human edits an open ticket in the dialog. A draft shows every field (the New ticket dialog's order); a
  // queued ticket shows request and blocked by; other statuses show no editor. What the human has typed survives
  // a redraw (`viewDraft`), because a blocker's event redraws the open dialog. One Save, in the bottom row, submits
  // the form through its `form` attribute and sends only the fields that differ from the ticket.
  let viewDraft = null;      // { id, title, criteria, radius, priority, assignee, ref, request, blockers } once the human types
  let viewError = '';        // the hub's refusal of the last Save
  let viewErrorField = '';   // the form field the refusal is about ('' = none: the message shows above the action row)
  let unsavedPrompt = false; // Close with changes asks first
  let cancelArmed = null;    // ticket id whose "Cancel ticket" was clicked once (5 s)
  let cancelTimer = null;
  // Read mode and edit mode (15.6). A draft opens in edit mode and has no Edit button. Every other open ticket opens in read mode
  // with an Edit button; Edit unlocks every field. A finished ticket (done, cancelled) has no editor: the hub refuses it.
  let viewEditing = false;   // the human clicked Edit on a ticket that is not a draft
  let critTab = 'write';     // the criteria editor's tab: 'write' or 'preview'
  const canEdit = (t) => t.status !== 'done' && t.status !== 'cancelled';
  const isEditMode = (t) => canEdit(t) && (t.status === 'draft' || viewEditing);
  const editable = isEditMode;

  const formValues = (t) => {
    const d = viewDraft && viewDraft.id === t.id ? viewDraft : null;
    const v = {
      request: d ? d.request : (t.request_id || ''),
      blockers: d ? d.blockers : blockerIds(t).join(', '),
    };
    if (isEditMode(t)) {
      Object.assign(v, {
        title: d ? d.title : t.title,
        criteria: d ? d.criteria : (t.acceptance_criteria || ''),
        radius: d ? d.radius : t.blast_radius,
        priority: d ? d.priority : priorityKey(t),
        assignee: d ? d.assignee : (t.assignee || ''),
        ref: d ? d.ref : (t.external_ref || ''),
      });
    }
    return v;
  };

  // What Save would send: the edit body (changed fields only) and the assignee when it changed.
  function diffOf(t, v) {
    const body = {};
    if (v.title !== undefined && v.title !== t.title) body.title = v.title;
    if (v.criteria !== undefined && v.criteria !== (t.acceptance_criteria || '')) body.acceptance_criteria = v.criteria;
    if (v.radius !== undefined && v.radius !== t.blast_radius) body.blast_radius = v.radius;
    if (v.priority !== undefined && v.priority !== priorityKey(t)) body.priority = v.priority;
    if (v.ref !== undefined && (v.ref.trim() || null) !== (t.external_ref || null)) body.external_ref = v.ref.trim() || null;
    const request = v.request.trim() || null;
    if (request !== (t.request_id || null)) body.request_id = request;
    const blocked_by = v.blockers.split(',').map((x) => x.trim()).filter(Boolean);
    const have = blockerIds(t);
    if (blocked_by.length !== have.length || blocked_by.some((b) => !have.includes(b))) body.blocked_by = blocked_by;
    const assign = v.assignee !== undefined && v.assignee !== (t.assignee || '') ? v.assignee : undefined;
    return { body, assign };
  }
  const hasChanges = (d) => Object.keys(d.body).length > 0 || d.assign !== undefined;
  function viewDirty() {
    const t = viewId ? tickets.get(viewId) : null;
    return !!(t && editable(t) && viewDraft && viewDraft.id === t.id && hasChanges(diffOf(t, viewDraft)));
  }

  // Which field a hub refusal is about, read from its text ("invalid blocker id: X", "invalid request_id", ...).
  const ERROR_FIELDS = [[/blocker|blocked_by|cycle/i, 'blockers'], [/request_id/i, 'request'], [/title/i, 'title'], [/acceptance_criteria/i, 'criteria'],
    [/blast_radius/i, 'radius'], [/priority/i, 'priority'], [/external_ref/i, 'ref']];
  const errorField = (text) => ERROR_FIELDS.find(([re]) => re.test(text))?.[1] ?? '';
  // A refused Save: the message under its field (red border, aria-invalid, role alert), or above the action row when no field fits.
  function setViewError(text, field = errorField(text)) {
    viewError = text;
    viewErrorField = document.getElementById(`ticket-edit-${field}`) ? field : '';
    if (viewErrorField) { refreshView(); document.getElementById(`ticket-edit-${viewErrorField}`)?.focus?.(); }
    renderNotice();
  }
  const invalidAttr = (key) => (viewError && viewErrorField === key ? ` aria-invalid="true" aria-describedby="ticket-edit-${key}-error"` : '');
  const fieldError = (key) => (viewError && viewErrorField === key
    ? `<div class="ticket-field-error" id="ticket-edit-${key}-error" role="alert">Not saved: ${escHtml(viewError)}</div>` : '');

  const critProgressText = (md) => { const c = criteriaProgress(md); return c.total ? `${c.done} of ${c.total} checked` : ''; };

  // The editor, in two places. Main column (here): the criteria with their toolbar and the blocker ids. Properties panel
  // (panelFieldsHtml): assignee, priority, blast radius, request and external ref. The title is the header's input. All of them are
  // read by wireRequestForm and sent by the one Save.
  function requestFormHtml(t) {
    if (!isEditMode(t)) return '';
    const v = formValues(t);
    const md = (a, label, html) => `<button type="button" data-edit-md="${a}" aria-label="${label}">${html}</button>`;
    const pendingApproval = t.approval?.status === 'pending';
    return (pendingApproval
        ? `<div class="ticket-edit-warning" role="note">This ticket waits for your approval. If you save new acceptance criteria or set the blast radius to low, ${escHtml(t.assignee || 'the assignee')}'s approval request is cancelled.</div>` : '')
      + `<form class="ticket-request-form" id="ticket-request-form">`
      + `<div class="ticket-crit-head"><label for="ticket-edit-criteria">Acceptance criteria <span class="ticket-view-count" id="ticket-edit-progress">${critProgressText(v.criteria)}</span></label>`
      + `<div class="ticket-tabs" role="tablist" aria-label="Acceptance criteria">`
      + ['write', 'preview'].map((k) => `<button type="button" role="tab" id="ticket-tab-${k}" aria-controls="ticket-pane-${k}" aria-selected="${critTab === k}" tabindex="${critTab === k ? 0 : -1}">${k === 'write' ? 'Write' : 'Preview'}</button>`).join('')
      + `</div></div><div id="ticket-pane-write" role="tabpanel" aria-labelledby="ticket-tab-write"${critTab === 'write' ? '' : ' hidden'}>`
      + `<div class="md-toolbar" role="toolbar" aria-label="Format the acceptance criteria" aria-controls="ticket-edit-criteria">`
      + md('bold', 'Bold', '<b>B</b>') + md('bullet', 'Bulleted list', '&#8226;') + md('checklist', 'Checklist item', '&#9744;') + md('code', 'Inline code', '<code>&lt;/&gt;</code>')
      + `</div><textarea id="ticket-edit-criteria" rows="4" spellcheck="false"${invalidAttr('criteria')}>${escHtml(v.criteria)}</textarea>${fieldError('criteria')}</div>`
      + `<div id="ticket-pane-preview" class="ticket-view-criteria md" role="tabpanel" aria-labelledby="ticket-tab-preview"${critTab === 'preview' ? '' : ' hidden'}>${mdHtml(v.criteria)}</div></form>`;
  }

  // The panel rows in edit mode: the same order as read mode, each with its input.
  function panelFieldsHtml(t) {
    const v = formValues(t);
    const opt = (val, label, cur) => `<option value="${escAttr(val)}"${val === cur ? ' selected' : ''}>${escHtml(label)}</option>`;
    const names = roomAgents();
    if (t.assignee && !names.includes(t.assignee)) names.push(t.assignee);
    const row = (k, id, inner, key) => `<dt><label for="${id}">${escHtml(k)}</label></dt><dd>${inner}${fieldError(key)}</dd>`;
    return row('Assignee', 'ticket-edit-assignee', `<select id="ticket-edit-assignee"${invalidAttr('assignee')}><option value=""${v.assignee ? '' : ' selected'}>Unassigned</option>${names.map((n) => opt(n, n, v.assignee)).join('')}</select>`, 'assignee')
      + row('Priority', 'ticket-edit-priority', `<select id="ticket-edit-priority"${invalidAttr('priority')}>${Object.entries(PRIORITIES).map(([k, p]) => opt(k, p[1], v.priority)).join('')}</select>`, 'priority')
      + `<dt id="ticket-edit-radius-label">Blast radius</dt><dd><div class="ticket-radio-pair" id="ticket-edit-radius" role="radiogroup" aria-labelledby="ticket-edit-radius-label"${invalidAttr('radius')}>`
      + ['low', 'high'].map((r) => `<label class="ticket-radio${r === 'high' ? ' is-high' : ''}"><input type="radio" name="ticket-edit-radius" value="${r}"${v.radius === r ? ' checked' : ''} /><span>${r === 'low' ? 'Low' : 'High'}</span></label>`).join('')
      + `</div>${fieldError('radius')}</dd>`
      + row('Request', 'ticket-edit-request', `<input id="ticket-edit-request" value="${escAttr(v.request)}" autocomplete="off" maxlength="64"${invalidAttr('request')} />`, 'request')
      + row('External ref', 'ticket-edit-ref', `<input id="ticket-edit-ref" value="${escAttr(v.ref)}" autocomplete="off"${invalidAttr('ref')} />`, 'ref');
  }

  // The line above the action row: the unsaved-changes question, or the hub's refusal of the last Save.
  function renderNotice() {
    const n = document.getElementById('ticket-view-notice');
    if (!n) return;
    if (unsavedPrompt) {
      n.innerHTML = `<span class="ticket-view-notice-text">Unsaved changes</span> <button type="button" id="ticket-view-discard">Discard</button> <button type="button" id="ticket-view-keep">Keep editing</button>`;
      n.querySelector?.('#ticket-view-discard')?.addEventListener('click', () => { viewDraft = null; unsavedPrompt = false; viewError = ''; viewErrorField = ''; viewEditing = false; closeView(); });
      n.querySelector?.('#ticket-view-keep')?.addEventListener('click', () => {
        unsavedPrompt = false; renderNotice();
        document.querySelector?.('#ticket-view-content input, #ticket-view-content textarea')?.focus?.();
      });
    } else {
      n.innerHTML = viewError && !viewErrorField ? `<span class="ticket-view-notice-text ticket-view-notice-error">Not saved: ${escHtml(viewError)}</span>` : '';
    }
  }

  // Close, the backdrop and Escape all come here: changes ask first.
  function requestClose() {
    if (viewDirty()) {
      unsavedPrompt = true;
      renderNotice();
      // The focus goes to "Keep editing", so Tab reaches Discard and Keep editing in order. Escape reaches here from the dialog's cancel
      // event, after which the browser may move the focus: set it again once the event is over.
      const keep = () => document.getElementById('ticket-view-keep')?.focus?.();
      keep();
      setTimeout(keep, 0);
      return;
    }
    closeView();
  }

  // The number of fields that differ from the ticket: "N unsaved changes" next to Save.
  function dirtyCount() {
    const t = viewId ? tickets.get(viewId) : null;
    if (!t || !isEditMode(t) || !viewDraft || viewDraft.id !== t.id) return 0;
    const d = diffOf(t, viewDraft);
    return Object.keys(d.body).length + (d.assign !== undefined ? 1 : 0);
  }
  function refreshSave() {
    const t = viewId ? tickets.get(viewId) : null;
    const save = document.getElementById('ticket-view-save');
    if (!save) return;
    save.hidden = !(t && isEditMode(t));
    save.disabled = !viewDirty();
    const n = dirtyCount();
    const dirty = document.getElementById('ticket-view-dirty');
    if (dirty) { dirty.textContent = n ? `${n} unsaved ${n === 1 ? 'change' : 'changes'}` : ''; dirty.hidden = !n; }
    const discard = document.getElementById('ticket-discard-btn');
    if (discard) discard.hidden = !n && t?.status === 'draft';
  }

  // Discard changes: leave edit mode (a draft stays in it and gets its fields back) and drop what was typed.
  function discardChanges() {
    viewDraft = null; viewError = ''; viewErrorField = ''; unsavedPrompt = false; pickerOpen = false; pickerQuery = ''; pickerIndex = 0;
    const t = viewId ? tickets.get(viewId) : null;
    if (t && t.status !== 'draft') viewEditing = false;
    refreshView();
  }

  // Change the blocker list: it goes into the typed values like any field, the list redraws, and the keyboard stays on the control.
  function commitBlockers(ids, focus = '#ticket-blocker-add') {
    const t = viewId ? tickets.get(viewId) : null;
    if (!t) return;
    viewDraft = { ...formValues(t), ...(viewDraft && viewDraft.id === t.id ? viewDraft : {}), id: t.id, blockers: ids.join(', ') };
    if (viewErrorField === 'blockers') { viewError = ''; viewErrorField = ''; }
    refreshView();
    refreshSave();                                   // Save and "N unsaved changes" follow the new list at once
    document.querySelector?.(focus)?.focus?.();
  }

  function closePicker(focus = true) {
    pickerOpen = false; pickerQuery = ''; pickerIndex = 0;
    refreshView();
    if (focus) document.getElementById('ticket-blocker-add')?.focus?.();
  }

  // Remove buttons, "Add blocker" and the search: the ARIA combobox pattern. Up and Down move, Enter adds, Escape closes.
  function wireBlockerPicker(root) {
    const t = viewId ? tickets.get(viewId) : null;
    if (!t || !isEditMode(t)) return;
    const group = root.querySelector?.('#ticket-edit-blockers');
    root.querySelectorAll?.('.ticket-blocker-remove').forEach((b) => b.addEventListener('click', () => {
      commitBlockers(shownBlockerIds(t).filter((id) => id !== b.dataset.id), '#ticket-blocker-add');
    }));
    root.querySelector?.('#ticket-blocker-add')?.addEventListener('click', () => {
      if (pickerOpen) { closePicker(); return; }
      pickerOpen = true; pickerQuery = ''; pickerIndex = 0;
      refreshView();
      document.getElementById('ticket-edit-blockers-search')?.focus?.();
    });
    const search = root.querySelector?.('#ticket-edit-blockers-search');
    if (!search) return;
    const list = () => blockerCandidates(t, pickerQuery);
    const paint = () => {
      const ul = root.querySelector?.('#ticket-blocker-listbox');
      if (ul) ul.innerHTML = pickerOptionsHtml(t);
      search.setAttribute?.('aria-activedescendant', `ticket-blocker-opt-${pickerIndex}`);
      ul?.querySelectorAll?.('.ticket-blocker-opt').forEach((o) => o.addEventListener('mousedown', (e) => { e.preventDefault?.(); add(o.dataset.id); }));
    };
    const add = (id) => { if (!id) return; pickerOpen = false; pickerQuery = ''; pickerIndex = 0; commitBlockers([...shownBlockerIds(t), id]); };
    search.addEventListener('input', () => { pickerQuery = search.value; pickerIndex = 0; paint(); });
    search.addEventListener('keydown', (e) => {
      const n = list().length;
      if (e.key === 'ArrowDown') { e.preventDefault?.(); if (n) { pickerIndex = (pickerIndex + 1) % n; paint(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault?.(); if (n) { pickerIndex = (pickerIndex - 1 + n) % n; paint(); } }
      else if (e.key === 'Enter') { e.preventDefault?.(); e.stopPropagation?.(); add(list()[pickerIndex]?.id); }   // Enter adds; it does not submit the form
      else if (e.key === 'Escape') { e.preventDefault?.(); e.stopPropagation?.(); closePicker(); }
    });
    root.querySelectorAll?.('.ticket-blocker-opt').forEach((o) => o.addEventListener('mousedown', (e) => { e.preventDefault?.(); add(o.dataset.id); }));
    void group;
  }

  function wireRequestForm(root) {
    const form = root.querySelector?.('#ticket-request-form');
    if (!form) return;
    const q = (id) => root.querySelector(`#ticket-edit-${id}`) ?? document.getElementById('ticket-view-actions')?.querySelector?.(`#ticket-edit-${id}`)
      ?? document.getElementById('ticket-view-title')?.querySelector?.(`#ticket-edit-${id}`) ?? null;   // the fields are in the panel and the header's title input
    const f = { request: q('request'), blockers: q('blockers'), title: q('title'), criteria: q('criteria'), radius: q('radius'), priority: q('priority'), assignee: q('assignee'), ref: q('ref') };
    // The blast radius is a radio pair: its value is the checked radio. Every other field has a value of its own.
    // The blockers are a list the picker changes through commitBlockers(), not a field the human types in: the typed values hold it, never the DOM
    // (a typed letter in the search box bubbles an input event to the group, which must not rewrite the list).
    const valueOf = (k, el) => (k === 'radius' && typeof el.querySelector === 'function' ? (el.querySelector('input:checked')?.value ?? '') : el.value);
    const read = () => {
      const t = viewId ? tickets.get(viewId) : null;
      const own = Object.fromEntries(Object.entries(f).filter(([k, el]) => el && k !== 'blockers').map(([k, el]) => [k, valueOf(k, el)]));
      return f.blockers && t ? { ...own, blockers: formValues(t).blockers } : own;
    };
    const remember = (key) => {
      viewDraft = { id: viewId, ...read() };
      if (viewError && (!viewErrorField || viewErrorField === key)) {   // editing the refused field (or any field, for a message with no field) clears the error
        if (viewErrorField) { f[viewErrorField]?.removeAttribute?.('aria-invalid'); f[viewErrorField]?.removeAttribute?.('aria-describedby'); root.querySelector?.(`#ticket-edit-${viewErrorField}-error`)?.remove?.(); }
        viewError = ''; viewErrorField = '';
      }
      refreshSave(); renderNotice();
    };
    for (const [key, el] of Object.entries(f)) {
      if (key === 'blockers') continue;               // the group holds buttons and the search box: its events are not edits
      el?.addEventListener('input', () => remember(key)); el?.addEventListener('change', () => remember(key));
    }
    // The title and the panel's inputs are outside the form: Enter in one of them submits like Enter in a field of the form.
    for (const el of Object.values(f)) {
      if (el?.tagName !== 'INPUT' || el.type === 'radio' || form.contains?.(el)) continue;
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent?.(new Event('submit', { cancelable: true })); } });
    }
    f.criteria?.addEventListener('keydown', (e) => { onCriteriaKeydown(e, 'ticket-edit-criteria'); });
    // Write / Preview: Preview renders the textarea's current text, saved or not. The count follows the typed checklist lines.
    const syncCrit = () => {
      const text = f.criteria?.value ?? '';
      const prev = root.querySelector?.('#ticket-pane-preview');
      if (prev) prev.innerHTML = mdHtml(text);
      const prog = root.querySelector?.('#ticket-edit-progress');
      if (prog) prog.textContent = critProgressText(text);
    };
    f.criteria?.addEventListener('input', syncCrit);
    const showTab = (k, focus) => {
      critTab = k;
      syncCrit();
      for (const n of ['write', 'preview']) {
        const tab = root.querySelector?.(`#ticket-tab-${n}`), pane = root.querySelector?.(`#ticket-pane-${n}`);
        if (tab) { tab.setAttribute('aria-selected', String(n === k)); tab.tabIndex = n === k ? 0 : -1; if (n === k && focus) tab.focus?.(); }
        if (pane) pane.hidden = n !== k;
      }
    };
    root.querySelectorAll?.('[role="tab"]').forEach((b) => {
      b.addEventListener('click', () => showTab(b.id === 'ticket-tab-preview' ? 'preview' : 'write'));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault?.();
          showTab(e.key === 'ArrowLeft' || e.key === 'Home' ? 'write' : 'preview', true);
        }
      });
    });
    root.querySelectorAll?.('[data-edit-md]').forEach((b) => b.addEventListener('click', () => { applyToCriteria(b.dataset.editMd, 'ticket-edit-criteria'); syncCrit(); remember('criteria'); }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = viewId;
      const t = id && tickets.get(id);
      if (!t) return;
      const d = diffOf(t, { ...formValues(t), ...read() });
      if (!hasChanges(d)) return;
      viewError = ''; viewErrorField = '';
      if (Object.keys(d.body).length) {
        if (!(await act(`/tickets/${encodeURIComponent(id)}/edit`, d.body, 'edit'))) { setViewError(lastActError); return; }   // the typed values stay
      }
      if (d.assign !== undefined) {
        if (!(await act(`/tickets/${encodeURIComponent(id)}/assign`, { assignee: d.assign || null }, 'assign'))) { setViewError(lastActError, 'assignee'); return; }
      }
      viewDraft = null; unsavedPrompt = false; viewEditing = false;
      renderNotice(); refreshView();
    });
  }

  const STATUS_PILL = { draft: 'Draft', queued: 'Queued', claimed: 'In progress', in_progress: 'In progress', in_review: 'In review', done: 'Done', cancelled: 'Cancelled' };

  // The body's left column: criteria, blockers, the editor, approval, notes, files. The properties are in the panel (panelHtml).
  function viewHtml(t) {
    const draft = isEditMode(t);
    const crit = criteriaProgress(t.acceptance_criteria);
    return approvalHtml(t)
      + (draft ? '' : `<h3 class="ticket-view-h">Acceptance criteria${crit.total ? ` <span class="ticket-view-count">${crit.done} of ${crit.total} checked</span>` : ''}</h3><div class="ticket-view-criteria md">${mdHtml(t.acceptance_criteria)}</div>`)
      + requestFormHtml(t)
      + blockersHtml(t)
      + filesHtml(t);
  }

  // The properties panel: Status (the Move control), Assignee, Priority, Blast radius, Request, External ref, a rule, then Created,
  // Updated (only when it differs), Archived and the ID with a copy button. A field the editor holds is not shown twice:
  // a draft's editor has the assignee, priority, radius and ref; a queued ticket's editor has the request.
  function panelHtml(t) {
    const draft = isEditMode(t), form = isEditMode(t);   // "draft" here: the editor holds the fields
    const isDraft = t.status === 'draft';
    const row = (k, v, cls = '') => `<dt${cls}>${escHtml(k)}</dt><dd>${v}</dd>`;
    const text = (v) => escHtml(String(v ?? '—'));
    const rows = [
      // Status: the Move select in read mode and in a draft; in the edit mode of any other ticket it is text with a hint.
      !movable(t) || (form && !isDraft) ? row('Status', text(STATUS_PILL[t.status] ?? t.status) + (form ? '<div class="ticket-view-hint">Move the ticket after you save.</div>' : '')) : '',
      form ? panelFieldsHtml(t) : [
        row('Assignee', assignHtml(t) || text(t.assignee || 'unassigned')),
        row('Priority', text(prio(t)[1])),
        row('Blast radius', text(t.blast_radius)),
        row('Request', text(t.request_id || '—'), ' class="dt-strong"'),
        row('External ref', text(t.external_ref || '—')),
      ].join(''),
    ].join('');
    const dates = [
      row('Created', `${escHtml(when(t.created_at_ms))} by ${escHtml(t.creator)}`),
      t.updated_at_ms && t.updated_at_ms !== t.created_at_ms ? row('Updated', escHtml(when(t.updated_at_ms))) : '',
      t.archived_at_ms ? row('Archived', escHtml(when(t.archived_at_ms))) : '',
      row('ID', `<span class="ticket-id">${escHtml(t.id)}</span> <button type="button" class="ticket-copy-id" data-id="${escAttr(t.id)}" aria-label="Copy ticket ID">Copy</button>`),
    ].join('');
    return (movable(t) && (!form || isDraft) ? `<div class="ticket-view-status">${moveHtml(t, 'Status')}</div>` : '')
      + `<dl class="ticket-view-fields">${rows}</dl><hr class="ticket-view-rule" /><dl class="ticket-view-fields">${dates}</dl>`;
  }

  // The header: tag chip and code, status pill, the traffic light with its label; then the title and its subtitle. A draft's title is
  // the one title input (the raw title, tag included).
  function drawHeader(t) {
    const p = parseTitle(t.title);
    const light = lightOf(t);
    const meta = document.getElementById('ticket-view-head-meta');
    if (meta) {
      meta.innerHTML = (p.tag ? `<span class="ticket-tag${p.tag === 'code' ? ' tag-code' : ''}">${escHtml(p.tag)}</span>` : '')
        + (p.code ? `<span class="ticket-code">${escHtml(p.code)}</span>` : '')
        + `<span class="ticket-pill pill-${escAttr(t.status === 'claimed' ? 'in_progress' : t.status)}">${escHtml(STATUS_PILL[t.status] ?? t.status)}</span>`
        + (viewEditing && t.status !== 'draft' && isEditMode(t) ? '<span class="ticket-pill pill-editing">Editing</span>' : '')
        + (light ? `<span class="ticket-view-light">${lightHtml(t)}<span class="ticket-view-light-label">${escHtml(light[1])}</span></span>` : '');
    }
    const title = document.getElementById('ticket-view-title');
    if (title) {
      if (isEditMode(t)) {
        const v = formValues(t);
        title.innerHTML = `<input id="ticket-edit-title" class="ticket-title-input" aria-label="Title" value="${escAttr(v.title)}" autocomplete="off" required${invalidAttr('title')} />${fieldError('title')}`;
      } else {
        title.textContent = p.main;
      }
    }
    const sub = document.getElementById('ticket-view-sub');
    if (sub) { sub.textContent = isEditMode(t) ? '' : (p.sub ?? ''); sub.hidden = isEditMode(t) || !p.sub; }
    const edit = document.getElementById('ticket-view-edit');
    if (edit) edit.hidden = !(canEdit(t) && !isEditMode(t));
  }

  // Redraw from the current snapshot, keeping the keyboard where it was (a redraw replaces the controls).
  function drawView() {
    const t = viewId ? tickets.get(viewId) : null;
    const content = document.getElementById('ticket-view-content');
    const actions = document.getElementById('ticket-view-actions');
    if (!t || !content || !actions) { closeView(); return; }
    const active = document.activeElement;
    const row = document.getElementById('ticket-view-row-actions');
    const keep = (actions.contains?.(active) || row?.contains?.(active))
      ? (active.dataset?.cancel ? '.ticket-cancel-btn' : active.dataset?.to ? `button[data-to="${active.dataset.to}"]` : active.classList?.contains('ticket-move') ? '.ticket-move' : active.classList?.contains('ticket-assign') ? '.ticket-assign' : active.classList?.contains('ticket-archive') ? '.ticket-archive' : null)
      : null;
    // The request form lives in the content, which a redraw replaces: put the caret back in the field the human was typing in.
    const typing = /^ticket-edit-/.test(active?.id || '') && (content.contains?.(active) || actions.contains?.(active) || document.getElementById('ticket-view-title')?.contains?.(active))
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    const fileFocus = content.contains?.(active) && active.classList?.contains('ticket-file-remove') ? active.dataset.attachment : null;
    if (noteCount(t) > 0) ensureNotes(t.id);
    if (attachCount(t) > 0) ensureFiles(t.id);
    drawHeader(t);
    content.innerHTML = viewHtml(t);
    const notesEl = document.getElementById('ticket-view-notes');
    if (notesEl) { notesEl.innerHTML = notesHtml(t, true); wireNotes(notesEl); }
    actions.innerHTML = panelHtml(t);                                  // before the form is wired: the editor's fields are in the panel
    wireRequestForm(content);
    wireApproval(content);
    wireBlockerPicker(content);
    wireFileButtons(content);
    if (fileFocus) content.querySelector?.(`.ticket-file-remove[data-attachment="${fileFocus}"]`)?.focus?.();
    if (typing) {
      const f = content.querySelector?.(`#${typing.id}`) ?? actions.querySelector?.(`#${typing.id}`) ?? document.getElementById('ticket-view-title')?.querySelector?.(`#${typing.id}`);
      f?.focus?.();
      if (typing.start != null) f?.setSelectionRange?.(typing.start, typing.end);
    }
    content.querySelectorAll?.('.ticket-files-retry').forEach((b) => b.addEventListener('click', () => retryFiles(b.dataset.ticket)));
    wireActions(actions);
    actions.querySelectorAll?.('.ticket-copy-id').forEach((b) => b.addEventListener('click', () => { try { navigator.clipboard?.writeText?.(b.dataset.id); } catch { /* no clipboard */ } }));
    if (row) {
      row.innerHTML = rowButtonsHtml(t); wireActions(row); wireCancel(row);
      row.querySelector?.('#ticket-discard-btn')?.addEventListener('click', discardChanges);
    }   // Cancel ticket / Archive sit in the bottom row
    refreshSave();
    renderNotice();
    if (keep) (actions.querySelector?.(keep) ?? row?.querySelector?.(keep) ?? document.getElementById('ticket-view-x'))?.focus?.();
  }

  function refreshView() {
    if (viewId) drawView();
  }

  function openView(id, opener) {
    const d = document.getElementById('ticket-view');
    if (!d || !tickets.has(id)) return;
    if (viewId !== id) { allNotes.clear(); viewDraft = null; viewError = ''; viewErrorField = ''; unsavedPrompt = false; viewEditing = false; pickerOpen = false; pickerQuery = ''; cancelArmed = null; removeArmed = null; fileNote(''); }
    viewId = id;
    viewEpoch++;
    viewOpener = opener ?? document.activeElement;
    const had = notes.get(id);
    const hadFiles = files.get(id);
    if (hadFiles) {
      hadFiles.failed = false;
      if (hadFiles.loaded && hadFiles.items.length < attachCount(tickets.get(id))) hadFiles.loaded = false;
    }
    if (had) {
      had.failed = false;   // opening the view is an explicit request to read again
      if (had.loaded && had.items.length < noteCount(tickets.get(id))) had.loaded = false;   // it knows of fewer notes than exist
    }
    // Centre on the board pane, not the window, as the new-ticket dialog does.
    const r = document.getElementById('board-col')?.getBoundingClientRect();
    if (r?.width) Object.assign(d.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    drawView();
    if (viewId && !d.open) d.showModal();
    document.getElementById('ticket-view-x')?.focus?.();   // the header Close (the first control): Tab then walks the dialog in order
  }

  function closeView() {
    const d = document.getElementById('ticket-view');
    if (d?.open) d.close();
    else viewId = null;
  }

  function onViewClosed() {
    const id = viewId;
    const back = viewOpener?.isConnected ? viewOpener
      : id ? document.querySelector?.(`.ticket-card[data-ticket="${id}"]`) : null;   // a redraw replaced the card
    viewId = null;
    viewOpener = null;
    viewDraft = null; viewError = ''; viewErrorField = ''; unsavedPrompt = false; viewEditing = false; pickerOpen = false; pickerQuery = ''; cancelArmed = null; clearTimeout(cancelTimer);
    removeArmed = null; clearTimeout(removeTimer);
    fileNote('');
    back?.focus?.();
  }

  // Native <dialog> opened with showModal(): the page behind it is inert, so no second
  // draft can open while one is on screen.
  const dialog = () => document.getElementById('ticket-modal');

  function openNew(key) {
    if (saving) return;
    newColumn = COLUMNS.find((c) => c.key === key) ?? COLUMNS[0];
    const d = dialog();
    if (!d) return;
    const title = document.getElementById('ticket-modal-title');
    if (title) title.textContent = `New ticket — ${newColumn.label}`;
    const pick = document.getElementById('ticket-f-assignee');
    if (pick) {
      pick.innerHTML = '<option value="">Unassigned</option>'
        + roomAgents().map((n) => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('');
    }
    pendingFiles = [];
    renderPendingFiles();
    opener = document.activeElement;
    // Centre on the board pane, not the window: the dialog takes the pane's rectangle.
    const r = document.getElementById('board-col')?.getBoundingClientRect();
    if (r?.width) Object.assign(d.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (!d.open) d.showModal();
    document.getElementById('ticket-f-title')?.focus();
  }

  // Refused while a create is in flight: the draft stays until the hub answers.
  function closeNew() {
    const d = dialog();
    if (d?.open && !saving) d.close();
  }

  function restoreFocus() {
    // A re-render replaces the "+" buttons: fall back to the same column's new one.
    const back = opener?.isConnected ? opener
      : document.querySelector?.(`.ticket-add[data-col="${newColumn.key}"]`);
    back?.focus?.();
    opener = null;
  }

  // ---- Files chosen in the new-ticket popup: kept until the ticket exists, then uploaded and linked ----
  function renderPendingFiles() {
    const ul = document.getElementById('ticket-f-file-list');
    if (!ul) return;
    ul.innerHTML = pendingFiles.map((f, i) =>
      `<li><span class="ticket-f-file-name">${escHtml(f.name)}</span>`
      + `<button type="button" class="ticket-f-file-remove" data-index="${i}" aria-label="Remove ${escAttr(f.name)}">×</button></li>`).join('');
  }

  function addPendingFiles(list) {
    for (const f of list) {
      const problem = fileProblem(f);
      if (problem) { addMessage({ from: 'system', to: HUMAN_NAME, text: `Attach failed: ${problem}`, ts: '' }); continue; }
      if (!pendingFiles.some((p) => p.name === f.name && p.size === f.size)) pendingFiles.push(f);
    }
    renderPendingFiles();
  }

  async function submit(f) {
    if (!room || saving) return;  // a second Save click must not create a second ticket
    const column = newColumn, target = room;  // fixed before the first await
    const assignee = f.assignee?.value || '';
    const toAttach = pendingFiles.slice();   // fixed before the first await, like the column
    const blocked_by = (f.blocked_by?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    saving = true;
    let created;
    try {
      created = await act('/tickets', {
        room: target,
        title: f.title.value.trim(),
        acceptance_criteria: f.criteria.value.trim(),
        blast_radius: f.radius.value,
        priority: f.priority.value,
        status: column.status,
        ...(f.external_ref.value.trim() ? { external_ref: f.external_ref.value.trim() } : {}),
        ...(f.request_id?.value.trim() ? { request_id: f.request_id.value.trim() } : {}),
        ...(blocked_by.length ? { blocked_by } : {}),
        ...(assignee ? { assignee } : {}),
      }, 'create');
    } finally {
      saving = false;
    }
    if (!created) return;  // keep the dialog and the entered criteria after a failure
    f.reset();
    pendingFiles = [];
    renderPendingFiles();
    closeNew();
    // The ticket exists: upload and link the chosen files. A failure is reported; the ticket stays.
    if (toAttach.length && created.snapshot?.id) await attachFiles(created.snapshot.id, toAttach);
  }

  function wire() {
    const toggle = document.getElementById('board-toggle-btn');
    const setOpen = (open) => {
      document.body.classList.toggle('board-open', open);
      toggle?.setAttribute('aria-pressed', String(open));
    };
    toggle?.addEventListener('click', () => {
      const open = !document.body.classList.contains('board-open');
      setOpen(open);
      document.dispatchEvent(new CustomEvent('cubilot:right-pane', { detail: { pane: open ? 'board' : null } }));
      if (open) load();
    });
    // The terminal took the right pane: close the board.
    document.addEventListener('cubilot:right-pane', (e) => {
      if (e.detail?.pane === 'terminal') { setOpen(false); setFilterPanel(false); }
    });
    for (const v of RADII) {
      document.getElementById(`ticket-filter-radius-${v}`)?.addEventListener('change', (e) => { if (e.target.checked) setFilter({ ...filter, radius: v }); });
    }
    document.getElementById('ticket-filters-btn')?.addEventListener('click', () => setFilterPanel(!filterPanelOpen));
    document.getElementById('ticket-filter-done')?.addEventListener('click', () => setFilterPanel(false, { focusButton: true }));
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeydown);
    for (const key of Object.keys(PRIORITIES)) {
      document.getElementById(`ticket-filter-p-${key}`)?.addEventListener('change', () => setFilter({
        ...filter,
        priorities: Object.keys(PRIORITIES).filter((k) => document.getElementById(`ticket-filter-p-${k}`)?.checked),
      }));
    }
    document.getElementById('ticket-filter-request')?.addEventListener('change', (e) => setFilter({ ...filter, request: e.target.value }));
    document.getElementById('ticket-show-archived')?.addEventListener('change', (e) => setFilter({ ...filter, showArchived: e.target.checked }));
    document.getElementById('ticket-show-cancelled')?.addEventListener('change', (e) => setFilter({ ...filter, showCancelled: e.target.checked }));
    document.getElementById('ticket-lead')?.addEventListener('change', (e) => setLead(e.target.value));
    loadLead();   // the selected room's lead, before the board is ever opened
    document.getElementById('ticket-new-btn')?.addEventListener('click', () => openNew('queued'));
    document.getElementById('ticket-filter-reset')?.addEventListener('click', () => setFilter(defaultFilter()));
    document.getElementById('ticket-new-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      return submit(e.target);
    });
    document.getElementById('ticket-modal-cancel')?.addEventListener('click', closeNew);
    // Criteria editor: the toolbar buttons and the shortcuts on the field.
    document.querySelectorAll?.('.md-toolbar [data-md]').forEach((b) => b.addEventListener('click', () => applyToCriteria(b.dataset.md)));
    document.getElementById('ticket-f-criteria')?.addEventListener('keydown', onCriteriaKeydown);
    // New-ticket popup: choose files (kept until Save), remove one with ×.
    const popupInput = document.getElementById('ticket-f-files');
    document.getElementById('ticket-f-attach-btn')?.addEventListener('click', () => popupInput?.click());
    popupInput?.addEventListener('change', () => { addPendingFiles([...(popupInput.files ?? [])]); popupInput.value = ''; });
    document.getElementById('ticket-f-file-list')?.addEventListener('click', (e) => {
      const x = e.target?.closest?.('.ticket-f-file-remove');
      if (!x) return;
      pendingFiles.splice(Number(x.dataset.index), 1);
      renderPendingFiles();
    });
    // Ticket view: attach to the ticket on show.
    const viewInput = document.getElementById('ticket-view-file');
    document.getElementById('ticket-view-attach-btn')?.addEventListener('click', () => viewInput?.click());
    // The drop area: a drop attaches the files like the file picker does.
    const drop = document.getElementById('ticket-view-drop');
    drop?.addEventListener('dragover', (e) => { e.preventDefault?.(); drop.classList?.add('over'); });
    drop?.addEventListener('dragleave', () => drop.classList?.remove('over'));
    drop?.addEventListener('drop', async (e) => {
      e.preventDefault?.();
      drop.classList?.remove('over');
      const id = viewId, c = fileCtx(), list = [...(e.dataTransfer?.files ?? [])];
      if (!id || !list.length) return;
      const t = tickets.get(id);
      if (!t || !movable(t)) return;                                   // a finished ticket takes no file
      noteIf(c, 'Attaching…');
      const n = await attachFiles(id, list);
      noteIf(c, n ? (n === 1 ? 'File saved' : `${n} files saved`) : '');
    });
    viewInput?.addEventListener('change', async () => {
      const id = viewId, c = fileCtx(), list = [...(viewInput.files ?? [])];
      viewInput.value = '';
      if (!id || !list.length) return;
      noteIf(c, 'Attaching…');
      const n = await attachFiles(id, list);
      noteIf(c, n ? (n === 1 ? 'File saved' : `${n} files saved`) : '');   // files save at once, not with "Save changes"
    });
    const replaceInput = document.getElementById('ticket-view-replace');
    replaceInput?.addEventListener('change', () => {
      const target = replaceTarget, file = replaceInput.files?.[0];
      replaceTarget = null;
      replaceInput.value = '';
      if (target) replaceFile(target.ticketId, target.attachmentId, file);
    });
    const v = document.getElementById('ticket-view');
    document.getElementById('ticket-view-close')?.addEventListener('click', requestClose);
    document.getElementById('ticket-view-x')?.addEventListener('click', requestClose);
    document.getElementById('ticket-view-edit')?.addEventListener('click', () => {
      viewEditing = true;
      refreshView();
      document.getElementById('ticket-edit-title')?.focus?.();
    });
    v?.addEventListener('click', (e) => { if (e.target === v) requestClose(); });   // the backdrop
    v?.addEventListener('cancel', (e) => { if (viewDirty()) { e.preventDefault(); requestClose(); } });   // Escape closes natively unless there are changes
    v?.addEventListener('close', onViewClosed);
    const d = dialog();
    d?.addEventListener('click', (e) => { if (e.target === d) closeNew(); });  // the ::backdrop
    d?.addEventListener('cancel', (e) => { if (saving) e.preventDefault(); });  // Escape
    d?.addEventListener('close', restoreFocus);
    // The form belongs to the room it was opened for: a room change discards it.
    document.addEventListener('cubilot:room-filter', () => { closeNew(); setFilterPanel(false); load(); });
  }

  // main.js calls this when the UI stream (re)opens. Ambient entries (ticket.archived, room.lead) are not
  // replayed after a reconnect, so an open board re-reads its list and the lead; a closed one reloads on open.
  globalThis.syncTicketBoard = function syncTicketBoard() {
    files.clear();   // a reconnect missed ticket.attached / ticket.detached entries: read every list again when it is shown
    refreshView();   // an open dialog reads its list again now
    loadLead();   // the top bar shows the lead whether or not the board is open
    if (document.body?.classList.contains('board-open')) load();
  };
  // roster.js calls this when the roster changes: the lead select lists the room's agents.
  globalThis.refreshRoomLead = renderLead;

  KindCardRenderer.observe('ticket', onTicket);
  KindCardRenderer.observe('permission', onPermission);
  KindCardRenderer.observe('room', onRoomLead);
  if (typeof document !== 'undefined' && document.getElementById) wire();

  return { load, onTicket, onPermission, openNew, setFilter, matchesFilter, sanitizeFilter, readFilter, setLead, onRoomLead, archiveAllDone, setFilterPanel, attachFiles, addPendingFiles, applyMarkdownAction, mdHtml, applyToCriteria, onCriteriaKeydown, openView, closeView, _commitBlockers: (ids) => commitBlockers(ids), onNoted, lightOf, parseTitle, criteriaProgress, priorityBars, statusLine, _tickets: tickets, _filter: () => filter, _lead: () => lead };
})();
