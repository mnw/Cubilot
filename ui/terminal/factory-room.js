// terminal/factory-room.js — "New factory room" (task 6.1): validates the form and builds the one launch it makes.
// Pure (no DOM, no Tauri), so it can run in node. It launches the `orchestrator` role only; the workers and testers
// come later, from the orchestrator. The role values (model, effort) come from list_roles; the limits go to the room settings (6.4).

(function () {
  // Same label rule as the spawn modal (terminal.js NAME_RE).
  const NAME_RE = /^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_.-]$/;
  const LIMIT_MAX = 20;

  function parseLimit(v, label) {
    const s = String(v ?? '').trim();
    if (!/^\d+$/.test(s)) return { error: `${label} limit: whole number, 1 to ${LIMIT_MAX}.` };
    const n = Number(s);
    if (n < 1 || n > LIMIT_MAX) return { error: `${label} limit: whole number, 1 to ${LIMIT_MAX}.` };
    return { n };
  }

  // tmux changes a '.' in a session name, so a terminal agent cannot have one (same text as pty.rs). The hub still
  // accepts dots for external agents. null when the name is fine.
  function terminalNameError(name) {
    return String(name ?? '').includes('.') ? 'a dot is not allowed in a terminal agent name: tmux changes it' : null;
  }

  const limitOk = (v) => {
    const s = String(v ?? '').trim();
    return /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= LIMIT_MAX;
  };

  // values: { room, cwd, workers, testers }. → [{ key, name }] of the required fields that are not valid, in form order.
  function invalidFields(v) {
    const out = [];
    if (!NAME_RE.test(String(v?.room ?? '').trim())) out.push({ key: 'room', name: 'Room name' });
    if (!String(v?.cwd ?? '').trim()) out.push({ key: 'cwd', name: 'Project folder' });
    if (!limitOk(v?.workers)) out.push({ key: 'workers', name: 'Worker limit' });
    if (!limitOk(v?.testers)) out.push({ key: 'testers', name: 'Tester limit' });
    return out;
  }
  const missingFields = (v) => invalidFields(v).map((f) => f.name);

  // The `orchestrator` role of list_roles → { role: { harness, model, provider, effort } } or { error }.
  function orchestratorRole(roles) {
    const r = (roles || []).find((x) => x.name === 'orchestrator');
    if (!r) return { error: 'no orchestrator role is staged' };
    if (r.harness !== 'claude' && r.harness !== 'pi') return { error: `the orchestrator role has an unknown harness '${r.harness}'` };
    if (!r.model) return { error: 'the orchestrator role has no model' };
    if (!r.effort) return { error: 'the orchestrator role has no effort' };
    return { role: { harness: r.harness, model: r.model, provider: r.provider || null, effort: r.effort } };
  }

  // loader: the state of createRolesLoader (spawn-form.js) for this opening. values: as invalidFields.
  // → { disabled, line, orchestrator, role, missing }. Only the state of this opening counts: nothing is kept from an earlier one.
  function formState(loader, values) {
    const fill = window.__CUBILOT_TERM__.spawnForm.fillInText;
    const none = { role: null, missing: [] };
    if (loader.status === 'loading') return { disabled: true, line: 'Loading the orchestrator role…', orchestrator: 'Orchestrator: not loaded', ...none };
    let failure = loader.status === 'failed' ? loader.error : null;
    const found = loader.status === 'ready' ? orchestratorRole(loader.roles) : null;
    if (found?.error) failure = found.error;
    if (failure !== null) {
      return { disabled: true, line: `Could not load the orchestrator role: ${String(failure).replace(/\.+$/, '')}.`, orchestrator: 'Orchestrator: not loaded', ...none };
    }
    if (!found) return { disabled: true, line: '', orchestrator: 'Orchestrator: not loaded', ...none };   // the window is closed
    const { role } = found;
    const missing = missingFields(values);
    return { disabled: missing.length > 0, line: fill(missing), orchestrator: `Orchestrator: ${role.model}, effort ${role.effort} (from role)`, role, missing };
  }

  // form: { room, cwd, workers, testers, role }; role: { harness, model, provider, effort } from orchestratorRole.
  // existingAgents: names already in the roster.
  // → { error } or { launch: { agent, cwd, room, role, harness, model, provider, effort }, limits: { workers, testers } }
  function buildFactoryRoom(form, existingAgents) {
    const room = String(form?.room ?? '').trim();
    const cwd = String(form?.cwd ?? '').trim();
    if (!room) return { error: 'Room name is required.' };
    if (!NAME_RE.test(room)) return { error: 'Invalid room name (letters, digits, _.-, spaces in the middle).' };
    if (!cwd) return { error: 'Pick a project folder.' };
    const w = parseLimit(form?.workers, 'Worker');
    if (w.error) return { error: w.error };
    const t = parseLimit(form?.testers, 'Tester');
    if (t.error) return { error: t.error };
    const role = form?.role;
    if (!role?.model || !role?.effort || (role.harness !== 'claude' && role.harness !== 'pi')) {
      return { error: 'The orchestrator role is not loaded.' };
    }
    // One agent, the orchestrator. Its name is also the tmux session name, so it must be free.
    const taken = new Set(existingAgents || []);
    let agent = 'orchestrator';
    if (taken.has(agent)) agent = `orchestrator-${room}`;
    // The generated name is what tmux sees: `orchestrator` has no dot; `orchestrator-<room>` has one when the room does.
    if (terminalNameError(agent)) return { error: `Agent '${agent}': ${terminalNameError(agent)}. Use a room name without a dot, or free the name 'orchestrator'.` };
    if (!NAME_RE.test(agent) || taken.has(agent)) {
      return { error: `An agent called '${agent}' already exists. Remove it first.` };
    }
    return {
      launch: { agent, cwd, room, role: 'orchestrator', harness: role.harness, model: role.model, provider: role.provider || null, effort: role.effort },
      limits: { workers: w.n, testers: t.n },
    };
  }

  // The Launch click. Nothing runs (no settings PUT, no Nutshell write, no launch) unless the form allows it for this
  // opening. io: { putSettings(l, limits), seedNutshell(room, cwd), launch(l), close(), alert(text) }. → whether it launched.
  async function submitFactoryRoom(io, loader, values, existingAgents) {
    const st = formState(loader, values);
    if (st.disabled) return false;
    const r = buildFactoryRoom({ ...values, role: st.role }, existingAgents);
    if (r.error) { io.alert(r.error); return false; }
    // Store the limits in the room settings first (6.4); if that fails nothing is launched and the form stays open.
    try {
      await io.putSettings(r.launch, r.limits);
    } catch (e) {
      io.alert(`Could not store the room settings: ${e?.message ?? e}`);
      return false;
    }
    io.close();
    await io.seedNutshell(r.launch.room, r.launch.cwd);
    await io.launch(r.launch);
    return true;
  }

  // The Nutshell of a new factory room (task 6.3): the five fields. Product, repo (the project folder) and the room
  // are known from the form; the rest are placeholders the human or the orchestrator fills in.
  function nutshellTemplate(room, cwd) {
    return [
      `Product: <TODO: what #${room} builds, and for whom>`,
      `Repo: ${cwd}`,
      'Branch policy: <TODO: for example one branch for each ticket, merged by the human>',
      'Style guide: <TODO: path to the style guide in the repo>',
      'Definition of done: <TODO: what must be true before a ticket is done>',
    ].join('\n');
  }

  // The two calls that seed it, through the handoff primitive exactly like the Nutshell editor (nutshell.js): the
  // human sends a "[nutshell]" handoff to the human and accepts it. `existingText` is what the room has now; a room
  // that already has a Nutshell is never touched. → null (nothing to do) or { create, accept(id) } request specs.
  function nutshellSeedRequests(room, cwd, human, existingText) {
    if (String(existingText ?? '').trim()) return null;
    return {
      create: {
        from: human, to: human, task: '[nutshell] seed for new factory room',
        context: { patch: nutshellTemplate(room, cwd), room }, ttl_seconds: 3600,
      },
      accept: (id) => ({ id, body: { by: human, comment: 'seeded for new factory room' } }),
    };
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.factoryRoom = {
    buildFactoryRoom, nutshellTemplate, nutshellSeedRequests, terminalNameError,
    invalidFields, missingFields, orchestratorRole, formState, submitFactoryRoom,
  };
})();
