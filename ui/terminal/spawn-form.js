// terminal/spawn-form.js — which required fields of the spawn form are not valid, and what the form shows for it.
// Pure (no DOM, no Tauri), so it runs in node. The new-room form reuses missingFields and fillInText.

(function () {
  // Same label rule as the spawn modal (terminal.js NAME_RE) and the hub (ids.ts).
  const NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;
  const RESERVED = ['you', 'all', 'system'];   // hub RESERVED_NAMES; the hub compares in lower case
  const SHELL = 'shell';                       // pty.rs SHELL_SESSION_NAME

  // A terminal agent name: the hub rule, no dot (tmux changes it), not the pinned shell.
  function agentNameOk(name) {
    const n = String(name ?? '').trim();
    return NAME_RE.test(n) && !n.includes('.') && n !== SHELL && !RESERVED.includes(n.toLowerCase());
  }

  const cellName = (harness) => (harness === 'pi' ? 'Model and thinking' : 'Model and effort');

  // values: { agent, role, harness, cell, cwd, room }. `role` is the name of a staged role (else ''). `cell` is true
  // when one grid cell is selected (a preselected default cell counts). → [{ key, name }] in form order.
  function invalidFields(v) {
    const out = [];
    if (!agentNameOk(v?.agent)) out.push({ key: 'agent', name: 'Agent name' });
    if (!v?.role) out.push({ key: 'role', name: 'Role' });
    if (v?.harness !== 'claude' && v?.harness !== 'pi') out.push({ key: 'harness', name: 'Harness' });
    if (!v?.cell) out.push({ key: 'cell', name: cellName(v?.harness) });
    if (!String(v?.cwd ?? '').trim()) out.push({ key: 'cwd', name: 'Project folder' });
    if (!NAME_RE.test(String(v?.room ?? '').trim())) out.push({ key: 'room', name: 'Room' });
    return out;
  }

  const missingFields = (v) => invalidFields(v).map((f) => f.name);

  const fillInText = (missing) => (missing.length ? `Fill in: ${missing.join(', ')}.` : '');

  // The role list of one opening of the form. Each open() starts a new opening: the answer of an earlier one is dropped,
  // and nothing of an earlier opening stays (state is "loading" with no roles until this opening is answered).
  function createRolesLoader(listRoles) {
    let opening = 0;
    let state = { status: 'idle', roles: [], error: '' };
    return {
      state: () => state,
      close() { opening++; state = { status: 'idle', roles: [], error: '' }; },
      async open() {
        const mine = ++opening;
        state = { status: 'loading', roles: [], error: '' };
        try {
          const roles = await listRoles();
          if (mine === opening) state = { status: 'ready', roles, error: '' };
        } catch (e) {
          if (mine === opening) state = { status: 'failed', roles: [], error: String(e?.message ?? e) };
        }
        return state;
      },
    };
  }

  // → { disabled, line, missing } for the Launch button and the one line under it.
  function launchState(loader, values) {
    if (loader.status === 'loading') return { disabled: true, line: 'Loading roles…', missing: [] };
    if (loader.status === 'failed') {
      return { disabled: true, line: `Could not load the roles: ${loader.error}. Close and open the form again.`, missing: [] };
    }
    if (loader.status !== 'ready') return { disabled: true, line: '', missing: [] };
    const missing = missingFields(values);
    return { disabled: missing.length > 0, line: fillInText(missing), missing };
  }

  // Calls `launch` only when the form allows it. → whether it did.
  function tryLaunch(loader, values, launch) {
    if (launchState(loader, values).disabled) return false;
    launch();
    return true;
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.spawnForm = { NAME_RE, agentNameOk, cellName, invalidFields, missingFields, fillInText, createRolesLoader, launchState, tryLaunch };
})();
