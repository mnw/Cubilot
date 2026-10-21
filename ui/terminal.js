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
  const bodyEl        = document.getElementById('terminal-body');
  const spawnModal    = document.getElementById('spawn-modal');
  const spawnAgentEl  = document.getElementById('spawn-agent-input');
  const spawnCwdEl    = document.getElementById('spawn-cwd-input');
  const spawnCwdPick  = document.getElementById('spawn-cwd-pick');
  const spawnHarnessPi = document.getElementById('spawn-harness-pi');
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
    document.dispatchEvent(new CustomEvent('a2a:right-pane', { detail: { pane: on ? 'terminal' : null } }));
  }
  function applySplit() {
    const raw = localStorage.getItem(SPLIT_KEY);
    const pct = raw ? Number(raw) : 50;
    const clamped = Math.max(25, Math.min(75, Number.isFinite(pct) ? pct : 50));
    appBody.style.setProperty('--split', clamped + '%');
  }
  applyPaneClass();
  applySplit();

  // The right pane shows the board or the terminal, never both (see a2a:right-pane in ticket.js).
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
  document.addEventListener('a2a:right-pane', onRightPane);

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
    const chatWidth = e.clientX - rect.left;
    const rawPct = (chatWidth / rect.width) * 100;
    const clamped = Math.max(25, Math.min(75, rawPct));
    appBody.style.setProperty('--split', clamped + '%');
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

  const {
    ptySpawn, ptyWrite, ptyResize, ptyKill, ptyList,
    strToB64, b64ToBytes,
  } = window.__A2A_TERM__.pty;

  const currentXtermTheme = window.__A2A_TERM__.xtermThemes.current;
  const currentXtermFontSize = window.__A2A_TERM__.xtermThemes.fontSize;
  const currentXtermFontFamily = window.__A2A_TERM__.xtermThemes.fontFamily;
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
  document.addEventListener('a2a:theme-changed', applyXtermThemeToAll);

  // Mirrors Rust SHELL_SESSION_NAME; never filtered by room, never closed from UI.
  const SHELL_NAME = 'shell';
  function isShell(agent) { return agent === SHELL_NAME; }

  function ensureAgentsHeading() {
    if (tabsEl.querySelector('.terminal-tabs-heading')) return;
    const h = document.createElement('div');
    h.className = 'terminal-tabs-heading';
    h.setAttribute('aria-hidden', 'true');
    h.innerHTML = '<span>agents</span>';
    h.title = 'Agent tabs below. Launch a new one with the + button — don\'t start claude from the shell tab.';
    const shellEl = tabsEl.querySelector('.terminal-tab-shell');
    if (shellEl && shellEl.nextSibling) {
      tabsEl.insertBefore(h, shellEl.nextSibling);
    } else {
      tabsEl.appendChild(h);
    }
  }

  function ensureShellTab() {
    let t = tabs.get(SHELL_NAME);
    if (t) { ensureAgentsHeading(); return t; }
    const tabEl = document.createElement('div');
    tabEl.className = 'terminal-tab terminal-tab-shell';
    tabEl.dataset.agent = SHELL_NAME;
    tabEl.dataset.state = 'external';
    // No data-room: shell is cross-room and survives every filter.
    tabEl.innerHTML =
      '<span class="state-dot"></span>' +
      '<svg viewBox="0 0 24 24" class="tab-icon" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' +
      '<span class="tab-label"></span>';
    tabEl.querySelector('.tab-label').textContent = 'shell';
    tabEl.title = 'Your scratch shell — cross-room, cross-project';
    tabEl.addEventListener('click', () => focusTab(SHELL_NAME));
    tabsEl.insertBefore(tabEl, tabsEl.firstChild);

    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.agent = SHELL_NAME;
    bodyEl.appendChild(paneEl);

    t = { state: 'external', tabEl, paneEl, term: null, fitAddon: null,
          outputUnlisten: null, exitUnlisten: null, cwd: null, external: true };
    tabs.set(SHELL_NAME, t);
    ensureAgentsHeading();
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
    }
    tabEl.innerHTML =
      '<span class="state-dot"></span>' +
      '<span class="tab-label"></span>' +
      '<button type="button" class="pause-toggle"></button>' +
      '<span class="open-editor" title="Open editor at this agent\'s cwd">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
          '<line x1="3" y1="9" x2="21" y2="9"/>' +
          '<line x1="7" y1="13" x2="11" y2="13"/>' +
          '<line x1="13" y1="13" x2="17" y2="13"/>' +
          '<line x1="7" y1="17" x2="14" y2="17"/>' +
        '</svg>' +
      '</span>' +
      '<span class="close-x" title="Kill session">×</span>';
    tabEl.querySelector('.tab-label').textContent = agent;
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.close-x') || e.target.closest('.open-editor')
          || e.target.closest('.pause-toggle')) return;
      focusTab(agent);
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
    tabsEl.insertBefore(tabEl, tabsEl.querySelector('.terminal-tab-new'));

    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.agent = agent;
    bodyEl.appendChild(paneEl);

    t = { state: 'external', tabEl, paneEl, term: null, fitAddon: null,
          outputUnlisten: null, exitUnlisten: null, cwd: cwdCache[agent] || null, external: true };
    tabs.set(agent, t);
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
        '<div>' + t.tabEl.dataset.agent + ' is running outside A2AChannel.</div>' +
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
    t.outputUnlisten = await listen(`pty://output/${agent}`, async (e) => {
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
      window.A2A_USAGE?.captureBanner(t, agent, bytes);
    });
    t.exitUnlisten = await listen(`pty://exit/${agent}`, () => {
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

  async function handleLaunch(agent, cwd, sessionMode = null, room = null, harness = null) {
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
      await ptySpawn(agent, cwd, sessionMode, room, harness);
      stage('pty_spawn returned');
      rememberCwd(agent, cwd);
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
    spawnModal.classList.add('open');
    setTimeout(() => spawnAgentEl.focus(), 0);
  }

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
  document.addEventListener('a2a:open-spawn', () => openSpawnModal());

  // Refocus on room change: tab `display:none` hides chrome but pane stays visible.
  document.addEventListener('a2a:room-filter', (e) => {
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
    if (!cwd) { alert('Pick a working directory.'); return; }
    if (room && !NAME_RE.test(room)) {
      alert('Invalid room label (same charset as agent names). Leave blank to auto-detect from cwd.');
      return;
    }
    let sessionMode = null;
    if (spawnSessionContinue?.checked) sessionMode = 'continue';
    else if (spawnSessionResume?.checked) sessionMode = 'resume';
    const harness = spawnHarnessPi?.checked ? 'pi' : 'claude';
    closeSpawnModal();
    await handleLaunch(agent, cwd, sessionMode, room || null, harness);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && spawnModal.classList.contains('open')) closeSpawnModal();
  });

  async function reconcile() {
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

    let addBtn = tabsEl.querySelector('.terminal-tab-new');
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'terminal-tab-new';
      addBtn.title = 'Launch a new agent session';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => openSpawnModal());
      tabsEl.appendChild(addBtn);
    }

    if (!activeAgent && tabs.size) {
      focusTab(tabs.keys().next().value);
    }
  }

  async function autoAttach(agent, cwd) {
    const t = tabs.get(agent);
    if (!t) return;
    if (t.state === 'live' || t.state === 'launching') return;
    setTabState(agent, 'launching');
    try {
      const effectiveCwd = cwd || '/tmp';
      await ptySpawn(agent, effectiveCwd);
      await _connectLiveTab(agent);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('already attached')) {
        setTabState(agent, 'live');
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

  const legend = document.getElementById('legend');
  if (legend) {
    new MutationObserver(() => { if (paneEnabled()) reconcile(); })
      .observe(legend, { childList: true });
  }

  // Read-only accessor for slash-send's response capture: returns Terminal or null.
  window.__A2A_TERM__.getTerm = (agent) => {
    const tab = tabs.get(agent);
    return tab?.term || null;
  };
})();
