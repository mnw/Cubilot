// terminal/pty.js — Tauri spawn/kill wrappers, the hub's terminal WebSocket and routes, base64 helpers; standalone.

(function () {
  function _invoke() {
    return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  }

  async function ptySpawn(agent, cwd, sessionMode, room, harness, role, model, effort, provider, attachOnly) {
    const args = { agent, cwd };
    if (sessionMode === 'resume' || sessionMode === 'continue') {
      args.sessionMode = sessionMode;
    }
    if (room) args.room = room;
    // Omitted → Rust defaults to claude, so existing call sites keep working.
    if (harness) args.harness = harness;
    // Omitted → no role, and the command is the same as before.
    if (role) args.role = role;
    // Only sent when the user changed the role's default model; then it applies to this launch only.
    if (model) args.model = model;
    // The grid choice (5.5): only what differs from the role default. effort is --effort (Claude) or --thinking (Pi).
    if (effort) args.effort = effort;
    if (provider) args.provider = provider;
    // Attach to a live session only; Rust answers "session not found" instead of creating one (and without a role).
    if (attachOnly) args.attachOnly = true;
    return _invoke()('pty_spawn', args);
  }
  // Rows of the model x effort grid. Pi: every model of `pi --list-models` with whether its provider is signed in.
  async function listModels(harness) {
    const body = await hubGet(`/models?harness=${encodeURIComponent(harness)}`);
    // Pi that does not answer gives an empty list and a warning: reject, so the form shows the reason.
    if (body.warning) throw new Error(body.warning);
    return body.models;
  }
  // Rejects when the command fails: a caller must not read an error as "no roles" (that cleared a picked role).
  async function listRoles() {
    return (await hubGet('/roles')).roles;
  }
  async function ptyKill(agent) {
    return _invoke()('pty_kill', { agent });
  }
  // The live tmux sessions, by agent name (the hub lists them; no Tauri needed). A failed read gives [].
  async function ptyList() {
    try {
      const r = await window.authedFetch('/terminal-sessions');
      if (!r.ok) return [];
      const body = await r.json();
      return Array.isArray(body.sessions) ? body.sessions : [];
    } catch { return []; }
  }
  // The hub runs these (hub/features/terminal.ts); the webview calls its routes, not the shell.
  async function _terminal(path, init) {
    const r = await window.authedFetch(path, init);
    if (!r.ok) throw new Error(await parseErrorBody(r));
    return r;
  }
  const _agentPath = (agent) => `/terminal/${encodeURIComponent(agent)}`;
  // status ∈ { "alt-exit" | "idle-prompt" | "quiescence" | "timeout" }. Resolves to {name, log_path, start_ms, end_ms, status}.
  async function ptyCaptureTurn(agent, input, timeoutMs) {
    const r = await _terminal(`${_agentPath(agent)}/capture-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, timeout_ms: timeoutMs ?? undefined }),
    });
    return r.json();
  }
  // `name` is the capture's file name (result.name). The hub refuses a path outside the agent's capture folder.
  async function ptyReadCapture(agent, name, maxBytes) {
    const q = new URLSearchParams({ name });
    if (maxBytes) q.set('max_bytes', String(maxBytes));
    return (await _terminal(`${_agentPath(agent)}/capture?${q}`)).text();
  }
  // Idempotent; safe to call on every slash-send.
  async function ptyHealGeometry(agent) {
    try { await _terminal(`${_agentPath(agent)}/heal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch (e) { console.warn('[pty] heal failed for', agent, e); }
  }
  // Short post-keypress footer reads (no geometry forcing); the hub clamps ms to [0, 2000].
  async function ptyTapRead(agent, durationMs) {
    try {
      const q = durationMs == null ? '' : `?ms=${encodeURIComponent(durationMs)}`;
      return await (await _terminal(`${_agentPath(agent)}/tap${q}`)).text();
    } catch (e) { console.warn('[pty] tap-read failed for', agent, e); return ''; }
  }
  // The composer's slash mode: one write, no Take control (POST /terminal/<agent>/input).
  async function ptyInput(agent, text) {
    await _terminal(`${_agentPath(agent)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  // ws(s)://<hub>/terminal/<agent>?token=...&cols=..&rows=.. (a browser WebSocket cannot send a header).
  function terminalWsUrl(base, token, agent, cols, rows) {
    const q = new URLSearchParams();
    if (token) q.set('token', token);
    if (cols > 0) q.set('cols', String(cols));
    if (rows > 0) q.set('rows', String(rows));
    return `${String(base).replace(/^http/, 'ws')}${_agentPath(agent)}?${q}`;
  }

  // One viewer of one agent's terminal (hub-first-browser, design decision 4). Read-only until take().
  //   onOutput(Uint8Array)  raw PTY bytes     onControl('you' | 'other' | 'none')   onReadOnly()  input was dropped
  //   onClose(event)        the socket ended
  // opts.base / opts.token default to the page's hub URL and token; opts.WebSocketImpl is for tests.
  function openTerminalSocket(agent, opts = {}) {
    const base = opts.base ?? (typeof BUS !== 'undefined' ? BUS : '');
    const token = opts.token ?? (typeof AUTH_TOKEN !== 'undefined' ? AUTH_TOKEN : '');
    const WS = opts.WebSocketImpl || window.WebSocket;
    const ws = new WS(terminalWsUrl(base, token, agent, opts.cols, opts.rows));
    ws.binaryType = 'arraybuffer';
    const view = { controller: false };
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { opts.onOutput?.(new Uint8Array(e.data)); return; }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'control') {
        view.controller = m.by === 'you';
        opts.onControl?.(m.by);
      } else if (m.t === 'error' && m.e === 'read-only') {
        opts.onReadOnly?.();
      }
    };
    ws.onclose = (e) => { view.controller = false; opts.onClose?.(e); };
    ws.onerror = () => {};
    return {
      get isControl() { return view.controller; },
      take: (cols, rows) => send({ t: 'take', cols, rows }),
      handBack: () => send({ t: 'hand_back' }),
      input: (text) => send({ t: 'in', d: strToB64(text) }),
      resize: (cols, rows) => send({ t: 'resize', cols, rows }),
      close: () => { try { ws.close(); } catch {} },
    };
  }

  const encoder = new TextEncoder();
  function strToB64(str) {
    const bytes = encoder.encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.pty = {
    ptySpawn, listRoles, listModels, ptyKill, ptyList,
    ptyCaptureTurn, ptyReadCapture, ptyHealGeometry, ptyTapRead, ptyInput,
    terminalWsUrl, openTerminalSocket,
    strToB64, b64ToBytes,
  };
})();
