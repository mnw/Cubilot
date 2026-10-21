// Ticket board — Room backlog as four columns, rendered in the right-hand pane.
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
    { key: 'queued', label: 'Queued', statuses: ['queued'], status: 'queued' },
    { key: 'progress', label: 'In progress', statuses: ['claimed', 'in_progress'], status: 'in_progress' },
    { key: 'review', label: 'In review', statuses: ['in_review'], status: 'in_review' },
    { key: 'done', label: 'Done', statuses: ['done'], status: 'done' },
  ];

  // API values are names; rank orders the columns. Anything unknown reads as medium.
  const PRIORITIES = { highest: [5, 'Highest'], high: [4, 'High'], medium: [3, 'Medium'], low: [2, 'Low'], lowest: [1, 'Lowest'] };
  const prio = (t) => (Object.hasOwn(PRIORITIES, t.priority) ? PRIORITIES[t.priority] : PRIORITIES.medium);

  // Board filters (blast radius, priority, show archived, show cancelled), kept per room in localStorage. No filter = all five
  // priorities ticked and radius "all". An unticked-everything choice is honoured: it shows nothing.
  const FILTER_KEY = (r) => `a2a_board_filter:${r}`;
  const RADII = ['all', 'low', 'high'];
  const defaultFilter = () => ({ radius: 'all', priorities: Object.keys(PRIORITIES), showArchived: false, showCancelled: false });
  function sanitizeFilter(f) {
    const d = defaultFilter();
    if (!f || typeof f !== 'object') return d;
    return {
      radius: RADII.includes(f.radius) ? f.radius : d.radius,
      priorities: Array.isArray(f.priorities) ? d.priorities.filter((k) => f.priorities.includes(k)) : d.priorities,
      showArchived: f.showArchived === true,
      showCancelled: f.showCancelled === true,
    };
  }
  function readFilter(r) {
    try { return sanitizeFilter(JSON.parse(localStorage.getItem(FILTER_KEY(r)) || 'null')); } catch { return defaultFilter(); }
  }
  // An unknown priority reads as medium (as everywhere on the board).
  const priorityKey = (t) => (Object.hasOwn(PRIORITIES, t.priority) ? t.priority : 'medium');
  const matchesFilter = (t, f) => (f.radius === 'all' || t.blast_radius === f.radius) && f.priorities.includes(priorityKey(t));
  const isDefaultFilter = (f) => f.radius === 'all' && f.priorities.length === Object.keys(PRIORITIES).length && !f.showArchived && !f.showCancelled;
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
    if (roomChanged) { filter = target ? readFilter(target) : defaultFilter(); syncFilterControls(); }
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
        base.attachments_count = Math.max(Number(prior?.attachments_count) || 0, Number(item.attachments_count) || 0);
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
    const s = snapshotOf(event);
    if (!s || !s.id || s.room !== room) return;
    if (loading) freshDuringLoad.add(s.id);
    const prior = tickets.get(s.id);
    const version = Number(event.version ?? s.version ?? 0);
    if (prior && prior.version >= version) return;
    const approval = prior && prior.approval_request_id === s.approval_request_id ? prior.approval : null;
    // notes_count rides on the entry (a ticket.update that carried a note), not in the snapshot.
    tickets.set(s.id, { ...s, version, approval, notes_count: Math.max(Number(prior?.notes_count) || 0, Number(event.notes_count ?? s.notes_count) || 0),
      attachments_count: Math.max(Number(prior?.attachments_count) || 0, Number(event.attachments_count ?? s.attachments_count) || 0) });
    syncNotes(tickets.get(s.id));
    syncFiles(tickets.get(s.id));
    if (s.approval_request_id && !approval) load();
    else render();
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

  async function act(path, body, label) {
    try {
      const r = await authedFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: HUMAN_NAME, ...body }),
      });
      if (r.ok) return (await r.json().catch(() => null)) ?? {};
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Ticket ${label} failed: ${err}`, ts: '' });
    } catch (e) {
      addMessage({ from: 'system', to: HUMAN_NAME, text: `Ticket ${label} error: ${e?.message ?? e}`, ts: '' });
    }
    return null;
  }

  // Human moves: an open ticket goes to any of the four columns with the "Move to" select or by drag and
  // drop (the hub keeps the assignee). Cancel stays a button. A claimed ticket sits in the In progress column.
  const movable = (t) => t.status !== 'done' && t.status !== 'cancelled';
  const columnStatus = (t) => (t.status === 'claimed' ? 'in_progress' : t.status);
  const actionsFor = (t) => (movable(t) ? [['cancelled', 'Cancel']] : []);

  function moveHtml(t) {
    if (!movable(t)) return '';
    const cur = columnStatus(t);
    const options = COLUMNS.map((c) =>
      `<option value="${escAttr(c.status)}"${c.status === cur ? ' selected disabled' : ''}>${escHtml(c.label)}</option>`).join('');
    return `<label class="ticket-move-label">Move to <select class="ticket-move" data-ticket="${escAttr(t.id)}" data-current="${escAttr(cur)}" aria-label="Move ${escAttr(t.title)} to column">${options}</select></label>`;
  }

  // "Move to" and "Assignee" side by side: two equal columns that wrap to two rows only in a narrow card.
  function fieldsHtml(t) {
    const both = moveHtml(t) + assignHtml(t);
    return both ? `<div class="ticket-fields">${both}</div>` : '';
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

  function applyToCriteria(action) {
    const ta = document.getElementById('ticket-f-criteria');
    if (!ta) return;
    const r = applyMarkdownAction(ta.value, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length, action);
    ta.value = r.value;
    ta.setSelectionRange?.(r.start, r.end);
    ta.focus?.();
    // Programmatic edits do not fire `input`: tell anyone listening (validation, drafts).
    if (typeof Event === 'function') ta.dispatchEvent?.(new Event('input', { bubbles: true }));
  }

  // Shortcuts (Cmd or Ctrl): B bold, E inline code, Shift+8 bulleted list, Shift+9 checklist item.
  function onCriteriaKeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = String(e.key ?? '').toLowerCase();
    const action = e.shiftKey ? (e.code === 'Digit8' ? 'bullet' : e.code === 'Digit9' ? 'checklist' : null)
      : key === 'b' ? 'bold' : key === 'e' ? 'code' : null;
    if (!action) return;
    e.preventDefault();
    applyToCriteria(action);
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

  const noteItemHtml = (n) =>
    `<li><span class="ticket-note-author">${escHtml(n.author)}</span> <time>${escHtml(when(n.created_at_ms))}</time>`
    + `<div class="ticket-note-text">${escHtml(n.text)}</div></li>`;

  function notesBodyHtml(t) {
    if (noteCount(t) === 0) return '<div class="ticket-notes-empty">No notes</div>';
    const c = notes.get(t.id);
    if (c?.failed) return `<div class="ticket-notes-empty">Could not read the notes. <button type="button" class="ticket-notes-retry" data-ticket="${escAttr(t.id)}">Retry</button></div>`;
    if (!c?.loaded) return '<div class="ticket-notes-empty">Loading…</div>';
    return `<ul class="ticket-notes-list">${c.items.map(noteItemHtml).join('')}</ul>`;
  }

  // On a card: a collapsed section, shown only when there are notes. In the full view: always shown.
  function notesHtml(t, inView) {
    if (inView) return `<h3 class="ticket-view-h">Notes (${noteCount(t)})</h3>${notesBodyHtml(t)}`;
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
    const c = files.get(id) ?? { items: [], loaded: false, loading: false, failed: false, seq: 0 };
    files.set(id, c);
    const seq = ++c.seq;
    c.loading = true;
    c.failed = false;
    try {
      const r = await authedFetch(`/tickets/${encodeURIComponent(id)}/attachments`);
      if (seq !== c.seq) return;
      if (!r.ok) { c.failed = true; return; }
      const list = await r.json();
      if (seq !== c.seq) return;
      if (!Array.isArray(list)) { c.failed = true; return; }
      c.items = mergeFiles(c.items, list);   // merge, never replace: a live attachment may be newer than this read
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
    if (!c || !c.loaded || c.items.length >= attachCount(t)) return;
    c.loaded = false;
    if (!c.failed && viewId === t.id) loadFiles(t.id);
  }

  function onAttached(event) {
    const t = tickets.get(event.ticket_id);
    if (!t || event.room !== room) return;
    const c = files.get(t.id);
    if (c && event.attachment) c.items = mergeFiles(c.items, [event.attachment]);
    t.attachments_count = Math.max(attachCount(t), Number(event.attachments_count ?? attachCount(t) + 1) || 0);
    syncFiles(t);
    render();
  }

  function fileItemHtml(f) {
    const href = escAttr(imgUrl(f.url));
    const thumb = IMAGE_EXT_RE.test(f.url)
      ? `<a href="${href}" target="_blank" rel="noopener"><img class="ticket-attach-thumb" src="${href}" alt="${escAttr(f.name)}" loading="lazy"></a>`
      : `<span class="ticket-attach-ext">${escHtml(fileExt(f.url).toUpperCase())}</span>`;
    return `<li>${thumb}<div class="ticket-attach-info"><a class="ticket-attach-name" href="${href}" target="_blank" rel="noopener">${escHtml(f.name)}</a>`
      + `<span class="ticket-attach-meta">${escHtml(f.author)} · ${escHtml(when(f.created_at_ms))}</span></div></li>`;
  }

  function filesHtml(t) {
    const n = attachCount(t);
    const head = `<h3 class="ticket-view-h">Attachments (${n})</h3>`;
    if (n === 0) return `${head}<div class="ticket-notes-empty">No attachments</div>`;
    const c = files.get(t.id);
    if (c?.failed) return `${head}<div class="ticket-notes-empty">Could not read the attachments. <button type="button" class="ticket-files-retry" data-ticket="${escAttr(t.id)}">Retry</button></div>`;
    if (!c?.loaded) return `${head}<div class="ticket-notes-empty">Loading…</div>`;
    return `${head}<ul class="ticket-attach-list">${c.items.map(fileItemHtml).join('')}</ul>`;
  }

  // Upload each file with /upload, then link it to the ticket. One at a time; a refusal is reported and the
  // rest still go. Returns how many were attached.
  async function attachFiles(ticketId, list) {
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
        if (ok) done++;
      } catch (e) {
        addMessage({ from: 'system', to: HUMAN_NAME, text: `Attach failed: ${file.name}: ${e?.message ?? e}`, ts: '' });
      }
    }
    return done;
  }

  function approvalHtml(t) {
    if (t.blast_radius !== 'high' || !t.approval_request_id) return '';
    const a = t.approval;
    const state = !a ? 'waiting for approval'
      : a.status === 'pending' ? 'waiting for your approval'
      : a.status === 'allowed' && a.resolved_by === HUMAN_NAME ? 'approved'
      : `request ${a.status}${a.resolved_by ? ` by ${a.resolved_by}` : ''} — not your approval`;
    return `<div class="ticket-approval">${escHtml(state)} · ${escHtml(t.approval_request_id)}</div>`;
  }

  // Only a finished ticket can be archived (the hub enforces it too); an archived one can be restored.
  const archivable = (t) => t.status === 'done' || t.status === 'cancelled';
  function archiveButton(t) {
    if (!archivable(t)) return '';
    const archived = !!t.archived_at_ms;
    return `<button type="button" class="ticket-archive" data-ticket="${escAttr(t.id)}" data-archive="${archived ? 'false' : 'true'}">${archived ? 'Unarchive' : 'Archive'}</button>`;
  }

  const buttonsHtml = (t) =>
    actionsFor(t).map(([to, label]) =>
      `<button type="button" data-ticket="${escAttr(t.id)}" data-to="${escAttr(to)}">${escHtml(label)}</button>`).join('')
    + archiveButton(t);

  function cardHtml(t) {
    const meta = [
      prio(t)[1],
      t.assignee ? `@${t.assignee}` : 'unassigned',
      t.external_ref || null,
      t.archived_at_ms ? 'archived' : null,
    ].filter(Boolean).map((m) => escHtml(m)).join(' · ');
    const buttons = buttonsHtml(t);
    return `
      <div class="ticket-card radius-${t.blast_radius === 'high' ? 'high' : 'low'} status-${escAttr(t.status)}${t.archived_at_ms ? ' archived' : ''}" role="button" tabindex="0"${movable(t) ? ' draggable="true"' : ''} data-ticket="${escAttr(t.id)}" aria-label="Open ticket: ${escAttr(t.title)}">
        <div class="ticket-title">${escHtml(t.title)}</div>
        <div class="ticket-meta">${meta}${t.blast_radius === 'high' ? ' · <span class="ticket-radius">high radius</span>' : ''}</div>
        <details class="ticket-criteria"><summary>Acceptance criteria</summary><div class="md">${mdHtml(t.acceptance_criteria)}</div></details>
        ${approvalHtml(t)}
        ${notesHtml(t, false)}
        ${fieldsHtml(t)}
        <div class="ticket-actions">${buttons}</div>
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
    // The board has four columns; a fifth, Cancelled, appears only while "Show cancelled" is on.
    const columns = filter.showCancelled ? [...COLUMNS, CANCELLED] : COLUMNS;
    const archivable = all.filter((t) => t.status === 'done' && !t.archived_at_ms).length;
    updateFiltersButton(everything.length, all.length);
    el.innerHTML = columns.map((c) => {
      const items = all.filter((t) => c.statuses.includes(t.status));
      const add = c.status ? `<button type="button" class="ticket-add" data-col="${escAttr(c.key)}" aria-label="Add a ticket to ${escAttr(c.label)}">+</button>` : '';
      // "Archive all done" lives in the Done column's header (the filters panel has no actions).
      const archiveAllBtn = c.key === 'done'
        ? `<button type="button" class="ticket-archive-all"${archivable === 0 || archivingAll ? ' disabled' : ''}>${archivable ? `Archive all done (${archivable})` : 'Archive all done'}</button>`
        : '';
      return `<section class="ticket-col" data-status="${escAttr(c.status ?? '')}"><h3>${escHtml(c.label)} <span class="count">${items.length}</span>${archiveAllBtn}</h3>${items.map(cardHtml).join('')}${add}</section>`;
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
    root.querySelectorAll('.ticket-actions button[data-to]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ticket, to = btn.dataset.to;
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
    const sa = document.getElementById('ticket-show-archived');
    if (sa) sa.checked = filter.showArchived;
    const sc = document.getElementById('ticket-show-cancelled');
    if (sc) sc.checked = filter.showCancelled;
    for (const key of Object.keys(PRIORITIES)) {
      const cb = document.getElementById(`ticket-filter-p-${key}`);
      if (cb) cb.checked = filter.priorities.includes(key);
    }
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

  // The "Filters" button: how many of the four filter dimensions are active (radius, priority, archived,
  // cancelled), and the "Showing N of M" summary beside it.
  const activeFilterCount = (f) =>
    (f.radius !== 'all' ? 1 : 0) + (f.priorities.length !== Object.keys(PRIORITIES).length ? 1 : 0)
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
    if (summary && total !== undefined) summary.textContent = isDefaultFilter(filter) ? '' : `Showing ${shown} of ${total} tickets`;
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
    if (room) {
      try { localStorage.setItem(FILTER_KEY(room), JSON.stringify(filter)); } catch { /* storage full or blocked: keep it in memory */ }
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

  function viewHtml(t) {
    const rows = [
      ['ID', t.id], ['External ref', t.external_ref || '—'], ['Status', t.status],
      ['Priority', prio(t)[1]], ['Blast radius', t.blast_radius], ['Creator', t.creator],
      ['Assignee', t.assignee || 'unassigned'], ['Created', when(t.created_at_ms)], ['Updated', when(t.updated_at_ms)],
      ...(t.archived_at_ms ? [['Archived', when(t.archived_at_ms)]] : []),
    ];
    return `<dl class="ticket-view-fields">${rows.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(String(v ?? '—'))}</dd>`).join('')}</dl>`
      + `<h3 class="ticket-view-h">Acceptance criteria</h3><div class="ticket-view-criteria md">${mdHtml(t.acceptance_criteria)}</div>`
      + approvalHtml(t)
      + notesHtml(t, true)
      + filesHtml(t);
  }

  // Redraw from the current snapshot, keeping the keyboard where it was (a redraw replaces the controls).
  function drawView() {
    const t = viewId ? tickets.get(viewId) : null;
    const content = document.getElementById('ticket-view-content');
    const actions = document.getElementById('ticket-view-actions');
    if (!t || !content || !actions) { closeView(); return; }
    const active = document.activeElement;
    const keep = actions.contains?.(active)
      ? (active.dataset?.to ? `button[data-to="${active.dataset.to}"]` : active.classList?.contains('ticket-move') ? '.ticket-move' : active.classList?.contains('ticket-assign') ? '.ticket-assign' : active.classList?.contains('ticket-archive') ? '.ticket-archive' : null)
      : null;
    if (noteCount(t) > 0) ensureNotes(t.id);
    if (attachCount(t) > 0) ensureFiles(t.id);
    document.getElementById('ticket-view-title').textContent = t.title;
    content.innerHTML = viewHtml(t);
    wireNotes(content);
    content.querySelectorAll?.('.ticket-files-retry').forEach((b) => b.addEventListener('click', () => retryFiles(b.dataset.ticket)));
    actions.innerHTML = fieldsHtml(t) + `<div class="ticket-actions">${buttonsHtml(t)}</div>`;
    wireActions(actions);
    if (keep) (actions.querySelector?.(keep) ?? document.getElementById('ticket-view-close'))?.focus?.();
  }

  function refreshView() {
    if (viewId) drawView();
  }

  function openView(id, opener) {
    const d = document.getElementById('ticket-view');
    if (!d || !tickets.has(id)) return;
    viewId = id;
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
    document.getElementById('ticket-view-close')?.focus?.();
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
      document.dispatchEvent(new CustomEvent('a2a:right-pane', { detail: { pane: open ? 'board' : null } }));
      if (open) load();
    });
    // The terminal took the right pane: close the board.
    document.addEventListener('a2a:right-pane', (e) => {
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
    document.getElementById('ticket-show-archived')?.addEventListener('change', (e) => setFilter({ ...filter, showArchived: e.target.checked }));
    document.getElementById('ticket-show-cancelled')?.addEventListener('change', (e) => setFilter({ ...filter, showCancelled: e.target.checked }));
    document.getElementById('ticket-lead')?.addEventListener('change', (e) => setLead(e.target.value));
    loadLead();   // the selected room's lead, before the board is ever opened
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
    const viewStatus = document.getElementById('ticket-view-attach-status');
    document.getElementById('ticket-view-attach-btn')?.addEventListener('click', () => viewInput?.click());
    viewInput?.addEventListener('change', async () => {
      const id = viewId, list = [...(viewInput.files ?? [])];
      viewInput.value = '';
      if (!id || !list.length) return;
      if (viewStatus) viewStatus.textContent = 'Attaching…';
      const n = await attachFiles(id, list);
      if (viewStatus) viewStatus.textContent = n ? `Attached ${n} file${n > 1 ? 's' : ''}` : '';
    });
    const v = document.getElementById('ticket-view');
    document.getElementById('ticket-view-close')?.addEventListener('click', closeView);
    v?.addEventListener('click', (e) => { if (e.target === v) closeView(); });   // the backdrop; Escape closes natively
    v?.addEventListener('close', onViewClosed);
    const d = dialog();
    d?.addEventListener('click', (e) => { if (e.target === d) closeNew(); });  // the ::backdrop
    d?.addEventListener('cancel', (e) => { if (saving) e.preventDefault(); });  // Escape
    d?.addEventListener('close', restoreFocus);
    // The form belongs to the room it was opened for: a room change discards it.
    document.addEventListener('a2a:room-filter', () => { closeNew(); setFilterPanel(false); load(); });
  }

  // main.js calls this when the UI stream (re)opens. Ambient entries (ticket.archived, room.lead) are not
  // replayed after a reconnect, so an open board re-reads its list and the lead; a closed one reloads on open.
  globalThis.syncTicketBoard = function syncTicketBoard() {
    loadLead();   // the top bar shows the lead whether or not the board is open
    if (document.body?.classList.contains('board-open')) load();
  };
  // roster.js calls this when the roster changes: the lead select lists the room's agents.
  globalThis.refreshRoomLead = renderLead;

  KindCardRenderer.observe('ticket', onTicket);
  KindCardRenderer.observe('permission', onPermission);
  KindCardRenderer.observe('room', onRoomLead);
  if (typeof document !== 'undefined' && document.getElementById) wire();

  return { load, onTicket, onPermission, openNew, setFilter, matchesFilter, sanitizeFilter, readFilter, setLead, onRoomLead, archiveAllDone, setFilterPanel, attachFiles, addPendingFiles, applyMarkdownAction, mdHtml, applyToCriteria, onCriteriaKeydown, openView, closeView, onNoted, _tickets: tickets, _filter: () => filter, _lead: () => lead };
})();
