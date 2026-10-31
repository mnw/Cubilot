// terminal/pty.js — session routes of the hub, the Tauri attach/write/resize wrappers and base64 helpers; standalone (window.__TAURI__).

(function () {
  function _invoke() {
    return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  }

  // The event an agent's pane listens on. Tauri event names allow only alphanumerics, - / : _ but an agent name may
  // hold spaces and dots, so the name part is the lowercase hex of its UTF-8 bytes. Same string as pty_event in
  // pty.rs (tests/unit/pty-event-name.test.ts and a Rust test pin the same vectors).
  function ptyEventName(kind, agent) {
    const hex = Array.from(new TextEncoder().encode(String(agent)), (b) => b.toString(16).padStart(2, '0')).join('');
    return `pty://${kind}/${hex}`;
  }

  // The hub creates the session (POST /sessions); the shell only attaches the output stream (pty_attach) until the
  // terminal WebSocket (group 9). attachOnly: attach a live session and create nothing (the hub answers nothing, the shell
  // answers "session not found").
  async function ptySpawn(agent, cwd, sessionMode, room, harness, role, model, effort, provider, attachOnly) {
    if (!attachOnly) {
      const body = { name: agent, cwd };
      if (sessionMode === 'resume' || sessionMode === 'continue') body.resume = sessionMode;
      if (room) body.room = room;
      // Omitted → the hub defaults to claude.
      if (harness) body.harness = harness;
      // Omitted → no role, and the hub refuses a new session ("a role is required").
      if (role) body.role = role;
      // Only sent when the user changed the role's default model; then it applies to this launch only.
      if (model) body.model = model;
      // The grid choice (5.5): only what differs from the role default. effort is --effort (Claude) or --thinking (Pi).
      if (effort) body.effort = effort;
      if (provider) body.provider = provider;
      await _terminal('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    return _invoke()('pty_attach', { agent });
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
  async function ptyWrite(agent, b64) {
    return _invoke()('pty_write', { agent, b64 });
  }
  async function ptyResize(agent, cols, rows) {
    return _invoke()('pty_resize', { agent, cols, rows });
  }
  // The hub runs the sessions (hub/features/sessions.ts) and the four routes below (hub/features/terminal.ts); the
  // webview calls its routes, not the shell.
  async function _terminal(path, init) {
    const r = await window.authedFetch(path, init);
    if (!r.ok) throw new Error(await parseErrorBody(r));
    return r;
  }
  async function ptyKill(agent) {
    await _terminal(`/sessions/${encodeURIComponent(agent)}/kill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }
  // Agent sessions only; the Shell tab has ptyShellExists.
  async function ptyList() {
    try { return (await (await _terminal('/sessions')).json()).sessions; }
    catch { return []; }
  }
  async function ptyShellExists() {
    try { return (await (await _terminal('/sessions/shell')).json()).exists === true; }
    catch { return false; }
  }
  // The hub creates the shell session when it is missing; the shell attaches it.
  async function ptySpawnShell() {
    await _terminal('/sessions/shell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return _invoke()('pty_attach', { agent: 'shell' });
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
    ptySpawn, ptySpawnShell, ptyShellExists, listRoles, listModels, ptyWrite, ptyResize, ptyKill, ptyList, ptyEventName,
    ptyCaptureTurn, ptyReadCapture, ptyHealGeometry, ptyTapRead,
    strToB64, b64ToBytes,
  };
})();
