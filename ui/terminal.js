// Terminal pane: tab states external | launching | live; reuses main.js globals (ROSTER, HUMAN_NAME).

(function terminalPane() {
  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;

  if (!invoke || !listen) {
    console.warn('[terminal] Tauri unavailable; pane disabled');
    return;
  }

  async function pickDirectory() {
    try {
      const res = await invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, recursive: false },
      });
      return typeof res === 'string' ? res : null;
    } catch (e) {
      console.error('[terminal] pickDirectory', e);
      return null;
    }
  }

  const body          = document.body;
  const toggleBtn     = document.getElementById('terminal-toggle-btn');
  const splitter      = document.getElementById('splitter');
  const appBody       = document.getElementById('app-body');
  const tabsEl        = document.getElementById('terminal-tabs');
  const agentCol      = document.getElementById('agent-col');
  const bodyEl        = document.getElementById('terminal-body');
  const spawnModal    = document.getElementById('spawn-modal');
  const spawnAgentEl  = document.getElementById('spawn-agent-input');
  const spawnCwdEl    = document.getElementById('spawn-cwd-input');
  const spawnCwdPick  = document.getElementById('spawn-cwd-pick');
  const spawnHarnessPi = document.getElementById('spawn-harness-pi');
  const spawnRoleEl    = document.getElementById('spawn-role-select');
  const spawnRoleBtn   = document.getElementById('spawn-role-btn');
  const spawnRoleMenu  = document.getElementById('spawn-role-menu');
  const roleList = spawnRoleEl && spawnRoleBtn && spawnRoleMenu
    ? window.__CUBILOT_TERM__.roleList.attach({ select: spawnRoleEl, button: spawnRoleBtn, menu: spawnRoleMenu, doc: document })
    : null;
  const spawnRoleErrEl = document.getElementById('spawn-role-error');
  const spawnGridEl    = document.getElementById('spawn-grid');
  const spawnGridFilterEl = document.getElementById('spawn-grid-filter');
  const spawnGridCountEl  = document.getElementById('spawn-grid-count');
  const spawnGridNoteEl   = document.getElementById('spawn-grid-note');
  const spawnHarnessClaude = document.getElementById('spawn-harness-claude');
  let spawnRoles = new Map();
  // Ticket t_41e14dde706805e3 trace: every write to the role select's value is logged with the caller, so a launch that
  // lost its role shows which path cleared it. Remove it when the cause is fixed.
  if (spawnRoleEl) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc?.set && desc?.get) {
      Object.defineProperty(spawnRoleEl, 'value', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) {
          const before = desc.get.call(this);
          desc.set.call(this, v);
          const after = desc.get.call(this);
          if (before !== after) console.info('[terminal] role value', { before, after, stack: String(new Error().stack).split('\n').slice(2, 5).map((l) => l.trim()) });
        },
      });
    }
  }
  const spawnRoomEl     = document.getElementById('spawn-room-input');
  const spawnRoomBtn    = document.getElementById('spawn-room-picker-btn');
  const spawnRoomMenu   = document.getElementById('spawn-room-menu');
  const spawnCancel   = document.getElementById('spawn-cancel');
  const spawnSubmit   = document.getElementById('spawn-submit');
  const spawnSessionContinue = document.getElementById('spawn-session-continue');
  const spawnSessionResume   = document.getElementById('spawn-session-resume');

  const NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;

  const LOADING_VERBS = [
    'Spawning the session…',
    'Wiring the channel…',
    'Tailing the SSE stream…',
    'Briefing the agent…',
    'Warming up the PTY…',
    'Summoning Claude…',
    'Registering with the hub…',
    'Syncing the roster…',
    'Unrolling the nutshell…',
    'Awaiting the first byte…',
  ];
  let _verbIdx = -1;
  function pickLoadingVerb() {
    let i = Math.floor(Math.random() * LOADING_VERBS.length);
    if (i === _verbIdx) i = (i + 1) % LOADING_VERBS.length;
    _verbIdx = i;
    return LOADING_VERBS[i];
  }

  const SPLIT_KEY = 'cubilot_terminal_split';

  localStorage.removeItem('cubilot_terminal_enabled');
  localStorage.removeItem('cubilot_ui_version');
  let _paneEnabled = false;

  function paneEnabled() {
    return _paneEnabled;
  }
  function applyPaneClass() {
    body.classList.toggle('no-terminal', !paneEnabled());
    toggleBtn?.setAttribute('aria-pressed', String(paneEnabled()));
  }
  // Every enable path (click, handleLaunch, startup restore) goes through here, so the board hears of it.
  function setPaneEnabled(on) {
    _paneEnabled = on;
    applyPaneClass();
    document.dispatchEvent(new CustomEvent('cubilot:right-pane', { detail: { pane: on ? 'terminal' : null } }));
  }
  // The chat takes this share (25-75 %) of the width that is left after the agent column, not of the whole window.
  function splitPercent(clientX, bodyLeft, bodyWidth, colWidth) {
    const avail = bodyWidth - colWidth;
    if (!(avail > 0)) return 50;
    const pct = ((clientX - bodyLeft - colWidth) / avail) * 100;
    return Math.max(25, Math.min(75, pct));
  }
  function applySplit() {
    const raw = localStorage.getItem(SPLIT_KEY);
    const pct = raw ? Number(raw) : 50;
    const clamped = Math.max(25, Math.min(75, Number.isFinite(pct) ? pct : 50));
    appBody.style.setProperty('--split-frac', String(clamped / 100));
  }
  applyPaneClass();
  applySplit();

  // The right pane shows the board or the terminal, never both (see cubilot:right-pane in ticket.js).
  function onTerminalToggle() {
    const boardOpen = body.classList.contains('board-open');
    setPaneEnabled(boardOpen ? true : !_paneEnabled);
    if (_paneEnabled) {
      reconcile();
      ensureShellAttached();
    }
    for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
  }
  function onRightPane(e) {
    if (e.detail?.pane !== 'board' || !_paneEnabled) return;
    _paneEnabled = false;
    applyPaneClass();
  }
  toggleBtn?.addEventListener('click', onTerminalToggle);
  document.addEventListener('cubilot:right-pane', onRightPane);

  let dragStart = null;
  // The splitter is visible for the terminal and for the board, so both can start a drag.
  function onSplitterDown(e) {
    if (!paneEnabled() && !body.classList.contains('board-open')) return;
    dragStart = { x: e.clientX, width: appBody.getBoundingClientRect().width };
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
  }
  splitter?.addEventListener('pointerdown', onSplitterDown);
  splitter?.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const rect = appBody.getBoundingClientRect();
    const clamped = splitPercent(e.clientX, rect.left, rect.width, agentCol?.getBoundingClientRect().width || 0);
    appBody.style.setProperty('--split-frac', String(clamped / 100));
    localStorage.setItem(SPLIT_KEY, String(Math.round(clamped)));
    for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
  });
  const endDrag = (e) => {
    if (!dragStart) return;
    splitter.classList.remove('dragging');
    try { splitter.releasePointerCapture(e.pointerId); } catch {}
    dragStart = null;
    for (const t of tabs.values()) if (t.term) sendResize(t);
  };
  splitter?.addEventListener('pointerup',     endDrag);
  splitter?.addEventListener('pointercancel', endDrag);

  const tabs = new Map();
  let activeAgent = null;
  let cwdCache = JSON.parse(localStorage.getItem('cubilot_agent_cwds') || '{}');
  function rememberCwd(agent, cwd) {
    cwdCache[agent] = cwd;
    localStorage.setItem('cubilot_agent_cwds', JSON.stringify(cwdCache));
  }

  const { roleMemory, factoryRoom, modelGrid, gridView } = window.__CUBILOT_TERM__;

  const {
    ptySpawn, listRoles, listModels, ptyWrite, ptyResize, ptyKill, ptyList, ptyEventName,
    strToB64, b64ToBytes,
  } = window.__CUBILOT_TERM__.pty;

  const currentXtermTheme = window.__CUBILOT_TERM__.xtermThemes.current;
  const currentXtermFontSize = window.__CUBILOT_TERM__.xtermThemes.fontSize;
  const currentXtermFontFamily = window.__CUBILOT_TERM__.xtermThemes.fontFamily;
  function applyXtermThemeToAll() {
    const theme = currentXtermTheme();
    const fontSize = currentXtermFontSize();
    const fontFamily = currentXtermFontFamily();
    for (const tab of tabs.values()) {
      if (!tab.term) continue;
      tab.term.options.theme = theme;
      let metricsChanged = false;
      if (tab.term.options.fontSize !== fontSize) {
        tab.term.options.fontSize = fontSize;
        metricsChanged = true;
      }
      if (tab.term.options.fontFamily !== fontFamily) {
        tab.term.options.fontFamily = fontFamily;
        metricsChanged = true;
      }
      if (metricsChanged && tab.fitAddon) {
        // Cell size or atlas changed; refit so cols/rows match.
        try { tab.fitAddon.fit(); } catch {}
        sendResize(tab);
      }
    }
  }
  document.addEventListener('cubilot:theme-changed', applyXtermThemeToAll);

  // Mirrors Rust SHELL_SESSION_NAME; never filtered by room, never closed from UI.
  const SHELL_NAME = 'shell';
  function isShell(agent) { return agent === SHELL_NAME; }

  function ensureShellTab() {
    let t = tabs.get(SHELL_NAME);
    if (t) return t;
    const tabEl = document.createElement('div');
    tabEl.className = 'terminal-tab terminal-tab-shell';
    tabEl.dataset.agent = SHELL_NAME;
    tabEl.dataset.state = 'external';
    // No data-room: shell is cross-room and survives every filter.
    tabEl.innerHTML =
      '<svg viewBox="0 0 24 24" class="tab-icon" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' +
      '<button type="button" class="tab-label"></button>';
    tabEl.querySelector('.tab-label').textContent = 'Shell';
    tabEl.title = 'Your scratch shell — cross-room, cross-project';
    tabEl.addEventListener('click', () => openAgentSession(SHELL_NAME));
    tabsEl.insertBefore(tabEl, tabsEl.firstChild);

    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.agent = SHELL_NAME;
    bodyEl.appendChild(paneEl);

    t = { state: 'external', tabEl, paneEl, term: null, fitAddon: null,
          outputUnlisten: null, exitUnlisten: null, cwd: null, external: true };
    tabs.set(SHELL_NAME, t);
    return t;
  }

  async function ensureShellAttached() {
    const t = ensureShellTab();
    if (t.state === 'live' || t.state === 'launching') return;
    setTabState(SHELL_NAME, 'launching');
    try {
      await invoke('pty_spawn_shell');
      setTabState(SHELL_NAME, 'live');
      await attachOutputListener(SHELL_NAME);
      const tt = tabs.get(SHELL_NAME);
      if (tt) sendResize(tt);
    } catch (e) {
      console.warn('[terminal] shell spawn failed', e);
      setTabState(SHELL_NAME, 'external');
    }
  }

  // Agents the hub is skipping in broadcast fan-out. Mirrors hub state, kept in
  // sync by the `[agent paused]` / `[agent resumed]` entries the hub emits —
  // including when it auto-resumes because the human addressed the agent directly.
  const PAUSED_AGENTS = new Set();
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

  function renderPauseToggle(agent) {
    const t = tabs.get(agent);
    const btn = t?.tabEl?.querySelector('.pause-toggle');
    if (!btn) return;
    const paused = PAUSED_AGENTS.has(agent);
    // One control that swaps glyph: pause when running, play when paused.
    btn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    btn.title = paused
      ? 'Resume this agent — it receives room broadcasts again'
      : 'Pause this agent — it stops receiving room broadcasts';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(paused));
    t.tabEl.classList.toggle('paused', paused);
  }

  // Each pause request takes a number that is unique across all tabs and stores it
  // on its tab; a reply that is not the latest for the current tab is dropped, so
  // neither a slow older reply nor a reply for a closed tab can overwrite the state.
  let pauseReqSeq = 0;
  function nextPauseSeq(agent) {
    const t = tabs.get(agent);
    return t ? (t.pauseSeq = ++pauseReqSeq) : 0;
  }
  const isLatestPause = (agent, seq) => tabs.get(agent)?.pauseSeq === seq;

  // Returns the promise of the whole request. The tab keeps it (`pausePost`) while it is in flight, so a
  // launch can tell that an older pause write may still land at the hub after its own.
  function setAgentPaused(agent, paused) {
    // One request at a time per tab: the button stays disabled until the hub answers, so a
    // double click cannot send a second request computed from the same stale state.
    const t = tabs.get(agent);
    if (t?.pausePending) return Promise.resolve();
    const btn = t?.tabEl?.querySelector('.pause-toggle');
    if (t) t.pausePending = true;
    if (btn) btn.disabled = true;
    const seq = nextPauseSeq(agent);
    if (t) t.pauseWriteSeq = (t.pauseWriteSeq || 0) + 1;   // a user write: it outranks a launch's correction
    const done = (async () => {
      try {
        const r = await authedFetch(`/agents/${encodeURIComponent(agent)}/pause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused, by: HUMAN_NAME }),
        });
        if (!r.ok || !isLatestPause(agent, seq)) return;
        if (paused) PAUSED_AGENTS.add(agent); else PAUSED_AGENTS.delete(agent);
        renderPauseToggle(agent);
      } catch { /* best-effort; the hub entry will correct us if it landed */ }
      finally {
        if (t) t.pausePending = false;
        if (btn) btn.disabled = false;
      }
    })();
    if (t) {
      t.pausePost = done;
      done.then(() => { if (t.pausePost === done) t.pausePost = null; });
    }
    return done;
  }

  // A launch from the UI is a fresh start: the hub cannot tell a quick respawn from a network
  // reconnect (both reuse the same Agent object inside its 15 s stale window), so the launch
  // clears the pause explicitly. A plain reconnect and autoAttach leave it alone.
  // It takes a new request number first, so a pause READ still in flight is ignored when it answers.
  // And a pause WRITE sent before the launch may still reach the hub after our clear: when that older
  // write settles, the clear is sent again, so the hub ends unpaused, and the indicator is re-read.
  // Only a newer WRITE (the user's, or another launch's: `pauseWriteSeq`) or a replaced tab cancels that correction. A
  // read must not: the older write's own audit entry triggers one, and it would cancel the fix.
  // The launch itself never waits for any of it.
  async function clearPauseForLaunch(agent) {
    const seq = nextPauseSeq(agent);
    const t = tabs.get(agent);
    const older = t?.pausePost;
    const writeSeq = t ? (t.pauseWriteSeq = (t.pauseWriteSeq || 0) + 1) : 0;
    PAUSED_AGENTS.delete(agent);
    renderPauseToggle(agent);
    const send = () => authedFetch(`/agents/${encodeURIComponent(agent)}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: false, by: HUMAN_NAME }),
    });
    if (older) {
      older.then(async () => {
        if (tabs.get(agent) !== t) return;                 // the tab was closed or replaced: its successor owns the pause
        if (t && t.pauseWriteSeq !== writeSeq) return;
        try { await send(); } catch { /* best-effort */ }
        syncPauseState(agent);
      });
    }
    try {
      await send();
    } catch { /* best-effort: an unknown agent answers 400, and a launch must not wait on this */ }
  }

  // The hub is the source of truth: read it per tab on creation, on every stream
  // (re)connect (a hub restart clears all pauses), and whenever a pause entry
  // arrives — entries only signal a change, so replayed history cannot restore a
  // stale indicator.
  async function syncPauseState(agent) {
    const seq = nextPauseSeq(agent);
    try {
      const r = await authedFetch(`/agents/${encodeURIComponent(agent)}/pause`);
      if (!r.ok) return;
      const { paused } = await r.json();
      if (!isLatestPause(agent, seq)) return;
      if (paused) PAUSED_AGENTS.add(agent); else PAUSED_AGENTS.delete(agent);
      renderPauseToggle(agent);
    } catch {}
  }

  window.syncAllPauseStates = function syncAllPauseStates() {
    for (const agent of tabs.keys()) if (!isShell(agent)) syncPauseState(agent);
  };

  // Called from messages.js for every entry so a pause set anywhere lands here.
  window.notePauseEntry = function notePauseEntry(entry) {
    if (entry?.from !== 'system' || typeof entry.to !== 'string') return;
    if (entry.text !== '[agent paused]' && entry.text !== '[agent resumed]') return;
    if (tabs.has(entry.to)) syncPauseState(entry.to);
  };

  function ensureTab(agent) {
    if (isShell(agent)) return ensureShellTab();
    let t = tabs.get(agent);
    if (t) return t;
    const tabEl = document.createElement('div');
    tabEl.className = 'terminal-tab';
    tabEl.dataset.agent = agent;
    tabEl.dataset.state = 'external';
    // Carry room on the tab so main.js's room filter hides cross-room tabs.
    if (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER)) {
      const ra = ROSTER.find((x) => x && x.name === agent);
      if (ra && typeof ra.room === 'string' && ra.room) tabEl.dataset.room = ra.room;
      if (ra?.color) tabEl.style.setProperty('--agent-color', ra.color);
    }
    tabEl.dataset.presence = (typeof presenceState !== 'undefined' && presenceState[agent]) ? 'online' : 'offline';
    const icon = (paths) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    tabEl.innerHTML =
      '<div class="row-main">' +
      '<button type="button" class="row-chevron" aria-expanded="false">' + icon('<polyline points="9 6 15 12 9 18"/>') + '</button>' +
      '<span class="state-dot"></span>' +
      '<button type="button" class="tab-label"></button>' +
      '<span class="row-state lbl-offline">offline</span><span class="row-state lbl-paused">paused</span><span class="row-state lbl-needs">needs you</span>' +
      '<span class="row-actions">' +
        '<button type="button" class="pause-toggle"></button>' +
        '<button type="button" class="open-editor" title="Open editor at this agent\'s cwd">' +
          icon('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="7" y1="13" x2="11" y2="13"/><line x1="13" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="14" y2="17"/>') +
        '</button>' +
        '<button type="button" class="reload-btn" title="Reload: read the status of this agent again">' + icon('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>') + '</button>' +
        '<span class="row-gap"></span>' +
        '<button type="button" class="close-x" title="Kill session">×</button>' +
        '<button type="button" class="remove-agent" title="Remove agent">×</button>' +
      '</span>' +
      '</div>' +
      '<div class="reload-msg" role="status" hidden></div>' +
      // The announcement of the skills strip (C6c). It lives here, outside .row-details: renderRowDetails replaces that
      // subtree at every rebuild, and a live region that is removed and inserted again is not announced reliably.
      '<div class="skills-live visually-hidden" role="status" aria-live="polite"></div>' +
      '<div class="row-details" hidden></div>';
    tabEl.querySelector('.tab-label').textContent = agent;
    tabEl.querySelector('.tab-label').title = agent;
    const chevron = tabEl.querySelector('.row-chevron');
    chevron.setAttribute('aria-label', 'Show details of ' + agent);
    tabEl.querySelector('.open-editor').setAttribute('aria-label', 'Open editor for ' + agent);
    tabEl.querySelector('.reload-btn').setAttribute('aria-label', 'Reload ' + agent);
    tabEl.querySelector('.close-x').setAttribute('aria-label', 'Kill session of ' + agent);
    tabEl.querySelector('.remove-agent').setAttribute('aria-label', 'Remove ' + agent);
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions') || e.target.closest('.row-chevron') || e.target.closest('.row-details')) return;
      openAgentSession(agent);
    });
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = chevron.getAttribute('aria-expanded') !== 'true';
      chevron.setAttribute('aria-expanded', String(open));
      tabEl.querySelector('.row-details').hidden = !open;
      writeOpenRow(agent, open);
      if (open) refreshSkills(agent);   // the states are read again each time the row opens
    });
    tabEl.querySelector('.pause-toggle').addEventListener('click', async (e) => {
      e.stopPropagation();
      await setAgentPaused(agent, !PAUSED_AGENTS.has(agent));
    });
    tabEl.querySelector('.close-x').addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleKill(agent);
    });
    tabEl.querySelector('.open-editor').addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleOpenEditor(agent);
    });
    tabEl.querySelector('.reload-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      reloadAgent(agent);
    });
    tabEl.querySelector('.remove-agent').addEventListener('click', (e) => {
      e.stopPropagation();
      removeAgentFromHub(agent, e.currentTarget);
    });
    tabsEl.appendChild(tabEl);
    if (readOpenRows()[agent]) {
      chevron.setAttribute('aria-expanded', 'true');
      tabEl.querySelector('.row-details').hidden = false;
    }

    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.agent = agent;
    bodyEl.appendChild(paneEl);

    t = { state: 'external', tabEl, paneEl, term: null, fitAddon: null,
          outputUnlisten: null, exitUnlisten: null, cwd: cwdCache[agent] || null, external: true };
    tabs.set(agent, t);
    setReloadState(agent, 'ready');
    renderRowDetails(agent);
    renderPauseToggle(agent);
    syncPauseState(agent);
    return t;
  }

  function removeTab(agent) {
    const t = tabs.get(agent);
    if (!t) return;
    try { t.outputUnlisten?.(); } catch {}
    try { t.exitUnlisten?.(); } catch {}
    try { t.term?.dispose(); } catch {}
    t.tabEl.remove();
    t.paneEl.remove();
    tabs.delete(agent);
    PAUSED_AGENTS.delete(agent);
    if (activeAgent === agent) activeAgent = null;
  }

  // Which rows are open is kept per agent in localStorage; a storage error (private mode, quota) only loses that.
  const ROWS_OPEN_KEY = 'cubilot_open_rows';
  function readOpenRows() {
    try { return JSON.parse(localStorage.getItem(ROWS_OPEN_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeOpenRow(agent, open) {
    try {
      const rows = readOpenRows();
      if (open) rows[agent] = true; else delete rows[agent];
      localStorage.setItem(ROWS_OPEN_KEY, JSON.stringify(rows));
    } catch {}
  }

  // The details of an open row: the same recorded values the old pill card showed (pillCardFields over pty_roles).
  const HARNESS_LABEL = { claude: 'claude \u00b7 Claude Code', pi: 'pi \u00b7 pi.dev' };
  function renderRowDetails(agent) {
    const el = tabs.get(agent)?.tabEl?.querySelector('.row-details');
    if (!el) return;
    const info = typeof pillRoles !== 'undefined' ? pillRoles[agent] : undefined;
    const f = Object.fromEntries(window.pillCardFields(info));
    const kv = (k, v) => {
      const row = document.createElement('div');
      row.className = 'row-kv';
      const ke = document.createElement('span'); ke.className = 'row-k'; ke.textContent = k;
      const ve = document.createElement('span'); ve.className = 'row-v'; ve.textContent = v;
      row.append(ke, ve);
      return row;
    };
    const fac = tabs.get(agent)?.factory;
    // A rebuild must not take the keyboard focus from a checkbox or a button of the skills area.
    const keep = el.contains?.(document.activeElement) ? document.activeElement?.dataset?.focusKey : undefined;
    el.replaceChildren(kv('Harness', HARNESS_LABEL[f.Harness] || '-'), kv('Model \u00d7 effort', `${f.Model} \u00d7 ${f.Effort}`));
    if (fac) el.append(kv('Factory', fac.linked ? `${fac.applied || '-'}${fac.pending ? ' \u2192 ' + fac.pending : ''}` : 'no link'));
    // The skills area. A role agent gets its checkboxes there (ticket C6c); an agent with no role loads its own skills.
    const skills = document.createElement('div');
    if (info?.role) {
      skills.className = 'row-skills';
      skills.dataset.role = info.role;
      fillSkills(agent, skills);
      if (!el.hidden && !tabs.get(agent)?.skills && !tabs.get(agent)?.skillsLoading) refreshSkills(agent);
    } else {
      skills.className = 'row-noskills';
      skills.textContent = 'No role: the agent loads your own Claude or Pi skills.';
    }
    el.append(skills);
    if (keep !== undefined) [...el.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === keep)?.focus();
  }

  // ---- C6c: skill switches of the open row. The backend (skills.rs) owns the choice and the states; the row only shows
  // them (design note factory/brief/04a-c6-design.md, section 2a point 8) and saves a change at once: agent_skills_set
  // (the intent), then agent_skills_apply (prepares the build; "Relaunch <agent> to apply" when the agent has no view).
  // A reload is a separate click: the strip button calls reloadAgent. The box always shows the SAVED value (t.skills.data),
  // except while its own save runs (t.skillsPending).
  const errText = (e) => (typeof e === 'string' ? e : e?.message || String(e));
  const skillName = (id) => id.slice(id.indexOf('/') + 1);
  const skillChanged = (s) => s.on !== (s.state === 'loaded');   // the box differs from what the agent loaded
  // The label of one skill: loaded and off-and-loaded show none; "not loaded" only after a reload applied it.
  function skillNote(s) {
    if (s.state === 'new') return s.on ? 'new, loads on Reload' : 'new, stays off on Reload';
    if (s.state === 'not_loaded') return 'not loaded';
    return '';
  }
  const skillsOf = (d) => d.groups.flatMap((g) => g.skills);
  const changesOf = (d) => skillsOf(d).filter(skillChanged).length;

  async function refreshSkills(agent) {
    const t = tabs.get(agent);
    if (!t) return;
    const seq = (t.skillsSeq = (t.skillsSeq || 0) + 1);   // a save started later makes this answer stale
    t.skillsLoading = true;
    try {
      const data = await invoke('agent_skills', { agent });
      if (tabs.get(agent) !== t || t.skillsSeq !== seq) return;
      t.skills = { data, error: t.skills?.error || '', readError: '' };   // a good read clears an old read error, never a save error
    } catch (e) {
      if (tabs.get(agent) !== t || t.skillsSeq !== seq) return;
      console.warn('[terminal] agent_skills', agent, e);
      t.skills = { data: t.skills?.data || null, error: t.skills?.error || '', readError: `Skills not available: ${errText(e)}` };
    } finally {
      if (tabs.get(agent) === t) t.skillsLoading = false;
    }
    renderRowDetails(agent);
    syncChangeState(agent);
  }

  // The button of the row follows the strip: "change waits" while a box differs from what is loaded. Ready, failed and
  // stale keep their own text; only ready and change are switched here.
  function syncChangeState(agent) {
    const t = tabs.get(agent);
    const d = t?.skills?.data;
    if (!d || (t.reloadState !== 'ready' && t.reloadState !== 'change')) return;
    const want = changesOf(d) > 0 ? 'change' : 'ready';
    if (t.reloadState !== want) setReloadState(agent, want);
  }

  // One save at a time for one agent: a second click waits for the first, then reads the saved list again.
  function changeSkills(agent, mutate, touched) {
    const t = tabs.get(agent);
    if (!t?.skills?.data) return;
    t.skillsPending = t.skillsPending || new Map();
    for (const [id, on] of touched) t.skillsPending.set(id, on);
    t.skillsChain = (t.skillsChain || Promise.resolve()).then(() => saveSkills(agent, mutate, touched));
    return t.skillsChain;
  }
  async function saveSkills(agent, mutate, touched) {
    const t = tabs.get(agent);
    if (!t?.skills?.data) return;
    const d = t.skills.data;
    const off = new Set(skillsOf(d).filter((s) => !s.on).map((s) => s.id));
    mutate(off);
    t.skillsSeq = (t.skillsSeq || 0) + 1;
    const done = () => { for (const [id] of touched) t.skillsPending?.delete(id); };
    try {
      await invoke('agent_skills_set', { agent, off: [...off].sort() });
    } catch (e) {
      done();
      t.skills.error = `Could not save the skill choice: ${errText(e)}`;
      renderRowDetails(agent);   // the boxes return to the saved values
      return;
    }
    t.skills.error = '';
    for (const s of skillsOf(d)) s.on = !off.has(s.id);
    done();
    try {
      await invoke('agent_skills_apply', { agent });
    } catch (e) {
      const m = errText(e);
      // "Relaunch <agent> to apply" is not a failure: the strip says it (relaunch_needed comes back from agent_skills).
      if (!/^Relaunch /.test(m)) t.skills.error = `The choice is saved, but it could not be prepared: ${m}`;
    }
    await refreshSkills(agent);   // states, relaunch_needed and the count as the backend sees them
  }

  function skillBox(agent, t, s) {
    const on = t.skillsPending?.has(s.id) ? t.skillsPending.get(s.id) : s.on;
    const note = skillNote({ ...s, on });
    const name = skillName(s.id);
    const item = document.createElement('div');
    item.className = 'skill-item';
    item.dataset.state = s.state;
    if (!on && s.state === 'not_loaded') item.classList.add('is-grey');
    const label = document.createElement('label');
    label.title = name;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.dataset.focusKey = s.id;
    const text = document.createElement('span');
    text.className = 'skill-name';
    text.textContent = name;
    label.append(box, text);
    item.append(label);
    if (note) {
      const n = document.createElement('span');
      n.className = 'skill-note';
      n.textContent = note;
      n.id = `skill-note-${agent}-${s.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
      box.setAttribute('aria-describedby', n.id);
      item.append(n);
    }
    box.addEventListener('change', () => changeSkills(agent, (off) => { if (box.checked) off.delete(s.id); else off.add(s.id); }, [[s.id, box.checked]]));
    return item;
  }

  // The strip is created once per agent and moved into each rebuild. A screen reader hears the change through the
  // persistent .skills-live region of the row, which skillsStrip updates.
  function skillsStrip(agent, t, d) {
    if (!t.skillsStrip) {
      const strip = document.createElement('div');
      strip.className = 'skills-strip';
      const text = document.createElement('span');
      text.className = 'skills-strip-text';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skills-reload';
      btn.dataset.focusKey = 'reload';
      btn.addEventListener('click', () => reloadAgent(agent));
      strip.append(text, btn);
      t.skillsStrip = strip;
    }
    const strip = t.skillsStrip;
    const n = changesOf(d);
    const text = strip.querySelector('.skills-strip-text');
    const btn = strip.querySelector('.skills-reload');
    if (d.relaunch_needed) {
      text.textContent = `Relaunch ${agent} to apply`;   // a reload cannot apply it: the agent was started without a skill view
      btn.hidden = true;
    } else if (n > 0) {
      text.textContent = `${n} change${n === 1 ? ' waits' : 's wait'} for Reload`;
      btn.hidden = false;
      btn.textContent = `Reload ${agent}`;
      btn.setAttribute('aria-disabled', String(t.reloadState === 'reloading'));
    } else {
      text.textContent = '';
      btn.hidden = true;
    }
    strip.hidden = !text.textContent;
    // The same status, spoken with the agent name: the live region of the row stays mounted and only its text changes.
    // An unchanged text is not set again, so a rebuild with the same strip does not repeat the announcement.
    const live = t.tabEl.querySelector('.skills-live');
    const spoken = text.textContent ? `${agent}: ${text.textContent}` : '';
    if (live && live.textContent !== spoken) live.textContent = spoken;
    return strip;
  }

  function fillSkills(agent, host) {
    const t = tabs.get(agent);
    const d = t?.skills?.data;
    if (!d) {
      const m = document.createElement('div');
      const failed = t?.skills?.readError || t?.skills?.error;
      m.className = failed ? 'skills-error' : 'skills-loading';
      m.textContent = failed || 'Loading skills\u2026';
      host.append(m);
      return;
    }
    if (!d.role) {
      const m = document.createElement('div');
      m.className = 'row-noskills';
      m.textContent = 'No role: the agent loads your own Claude or Pi skills.';
      host.append(m);
      return;
    }
    const all = skillsOf(d);
    const nOn = all.filter((s) => (t.skillsPending?.has(s.id) ? t.skillsPending.get(s.id) : s.on)).length;
    const head = document.createElement('div');
    head.className = 'skills-head';
    const title = document.createElement('span');
    title.className = 'skills-title';
    title.textContent = 'Skills';
    const count = document.createElement('span');
    count.className = 'skills-count';
    count.textContent = `${nOn} of ${all.length} on`;
    const allOn = document.createElement('button');
    allOn.type = 'button';
    allOn.className = 'skills-all';
    allOn.dataset.focusKey = 'turn-all-on';
    allOn.textContent = 'Turn all on';
    // aria-disabled, not disabled: a disabled button would drop the keyboard focus that the press just gave it.
    allOn.setAttribute('aria-disabled', String(nOn === all.length));
    allOn.addEventListener('click', () => {
      if (allOn.getAttribute('aria-disabled') === 'true') return;
      changeSkills(agent, (off) => off.clear(), all.filter((s) => !s.on).map((s) => [s.id, true]));
    });
    head.append(title, count, allOn);
    host.append(head);
    for (const message of [t.skills.readError, t.skills.error]) {
      if (!message) continue;
      const err = document.createElement('div');
      err.className = 'skills-error';
      err.setAttribute('role', 'alert');
      err.textContent = message;
      host.append(err);
    }
    for (const g of d.groups) {
      const group = document.createElement('div');
      group.className = 'skills-group';
      const gn = document.createElement('div');
      gn.className = 'skills-group-name';
      gn.textContent = g.name;
      group.append(gn);
      for (const s of g.skills) group.append(skillBox(agent, t, s));
      host.append(group);
    }
    host.append(skillsStrip(agent, t, d));
  }
  window.renderRowDetails = () => { for (const agent of tabs.keys()) if (!isShell(agent)) renderRowDetails(agent); };

  // The Reload button of a row (C5b): ready, change (a skill switch waits, C6c), reloading, failed. It asks the hub to
  // reload this one agent (POST /agents/:name/reload, answered with the status) and shows the status again.
  const RELOAD_MSG = {
    reloading: 'Reloading\u2026 (waits for the end of a run)',
    failed: 'Reload failed. Click to try again.',
    stale: 'Still waiting for the end of a run. Click to send again.',
  };
  // note: a text for the state (the reason when the click only read the status, or "no answer" after the time limit).
  function setReloadState(agent, state, note = '') {
    const t = tabs.get(agent);
    if (!t) return;
    t.reloadState = state;
    t.tabEl.dataset.reload = state;
    const btn = t.tabEl.querySelector('.reload-btn');
    const msg = t.tabEl.querySelector('.reload-msg');
    btn.disabled = state === 'reloading';
    t.skillsStrip?.querySelector('.skills-reload')?.setAttribute('aria-disabled', String(state === 'reloading'));
    btn.setAttribute('aria-label', state === 'failed' ? 'Reload failed. Click to reload ' + agent + ' again.' : 'Reload ' + agent);
    msg.textContent = note || RELOAD_MSG[state] || '';
    msg.hidden = !msg.textContent;
  }

  // The status the hub answers with: presence, pause, room and the factory record. The row shows it again.
  function applyReloadStatus(agent, s) {
    const t = tabs.get(agent);
    if (!t) return;
    if (typeof s.online === 'boolean') window.setAgentPresence(agent, s.online);
    if (typeof s.paused === 'boolean') {
      if (s.paused) PAUSED_AGENTS.add(agent); else PAUSED_AGENTS.delete(agent);
      renderPauseToggle(agent);
    }
    t.factory = s.factory || null;
    renderRowDetails(agent);
    if (!t.tabEl.querySelector('.row-details')?.hidden) refreshSkills(agent);   // a reload may have loaded or dropped skills
    if (typeof refreshRolePills === 'function') refreshRolePills();   // pty_roles: role, model and effort again
  }

  // The result of THIS click: factory.last (written by the hub when the agent reports) with the reload_id that the
  // POST answered. A time cannot tell which reload finished, so an older or newer result with another id does not count.
  function reloadOutcome(factory, reloadId) {
    const last = factory?.last;
    if (!reloadId || !last || last.reload_id !== reloadId) return null;
    return last.result === 'applied' || last.result === 'failed' ? last.result : null;
  }

  const RELOAD_POLL_MS = 1000;
  // A busy agent starts the reload at the end of its run, which can take minutes, so a missing start is not a failure.
  // After RELOAD_LIMIT_MS without a start the row shows "stale": the button is enabled again and the poll goes on (a late
  // start shows "reloading" again). After RELOAD_GIVE_UP_MS without a start the poll stops and the row stays stale.
  // Once the bridge has started the reload (factory.pending_reload_id is this click's id) its own bound is 30 s, and
  // RELOAD_LIMIT_MS is also the time to wait for the result.
  const RELOAD_LIMIT_MS = 45000;
  const RELOAD_GIVE_UP_MS = 600000;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function reloadAgent(agent) {
    const t = tabs.get(agent);
    if (!t || t.reloadState === 'reloading') return;
    const mySeq = (t.reloadSeq = (t.reloadSeq || 0) + 1);   // a click after Failed or ready starts a new poll: the old one stops
    const current = () => tabs.get(agent) === t && t.reloadSeq === mySeq;
    const clickAt = Date.now();
    setReloadState(agent, 'reloading');
    const path = `/agents/${encodeURIComponent(agent)}`;
    try {
      const r = await authedFetch(`${path}/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A click of the human means "reload now", also for the version the agent already has.
        body: JSON.stringify({ by: HUMAN_NAME, force: true }),
      });
      if (!r.ok) throw new Error(`reload: ${r.status}`);
      const s = await r.json();
      applyReloadStatus(agent, s);
      const reloadId = s.reload_id;
      // No request went out: the agent is offline, or it has no factory link. The click only read the status.
      if (!s.requested) {
        setReloadState(agent, 'ready', s.online === false ? 'The agent is offline: nothing was reloaded.' : 'This agent has no factory link: only its status was read again.');
        return;
      }
      let startedAt = null;
      for (;;) {
        await wait(RELOAD_POLL_MS);
        if (!current()) return;   // a newer click, or the row went away: this poll stops
        let status = null;
        try {
          const p = await authedFetch(`${path}/reload-status`);
          if (p.ok) status = await p.json();
        } catch { /* a missed poll: the next one asks again */ }
        if (!status) continue;
        if (status.online === false) {
          applyReloadStatus(agent, status);
          setReloadState(agent, 'failed', 'Reload failed: agent offline. Click to try again.');
          return;
        }
        const outcome = reloadOutcome(status.factory, reloadId);
        if (outcome) {
          applyReloadStatus(agent, status);
          setReloadState(agent, outcome === 'applied' ? 'ready' : 'failed');
          return;
        }
        if (startedAt === null && reloadId && status.factory?.pending_reload_id === reloadId) {
          startedAt = Date.now();
          if (t.reloadState === 'stale') setReloadState(agent, 'reloading');   // a late start
        }
        if (startedAt !== null && Date.now() >= startedAt + RELOAD_LIMIT_MS) {
          setReloadState(agent, 'failed', 'Reload failed: no answer. Click to try again.');
          return;
        }
        if (startedAt === null) {
          const waited = Date.now() - clickAt;
          if (waited >= RELOAD_GIVE_UP_MS) {
            setReloadState(agent, 'stale');
            return;
          }
          if (waited >= RELOAD_LIMIT_MS && t.reloadState !== 'stale') setReloadState(agent, 'stale');
        }
      }
    } catch (e) {
      if (!current()) return;
      console.warn('[terminal] reload', agent, e);
      setReloadState(agent, 'failed');
    }
  }

  // C6c: a skill switch that is not loaded yet puts the button in "change waits"; the next reload clears it.
  window.markReloadChange = function markReloadChange(agent, waiting) {
    const t = tabs.get(agent);
    if (!t || t.reloadState === 'reloading') return;
    setReloadState(agent, waiting ? 'change' : 'ready');
  };

  // A click on a row (or Enter on its name) shows that session in the right pane: it opens the terminal pane when
  // it is closed, and replaces the board when the board shows (setPaneEnabled sends cubilot:right-pane).
  function openAgentSession(agent) {
    if (!_paneEnabled) {
      setPaneEnabled(true);
      reconcile();
      ensureShellAttached();
    }
    focusTab(agent);
    for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
  }

  // roster.js reports each agent's presence; the row dot and the "offline" label follow it.
  window.setAgentPresence = function setAgentPresence(agent, online) {
    const t = tabs.get(agent);
    if (t) t.tabEl.dataset.presence = online ? 'online' : 'offline';
  };
  window.reconcileAgentColumn = () => reconcile();

  function setTabState(agent, state) {
    const t = tabs.get(agent);
    if (!t) return;
    t.state = state;
    t.tabEl.dataset.state = state;
    renderPaneBody(t);
  }

  function renderPaneBody(t) {
    for (const child of Array.from(t.paneEl.children)) {
      if (child.classList?.contains('terminal-empty') ||
          child.classList?.contains('terminal-external-info') ||
          child.classList?.contains('terminal-loading')) {
        child.remove();
      }
    }
    if (t.state === 'launching' || (t.state === 'live' && !t.term)) {
      const loader = document.createElement('div');
      loader.className = 'terminal-loading';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 48 48');
      svg.setAttribute('class', 'terminal-loading-icon');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML =
        '<g stroke="var(--orange)" stroke-width="4" stroke-linecap="round" fill="none">' +
          '<line x1="24" y1="4"  x2="24" y2="44"/>' +
          '<line x1="4"  y1="24" x2="44" y2="24"/>' +
          '<line x1="10" y1="10" x2="38" y2="38"/>' +
          '<line x1="38" y1="10" x2="10" y2="38"/>' +
        '</g>';
      loader.appendChild(svg);
      const label = document.createElement('div');
      label.className = 'terminal-loading-label';
      label.textContent = pickLoadingVerb();
      loader.appendChild(label);
      loader._verbTimer = setInterval(() => {
        if (!loader.isConnected) { clearInterval(loader._verbTimer); return; }
        label.textContent = pickLoadingVerb();
      }, 2200);
      t.paneEl.appendChild(loader);
      return;
    }
    if (t.state === 'external') {
      const info = document.createElement('div');
      info.className = 'terminal-external-info';
      info.innerHTML =
        '<div>' + t.tabEl.dataset.agent + ' is running outside Cubilot.</div>' +
        '<div style="font-size:11px; color:var(--text-dim);">Quit the external ' +
        'claude session to launch it inside the pane.</div>';
      t.paneEl.appendChild(info);
    }
  }

  // Eager Fonts.load(): xterm's atlas bakes glyphs at open(), so undecoded fonts give blank cells.
  const fontPreload = (async () => {
    const families = [
      '"CaskaydiaMono Nerd Font"',
      '"JetBrains Mono"',
    ];
    try {
      await Promise.all(families.map(f =>
        document.fonts.load(`12px ${f}`)
      ));
    } catch (e) {
      console.warn('[terminal] font preload failed', e);
    }
    try { await document.fonts.ready; } catch {}
  })();

  async function mountXterm(t) {
    if (t.term) return;
    try { await fontPreload; } catch {}
    try { await document.fonts?.ready; } catch {}
    if (t.term) return;
    for (const child of Array.from(t.paneEl.children)) {
      if (child.classList?.contains('terminal-empty') ||
          child.classList?.contains('terminal-external-info') ||
          child.classList?.contains('terminal-loading')) {
        child.remove();
      }
    }
    const term = new window.Terminal({
      theme: currentXtermTheme(),
      fontFamily: currentXtermFontFamily(),
      fontSize: currentXtermFontSize(),
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(t.paneEl);
    // Re-assigning fontFamily invalidates xterm's glyph atlas so it rebakes with the loaded font.
    const ff = term.options.fontFamily;
    term.options.fontFamily = 'monospace';
    term.options.fontFamily = ff;
    fitAddon.fit();
    // Shift+Enter → `\n` (Ctrl+J) so claude treats it as newline-without-submit, not Enter.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey
          && !e.ctrlKey && !e.metaKey && !e.altKey) {
        ptyWrite(t.tabEl.dataset.agent, strToB64('\n')).catch((err) =>
          console.error('[terminal] shift-enter write', err));
        return false;
      }
      return true;
    });
    term.onData((data) => {
      ptyWrite(t.tabEl.dataset.agent, strToB64(data)).catch((e) =>
        console.error('[terminal] write', e));
    });
    t.term = term;
    t.fitAddon = fitAddon;
    const ro = new ResizeObserver(() => sendResize(t));
    ro.observe(t.paneEl);
    t._ro = ro;
    sendResize(t);
  }

  function sendResize(t) {
    if (!t.term || !t.fitAddon) return;
    t.fitAddon.fit();
    const { cols, rows } = t.term;
    if (cols > 0 && rows > 0) {
      ptyResize(t.tabEl.dataset.agent, cols, rows).catch(() => {});
    }
  }

  function focusTab(agent) {
    for (const [name, t] of tabs) {
      t.tabEl.classList.toggle('active', name === agent);
      t.paneEl.classList.toggle('active', name === agent);
      if (name === agent) t.tabEl.classList.remove('needs-attention');
    }
    activeAgent = agent;
    const t = tabs.get(agent);
    if (t) {
      renderPaneBody(t);
      sendResize(t);
    }
  }

  const attnDecoder = new TextDecoder('utf-8', { fatal: false });

  // Strip ANSI before letters-only normalize, otherwise CSI trailing letters pollute the match.
  const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

  const ATTENTION_MARKER = 'Doyouwantto';
  const ATTN_TAIL_MAX = 2048;

  function maybeFlagAttention(t, agent, chunkBytes) {
    t.attnTail = (t.attnTail || '') + attnDecoder.decode(chunkBytes, { stream: true });
    if (t.attnTail.length > ATTN_TAIL_MAX) {
      t.attnTail = t.attnTail.slice(-ATTN_TAIL_MAX);
    }
    const lettersOnly = t.attnTail
      .replace(ANSI_ESCAPE_RE, '')
      .replace(/[^A-Za-z]/g, '');
    if (lettersOnly.includes(ATTENTION_MARKER)) {
      t.attnTail = '';
      if (activeAgent !== agent) {
        t.tabEl.classList.add('needs-attention');
      }
    }
  }

  async function attachOutputListener(agent) {
    const t = tabs.get(agent);
    if (!t) return;
    try { t.outputUnlisten?.(); } catch {}
    try { t.exitUnlisten?.(); } catch {}
    t.outputUnlisten = await listen(ptyEventName('output', agent), async (e) => {
      const bytes = b64ToBytes(e.payload.b64);
      if (!t._firstByteLogged && t._launchStage) {
        t._firstByteLogged = true;
        t._launchStage(`first PTY byte (${bytes.length}B)`);
      }
      if (!t.term) {
        await mountXterm(t);
        t._launchStage?.('xterm mounted');
      }
      // U+23FA ⏺ → U+25CF ●; Caskaydia lacks ⏺, avoids emoji-font fallback.
      for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] === 0xE2 && bytes[i+1] === 0x8F && bytes[i+2] === 0xBA) {
          bytes[i+1] = 0x97;
          bytes[i+2] = 0x8F;
        }
      }
      t.term?.write(bytes);
      maybeFlagAttention(t, agent, bytes);
      window.CUBILOT_USAGE?.captureBanner(t, agent, bytes);
    });
    t.exitUnlisten = await listen(ptyEventName('exit', agent), () => {
      removeTab(agent);
      reconcile();
    });
  }

  // Indivisible post-spawn sequence: tab marked live → output listener registered
  // → tmux repaint forced AFTER the listener is up → final resize.
  //
  // Order is load-bearing: the geometry-heal MUST follow attachOutputListener,
  // otherwise the initial tmux refresh-client races the listener registration
  // and the spinner hangs until claude emits its next idle byte. This is the
  // cold-start race fixed in v0.10.2 — keeping all four steps in one helper
  // ensures no future call site (handleLaunch, autoAttach, future spawn flows)
  // can drift back to the broken ordering.
  async function _connectLiveTab(agent) {
    setTabState(agent, 'live');
    await attachOutputListener(agent);
    try { await invoke('pty_heal_geometry', { agent }); } catch {}
    const tt = tabs.get(agent);
    if (tt) sendResize(tt);
  }

  // presenceState is { [name]: true } only while the agent's stream is open; a name
  // merely known to the roster (e.g. registered by /send) does not count as joined.
  function hasJoined(presence, agent) {
    return !!presence?.[agent];
  }

  // Fresh launches only: a spawned agent whose bridge never connects (e.g. Claude Code
  // mods not loaded) is otherwise silent. Warn on its tab if it is still not connected.
  function clearJoinWarning(t) {
    if (t.joinWarnTimer) { clearTimeout(t.joinWarnTimer); t.joinWarnTimer = null; }
    if (t.joinWarnBar) { t.joinWarnBar.remove(); t.joinWarnBar = null; }
  }

  function warnIfNotJoined(agent, t) {
    clearJoinWarning(t); // a relaunch starts a fresh countdown and drops the old bar
    t.joinWarnTimer = setTimeout(() => {
      t.joinWarnTimer = null;
      if (tabs.get(agent) !== t) return;
      if (hasJoined(typeof presenceState !== 'undefined' ? presenceState : null, agent)) return;
      const bar = document.createElement('div');
      bar.style.cssText =
        'position:absolute; top:0; left:0; right:0; z-index:5; display:flex; gap:var(--sp-4);' +
        'align-items:flex-start; padding:8px 12px; font-size:12px; color:var(--text);' +
        'background:var(--bg-elev); border-left:3px solid var(--red);';
      const msg = document.createElement('div');
      msg.style.flex = '1';
      msg.textContent =
        `"${agent}" has not joined the room after 20 s. For Claude agents this usually means ` +
        'Claude Code mods did not load \u2014 check "claude --version" (needs 2.1.296+) and the ' +
        "agent's terminal.";
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '\u00d7';
      close.setAttribute('aria-label', 'Dismiss');
      close.style.cssText = 'background:none; border:0; color:var(--text-muted); cursor:pointer; font-size:16px; line-height:1;';
      close.addEventListener('click', () => { bar.remove(); if (t.joinWarnBar === bar) t.joinWarnBar = null; });
      bar.append(msg, close);
      t.paneEl.appendChild(bar);
      t.joinWarnBar = bar;
    }, 20000);
  }

  // Called from roster.js on every presence update: a late join clears the warning.
  window.noteJoinPresence = function noteJoinPresence(presence) {
    for (const [agent, t] of tabs) if (t.joinWarnBar && hasJoined(presence, agent)) clearJoinWarning(t);
  };

  async function handleLaunch(agent, cwd, sessionMode = null, room = null, harness = null, role = null, model = null, effort = null, provider = null) {
    if (!_paneEnabled) setPaneEnabled(true);
    const t0 = performance.now();
    const stage = (label) =>
      console.log(`[launch-timing] +${Math.round(performance.now() - t0)}ms — ${agent} — ${label}`);
    stage('handleLaunch start');
    const t = ensureTab(agent);
    clearJoinWarning(t);
    void clearPauseForLaunch(agent);
    setTabState(agent, 'launching');
    focusTab(agent);
    t._launchT0 = t0;
    t._launchStage = stage;
    try {
      stage('invoke pty_spawn');
      console.info('[terminal] pty_spawn', { agent, role, harness, model, effort, provider, sessionMode, room });
      await ptySpawn(agent, cwd, sessionMode, room, harness, role, model, effort, provider);
      stage('pty_spawn returned');
      rememberCwd(agent, cwd);
      roleMemory.remember(localStorage, agent, role, { model, provider, effort, harness });
      t.cwd = cwd;
      t.external = false;
      await _connectLiveTab(agent);
      stage('tab connected (listener + heal + resize)');
      warnIfNotJoined(agent, t);
    } catch (e) {
      console.error('[terminal] spawn failed:', e);
      alert(`Launch failed: ${e?.message ?? e}`);
      removeTab(agent);
      reconcile();
    }
  }

  async function handleOpenEditor(agent) {
    if (!invoke) return;
    try {
      const cwd = await invoke('open_in_editor', { agent });
      if (typeof window.showCopyToast === 'function') {
        window.showCopyToast(`Editor opened: ${cwd}`);
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.error('[terminal] open_in_editor failed:', msg);
      if (typeof window.showCopyToast === 'function') {
        window.showCopyToast(`Editor failed: ${msg}`);
      } else {
        alert(`Editor failed: ${msg}`);
      }
    }
  }

  async function handleKill(agent) {
    const ok = await askConfirm(
      'Shut down claude session?',
      `Sends /exit to claude and closes the tmux session once claude shuts down cleanly. Scrollback will be lost.`,
    );
    if (!ok) return;

    // No leading Esc: claude swallows `\x1b/` as a key-combo and eats `/e`.
    try {
      await ptyWrite(agent, strToB64('/exit\r'));
    } catch (e) {
      console.error('[terminal] /exit write failed:', e);
    }

    setTimeout(async () => {
      if (!tabs.has(agent)) return;
      console.debug('[terminal] /exit timeout on', agent, '— force-killing');
      try { await ptyKill(agent); } catch (e) {
        console.error('[terminal] force-kill failed:', e);
      }
    }, 10000);
  }

  toggleBtn?.addEventListener('dblclick', () => openSpawnModal());

  function openSpawnModal(prefillAgent = '', prefillCwd = '') {
    spawnAgentEl.value = prefillAgent;
    spawnCwdEl.value = prefillCwd;
    if (spawnRoomEl) spawnRoomEl.value = '';
    refreshSpawnRoomDatalist();
    if (spawnSessionContinue) spawnSessionContinue.checked = false;
    if (spawnSessionResume)   spawnSessionResume.checked = false;
    gridModels = {};   // the model lists (and Pi sign-in marks) are read again each time the modal opens
    gridSelected = null;
    if (spawnGridFilterEl) spawnGridFilterEl.value = '';
    if (spawnRoleErrEl) { spawnRoleErrEl.textContent = ''; spawnRoleErrEl.hidden = true; }
    if (spawnRoleEl) spawnRoleEl.value = '';   // every opening starts at None; refreshSpawnRoles keeps only a pick made during its wait
    roleList?.sync();
    refreshSpawnRoles();
    spawnModal.classList.add('open');
    setTimeout(() => spawnAgentEl.focus(), 0);
  }

  // Roles come from the staged version; "None" stays first and is the default, so a launch without a role is unchanged.
  let spawnOpening = 0;   // counts openings of the modal: a list_roles answer of an earlier opening is dropped
  async function refreshSpawnRoles() {
    if (!spawnRoleEl) return;
    const opening = ++spawnOpening;
    let roles;
    try {
      roles = await listRoles();
    } catch (e) {
      if (opening !== spawnOpening) return;
      // An error is not "no roles": keep the options and the role the human picked, and say so in the window.
      console.warn('[terminal] list_roles failed:', e);
      if (spawnRoleErrEl) { spawnRoleErrEl.textContent = `Could not read the roles: ${e?.message ?? e}. The role list is not refreshed.`; spawnRoleErrEl.hidden = false; }
      return;
    }
    if (opening !== spawnOpening) return;
    if (spawnRoleErrEl) { spawnRoleErrEl.textContent = ''; spawnRoleErrEl.hidden = true; }
    const keep = spawnRoleEl.value;   // a role picked while list_roles ran (the options of the last opening are still there)
    console.info('[terminal] refreshSpawnRoles', { opening, keep, roles: roles.length });   // t_41e14dde706805e3 trace
    spawnRoles = new Map(roles.map((r) => [r.name, r]));
    spawnRoleEl.innerHTML = '';
    spawnRoleEl.add(new Option('None', ''));
    for (const r of roles) {
      spawnRoleEl.add(new Option(r.name, r.name));
    }
    if (keep && !spawnRoles.has(keep)) {
      // The pick is not in the answer (a list read while the version was being staged). Never turn a pick into None
      // in silence: keep it, say so, and let the launch guard refuse it ("not in the role list").
      spawnRoleEl.add(new Option(keep, keep));
      if (spawnRoleErrEl) { spawnRoleErrEl.textContent = `The role "${keep}" is not in the staged role list. Pick a role again or reopen this window.`; spawnRoleErrEl.hidden = false; }
    }
    spawnRoleEl.value = keep;
    roleList?.sync();
    await onSpawnRoleChange();
    if (!spawnRoleEl.value) await recallSpawnRole();   // a role the human picked is not overridden by the memory
  }

  // The last role and grid choice used for this agent name, if the role is still staged and its model is still
  // listed. Runs when the modal opens and when the name field is committed (change), never per keystroke, so it
  // does not undo a manual pick.
  async function recallSpawnRole() {
    const m = roleMemory.recall(localStorage, spawnAgentEl.value.trim());
    if (!m || !spawnRoles.has(m.role)) return;
    spawnRoleEl.value = m.role;
    roleList?.sync();
    if (m.harness && spawnHarnessClaude && spawnHarnessPi) {
      spawnHarnessClaude.checked = m.harness !== 'pi';
      spawnHarnessPi.checked = m.harness === 'pi';
    }
    await onSpawnRoleChange(!!m.harness);
    const sel = modelGrid.selectionFromChoice(buildSpawnGrid(), m);
    if (sel) { gridSelected = sel; renderSpawnGrid(); }
  }
  // A remembered role fills an empty choice only; a role the human picked is never replaced by the name's memory.
  function onSpawnNameCommit() { if (!spawnRoleEl?.value) return recallSpawnRole(); }
  spawnAgentEl?.addEventListener('change', onSpawnNameCommit);

  // The role the window shows (button label) and the role the launch sends (select value) must be the same, and a
  // sent role must be a staged one. Else the launch is refused: a launch must never differ from what the human sees.
  function spawnRoleMismatch() {
    const value = spawnRoleEl?.value || '';
    const shown = roleList ? roleList.shown() : (value || 'None');
    if (shown !== (value || 'None')) return `the window shows "${shown}" but the role is "${value || 'None'}"`;
    if (value && !spawnRoles.has(value)) return `role "${value}" is not in the role list`;
    return '';
  }

  // ---- The model x effort grid (task 5.5): it replaces the model field of 5.2. ----
  let gridModels = {};      // harness -> rows from list_models, for this opening of the modal
  let gridSelected = null;  // { rowKey, effort }
  const spawnRole = () => spawnRoles.get(spawnRoleEl?.value || '') || null;
  // The radios decide the launch harness; a role only preselects it (task 9.5).
  const spawnGridHarness = () => (spawnHarnessPi?.checked ? 'pi' : 'claude');

  function buildSpawnGrid() {
    const harness = spawnGridHarness();
    return modelGrid.gridModel({ harness, models: gridModels[harness] || [], filter: spawnGridFilterEl?.value || '', role: spawnRole() });
  }

  async function loadGridModels(harness) {
    if (gridModels[harness]) return;
    if (spawnGridNoteEl) spawnGridNoteEl.textContent = harness === 'pi' ? 'Loading Pi models and sign-in state…' : '';
    try {
      gridModels[harness] = await listModels(harness);
    } catch (e) {
      console.warn('[terminal] list_models failed:', e);
      gridModels[harness] = [];
      if (spawnGridNoteEl) spawnGridNoteEl.textContent = `Could not list ${harness} models: ${e?.message ?? e}`;
      return;
    }
    if (spawnGridNoteEl) spawnGridNoteEl.textContent = '';
  }

  function renderSpawnGrid() {
    if (!spawnGridEl) return;
    const grid = buildSpawnGrid();
    if (spawnSubmit) spawnSubmit.disabled = !modelGrid.launchReady(grid, gridSelected, spawnRole());
    const isPi = grid.harness === 'pi';
    if (spawnGridFilterEl) spawnGridFilterEl.hidden = !isPi;
    if (spawnGridCountEl) spawnGridCountEl.textContent = isPi ? `${grid.count.shown}/${grid.count.total}` : '';
    const cols = `minmax(130px, 1.8fr) repeat(${grid.columns.length}, minmax(28px, 1fr))`;
    spawnGridEl.textContent = '';
    const head = document.createElement('div');
    head.className = 'grid-head';
    head.style.gridTemplateColumns = cols;
    head.append(document.createElement('span'));
    for (const c of grid.columns) { const h = document.createElement('span'); h.textContent = c; head.append(h); }
    spawnGridEl.append(head);
    if (!grid.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'grid-empty';
      empty.textContent = grid.count.total ? 'No model matches the filter.' : 'No models.';
      spawnGridEl.append(empty);
    }
    for (const r of grid.rows) {
      const row = document.createElement('div');
      row.className = 'grid-row';
      row.style.gridTemplateColumns = cols;
      const label = document.createElement('span');
      label.className = 'row-label' + (r.ready ? '' : ' not-ready') + (grid.defaultCell?.rowKey === r.key ? ' default' : '');
      label.textContent = r.label;
      label.title = r.ready ? r.label : `${r.label}: not signed in. A launch with it stops with a sign-in message.`;
      row.append(label);
      for (const c of grid.columns) {
        const b = document.createElement('button');
        b.type = 'button';
        const isDefault = grid.defaultCell && grid.defaultCell.rowKey === r.key && grid.defaultCell.effort === c;
        const isSel = gridSelected && gridSelected.rowKey === r.key && gridSelected.effort === c;
        b.className = 'cell' + (isDefault ? ' default' : '') + (isSel ? ' selected' : '');
        b.dataset.row = r.key;
        b.dataset.effort = c;
        b.setAttribute('aria-pressed', isSel ? 'true' : 'false');
        b.title = `${r.label}, ${c}${isDefault ? ' (role default)' : ''}`;
        row.append(b);
      }
      spawnGridEl.append(row);
    }
    // A selected row of a provider that is not signed in: say what will happen.
    const sel = gridSelected && grid.all.find((r) => r.key === gridSelected.rowKey);
    if (spawnGridNoteEl && gridModels[grid.harness]) {
      spawnGridNoteEl.textContent = sel && !sel.ready ? `${sel.provider} is not signed in: this launch will stop with a sign-in message.` : '';
    }
  }

  spawnGridEl?.addEventListener('click', (e) => {
    const b = e.target.closest?.('.cell');
    if (!b) return;
    const same = gridSelected && gridSelected.rowKey === b.dataset.row && gridSelected.effort === b.dataset.effort;
    gridSelected = same ? null : { rowKey: b.dataset.row, effort: b.dataset.effort };   // a second click clears it
    renderSpawnGrid();
  });
  spawnGridFilterEl?.addEventListener('input', renderSpawnGrid);

  // Role or harness changed: the rows and columns change, the selection becomes the role's default cell.
  async function refreshSpawnGrid() {
    const harness = spawnGridHarness();
    renderSpawnGrid();
    await loadGridModels(harness);
    if (spawnGridHarness() !== harness) return;   // changed again while loading
    gridSelected = modelGrid.initialSelection(buildSpawnGrid());
    renderSpawnGrid();
  }

  // A role preselects its harness in the radios (unless keepHarness: a recalled choice already set them). The radios
  // stay free: the other harness runs the role with no default model, so the grid asks for a cell.
  async function onSpawnRoleChange(keepHarness = false) {
    const r = spawnRole();
    if (r && !keepHarness) {
      if (spawnHarnessClaude) spawnHarnessClaude.checked = r.harness !== 'pi';
      if (spawnHarnessPi) spawnHarnessPi.checked = r.harness === 'pi';
    }
    gridSelected = null;
    await refreshSpawnGrid();
  }
  spawnRoleEl?.addEventListener('change', () => onSpawnRoleChange());
  spawnHarnessClaude?.addEventListener('change', () => { gridSelected = null; refreshSpawnGrid(); });
  spawnHarnessPi?.addEventListener('change', () => { gridSelected = null; refreshSpawnGrid(); });

  // What the launch sends: only the parts of the chosen cell that differ from the role default, or nothing.
  const spawnGridChoice = () => modelGrid.choiceFromSelection(buildSpawnGrid(), gridSelected);

  function refreshSpawnRoomDatalist() {
    if (!spawnRoomMenu) return;
    spawnRoomMenu.innerHTML = '';
    const rooms = new Set();
    if (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER)) {
      for (const a of ROSTER) {
        if (a && typeof a.room === 'string' && a.room) rooms.add(a.room);
      }
    }
    const sorted = [...rooms].sort();
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'spawn-room-option empty';
      empty.textContent = 'No rooms yet — type a new name.';
      spawnRoomMenu.appendChild(empty);
      return;
    }
    for (const r of sorted) {
      const opt = document.createElement('div');
      opt.className = 'spawn-room-option';
      opt.dataset.value = r;
      opt.role = 'option';
      opt.textContent = `# ${r}`;
      opt.addEventListener('click', () => {
        if (spawnRoomEl) spawnRoomEl.value = r;
        closeSpawnRoomMenu();
        spawnRoomEl?.focus();
      });
      spawnRoomMenu.appendChild(opt);
    }
  }
  function openSpawnRoomMenu() {
    if (!spawnRoomMenu || !spawnRoomBtn) return;
    refreshSpawnRoomDatalist();
    spawnRoomMenu.classList.add('open');
    spawnRoomBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSpawnRoomMenu() {
    if (!spawnRoomMenu || !spawnRoomBtn) return;
    spawnRoomMenu.classList.remove('open');
    spawnRoomBtn.setAttribute('aria-expanded', 'false');
  }
  spawnRoomBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (spawnRoomMenu?.classList.contains('open')) closeSpawnRoomMenu();
    else openSpawnRoomMenu();
  });
  document.addEventListener('click', (e) => {
    if (!spawnRoomMenu?.classList.contains('open')) return;
    if (!spawnRoomMenu.contains(e.target) && e.target !== spawnRoomBtn
        && !spawnRoomBtn?.contains(e.target)) closeSpawnRoomMenu();
  });
  document.addEventListener('cubilot:open-spawn', () => openSpawnModal());

  // Refocus on room change: tab `display:none` hides chrome but pane stays visible.
  document.addEventListener('cubilot:room-filter', (e) => {
    const filterRoom = e?.detail?.room ?? null;
    const visible = (agentName) => {
      const t = tabs.get(agentName);
      if (!t) return false;
      if (filterRoom === null) return true;
      const r = t.tabEl.dataset.room;
      return !r || r === filterRoom;
    };
    if (activeAgent && visible(activeAgent)) return;
    // Preference: needs-attention > live > any in-room > shell (shell matches every filter).
    const candidates = [...tabs.keys()].filter((n) => !isShell(n) && visible(n));
    const pick =
      candidates.find((n) => tabs.get(n).tabEl.classList.contains('needs-attention')) ||
      candidates.find((n) => tabs.get(n).state === 'live') ||
      candidates[0] ||
      [...tabs.keys()].find((n) => visible(n));
    if (pick) { focusTab(pick); return; }
    // No visible tabs: clear active so the empty-state renders instead of a stale pane.
    if (activeAgent) {
      const prev = tabs.get(activeAgent);
      if (prev) prev.paneEl.classList.remove('active');
      activeAgent = null;
    }
  });
  function closeSpawnModal() { spawnModal.classList.remove('open'); }
  spawnCancel?.addEventListener('click', closeSpawnModal);
  spawnModal?.addEventListener('click', (e) => {
    if (e.target === spawnModal) closeSpawnModal();
  });
  spawnCwdPick?.addEventListener('click', async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    spawnCwdEl.value = dir;
    // Pre-fill Room with git-root basename for one-click common case.
    if (spawnRoomEl && !spawnRoomEl.value.trim()) {
      try {
        const suggested = await invoke('resolve_default_room', { cwd: dir });
        if (typeof suggested === 'string' && suggested) {
          spawnRoomEl.value = suggested;
        }
      } catch (e) {
        console.warn('[terminal] resolve_default_room failed:', e);
      }
    }
  });

  spawnSubmit?.addEventListener('click', async () => {
    const agent = spawnAgentEl.value.trim();
    const cwd = spawnCwdEl.value.trim();
    const room = (spawnRoomEl?.value ?? '').trim();
    if (!NAME_RE.test(agent)) {
      alert('Invalid agent name (letters, digits, _.-, spaces in the middle).');
      return;
    }
    if (factoryRoom.terminalNameError(agent)) { alert(`Agent name: ${factoryRoom.terminalNameError(agent)}.`); return; }
    if (!cwd) { alert('Pick a working directory.'); return; }
    if (room && !NAME_RE.test(room)) {
      alert('Invalid room label (same charset as agent names). Leave blank to auto-detect from cwd.');
      return;
    }
    let sessionMode = null;
    if (spawnSessionContinue?.checked) sessionMode = 'continue';
    else if (spawnSessionResume?.checked) sessionMode = 'resume';
    const harness = spawnHarnessPi?.checked ? 'pi' : 'claude';
    console.info('[terminal] launch click', { agent, value: spawnRoleEl?.value || '', shown: roleList?.shown?.() });
    const mismatch = spawnRoleMismatch();
    if (mismatch) { alert(`Launch refused: ${mismatch}. Pick the role again.`); return; }
    closeSpawnModal();
    const choice = spawnGridChoice();
    await handleLaunch(agent, cwd, sessionMode, room || null, harness, spawnRoleEl?.value || null, choice?.model || null, choice?.effort || null, choice?.provider || null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && spawnModal.classList.contains('open')) closeSpawnModal();
  });

  // ---- New factory room (tasks 6.1, 6.4): one orchestrator in a new room; the limits go to the room settings. ----
  const frModal   = document.getElementById('factory-room-modal');
  const frName    = document.getElementById('factory-room-name');
  const frCwd     = document.getElementById('factory-room-cwd');
  const frWorkers = document.getElementById('factory-room-workers');
  const frTesters = document.getElementById('factory-room-testers');
  const closeFactoryRoom = () => frModal?.classList.remove('open');

  // The harness radios and the model x effort grid (task 9.6): the same rules as the spawn modal, for the one role
  // this window launches. The default is the orchestrator role's own harness and model.
  const frHarnessClaude = document.getElementById('factory-room-harness-claude');
  const frHarnessPi     = document.getElementById('factory-room-harness-pi');
  const frGridEl        = document.getElementById('factory-room-grid');
  const frFilterEl      = document.getElementById('factory-room-grid-filter');
  const frCountEl       = document.getElementById('factory-room-grid-count');
  const frNoteEl        = document.getElementById('factory-room-grid-note');
  const frSubmit        = document.getElementById('factory-room-submit');
  let frRole = null;       // the orchestrator role from list_roles, or null when none is staged
  let frModels = {};       // harness -> rows from list_models, for this opening of the window
  let frSelected = null;   // { rowKey, effort }
  const frHarness = () => (frHarnessPi?.checked ? 'pi' : 'claude');
  const frBuildGrid = () => modelGrid.gridModel({
    harness: frHarness(), models: frModels[frHarness()] || [], filter: frFilterEl?.value || '', role: frRole,
  });
  function frRender() {
    if (!frGridEl) return;
    const grid = frBuildGrid();
    gridView.renderGrid({ doc: document, gridEl: frGridEl, filterEl: frFilterEl, countEl: frCountEl, grid, selected: frSelected });
    if (frSubmit) frSubmit.disabled = !modelGrid.launchReady(grid, frSelected, frRole);
    const sel = frSelected && grid.all.find((r) => r.key === frSelected.rowKey);
    if (frNoteEl && frModels[grid.harness] && sel && !sel.ready) {
      frNoteEl.textContent = `${sel.provider} is not signed in: this launch will stop with a sign-in message.`;
    } else if (frNoteEl && frModels[grid.harness]) {
      frNoteEl.textContent = '';
    }
  }
  async function frRefresh() {
    const harness = frHarness();
    frRender();
    if (!frModels[harness]) {
      if (frNoteEl) frNoteEl.textContent = harness === 'pi' ? 'Loading Pi models and sign-in state…' : '';
      try {
        frModels[harness] = await listModels(harness);
      } catch (e) {
        console.warn('[terminal] list_models failed:', e);
        frModels[harness] = [];
        if (frNoteEl) frNoteEl.textContent = `Could not list ${harness} models: ${e?.message ?? e}`;
      }
    }
    if (frHarness() !== harness) return;   // changed again while loading
    frSelected = modelGrid.initialSelection(frBuildGrid());
    frRender();
  }
  frGridEl?.addEventListener('click', (e) => {
    const b = e.target.closest?.('.cell');
    if (!b) return;
    const same = frSelected && frSelected.rowKey === b.dataset.row && frSelected.effort === b.dataset.effort;
    frSelected = same ? null : { rowKey: b.dataset.row, effort: b.dataset.effort };   // a second click clears it
    frRender();
  });
  frFilterEl?.addEventListener('input', frRender);
  for (const el of [frHarnessClaude, frHarnessPi]) el?.addEventListener('change', () => { frSelected = null; frRefresh(); });
  // Task 6.3: seed the room's Nutshell BEFORE the orchestrator starts, so its first briefing has it. Only when the
  // room has none. A failure is shown and does not stop the launch (the Nutshell can be written later).
  async function seedFactoryNutshell(room, cwd) {
    try {
      const cur = await authedFetch(`/nutshell?room=${encodeURIComponent(room)}`);
      if (!cur.ok) throw new Error(`read nutshell: ${cur.status}`);
      const req = factoryRoom.nutshellSeedRequests(room, cwd, HUMAN_NAME, (await cur.json())?.text);
      if (!req) return;   // the room already has a Nutshell: leave it
      const made = await authedFetch('/handoffs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.create),
      });
      if (!made.ok) throw new Error(`create: ${made.status}`);
      const { id } = await made.json();
      const a = req.accept(id);
      const done = await authedFetch(`/handoffs/${encodeURIComponent(a.id)}/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.body),
      });
      if (!done.ok) throw new Error(`accept: ${done.status}`);
    } catch (e) {
      alert(`The Nutshell for #${room} was not seeded (${e?.message ?? e}). The orchestrator still starts.`);
    }
  }
  document.getElementById('factory-room-btn')?.addEventListener('click', () => {
    if (frName) frName.value = '';
    if (frCwd) frCwd.value = '';
    frModal?.classList.add('open');
    setTimeout(() => frName?.focus(), 0);
    frModels = {};   // the model lists (and Pi sign-in marks) are read again each time the window opens
    frSelected = null;
    if (frFilterEl) frFilterEl.value = '';
    listRoles().then((roles) => {
      frRole = roles.find((r) => r.name === 'orchestrator') || null;
      if (frHarnessClaude) frHarnessClaude.checked = frRole?.harness !== 'pi';
      if (frHarnessPi) frHarnessPi.checked = frRole?.harness === 'pi';
      return frRefresh();
    }).catch((e) => console.warn('[terminal] list_roles failed:', e));
  });
  document.getElementById('factory-room-cancel')?.addEventListener('click', closeFactoryRoom);
  frModal?.addEventListener('click', (e) => { if (e.target === frModal) closeFactoryRoom(); });
  document.getElementById('factory-room-pick')?.addEventListener('click', async () => {
    const dir = await pickDirectory();
    if (dir && frCwd) frCwd.value = dir;
  });
  document.getElementById('factory-room-submit')?.addEventListener('click', async () => {
    const names = (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER)) ? ROSTER.map(a => a.name) : [];
    const r = factoryRoom.buildFactoryRoom(
      {
        room: frName?.value, cwd: frCwd?.value, workers: frWorkers?.value, testers: frTesters?.value,
        harness: frHarness(), choice: modelGrid.choiceFromSelection(frBuildGrid(), frSelected), roleHarness: frRole?.harness,
      },
      names,
    );
    if (r.error) { alert(r.error); return; }
    const l = r.launch;
    // Store the limits in the room settings first (6.4); if that fails nothing is launched and the form stays open.
    try {
      const res = await authedFetch(`/rooms/${encodeURIComponent(l.room)}/settings`, {
        method: 'PUT',
        // The project folder is where the hub makes the worktrees of the stage sessions (stage-sessions 4.5).
        body: JSON.stringify({ worker_limit: r.limits.workers, tester_limit: r.limits.testers, project_folder: l.cwd }),
      });
      if (!res.ok) {
        const detail = await res.json().then((j) => j.error, () => null);
        throw new Error(detail || `hub answered ${res.status}`);
      }
    } catch (e) {
      alert(`Could not store the room settings: ${e?.message ?? e}`);
      return;
    }
    closeFactoryRoom();
    await seedFactoryNutshell(l.room, l.cwd);
    // Same call as the spawn modal makes: the chosen harness, and only the parts of the grid cell that differ from the role.
    await handleLaunch(l.agent, l.cwd, null, l.room, l.harness, l.role, l.model, l.effort, l.provider);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && frModal?.classList.contains('open')) closeFactoryRoom();
  });

  async function reconcile() {
    ensureShellTab();   // the Shell row shows in the column in every view
    const rosterNames = (typeof ROSTER !== 'undefined' && Array.isArray(ROSTER))
      ? ROSTER.map(a => a.name).filter(n => n !== (typeof HUMAN_NAME !== 'undefined' ? HUMAN_NAME : 'you'))
      : [];
    const sessionNames = await ptyList();
    const want = new Set([...rosterNames, ...sessionNames]);

    for (const [name, t] of Array.from(tabs)) {
      if (isShell(name)) continue;
      if (!want.has(name) && t.state !== 'live' && t.state !== 'launching') {
        removeTab(name);
      }
    }

    for (const name of want) {
      if (!tabs.has(name)) {
        ensureTab(name);
        setTabState(name, 'external');
      }
      // Refresh room attr from roster; handles race where tab is created before roster has the room.
      const tab = tabs.get(name);
      if (tab && typeof ROSTER !== 'undefined' && Array.isArray(ROSTER)) {
        const ra = ROSTER.find((x) => x && x.name === name);
        if (ra && typeof ra.room === 'string' && ra.room) {
          tab.tabEl.dataset.room = ra.room;
        }
        if (ra?.color) tab.tabEl.style.setProperty('--agent-color', ra.color);
      }
    }

    for (const name of sessionNames) {
      const t = tabs.get(name);
      if (!t) continue;
      if (t.state === 'live' || t.state === 'launching') continue;
      const cwd = cwdCache[name] || (window.__TAURI__ ? '' : '');
      autoAttach(name, cwd).catch((e) =>
        console.warn('[terminal] auto-attach failed for', name, e));
    }

    if (!activeAgent && tabs.size) {
      focusTab(tabs.keys().next().value);
    }
  }

  async function autoAttach(agent, cwd) {
    const t = tabs.get(agent);
    if (!t) return;
    if (t.state === 'live' || t.state === 'launching') return;
    // pty_spawn creates a missing session, and without a role. List right before it and re-attach only a session
    // that exists now. The state stays as it is until then, so a launch that starts during the listing is not touched.
    if (!(await ptyList()).includes(agent)) return;
    if (tabs.get(agent) !== t || t.state === 'live' || t.state === 'launching') return;
    setTabState(agent, 'launching');
    try {
      const effectiveCwd = cwd || '/tmp';
      await ptySpawn(agent, effectiveCwd, null, null, null, null, null, null, null, true);
      await _connectLiveTab(agent);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('already attached')) {
        // The shell already attached this session (a hub stage launch). Mark it live AND listen: without the exit and
        // output listeners the tab never learns that the session ended, and reconcile() keeps live tabs for ever.
        // A tab that already listens (a normal agent after a window reload, say) must not get a second listener pair.
        if (t.outputUnlisten && t.exitUnlisten) {
          setTabState(agent, 'live');
        } else {
          try {
            await _connectLiveTab(agent);
          } catch (e2) {
            console.warn('[terminal] autoAttach (already attached)', agent, e2);
            setTabState(agent, 'live');
          }
        }
      } else if (msg.includes('session not found')) {
        setTabState(agent, 'external');   // the session ended while we attached: nothing was created
      } else {
        console.warn('[terminal] autoAttach', agent, e);
        setTabState(agent, 'external');
      }
    }
  }

  setInterval(() => { if (paneEnabled()) reconcile(); }, 5000);
  setTimeout(reconcile, 500);

  (async () => {
    try {
      const names = await ptyList();
      // pty_list filters out shell, so check separately.
      let shellLive = false;
      try { shellLive = await invoke('pty_shell_exists'); } catch {}
      if ((names.length || shellLive) && !_paneEnabled) {
        setPaneEnabled(true);
        reconcile();
        for (const t of tabs.values()) if (t.term) t.fitAddon?.fit();
      }
      if (_paneEnabled) ensureShellAttached();
    } catch (e) {}
  })();

  // Read-only accessor for slash-send's response capture: returns Terminal or null.
  window.__CUBILOT_TERM__.getTerm = (agent) => {
    const tab = tabs.get(agent);
    return tab?.term || null;
  };
})();
