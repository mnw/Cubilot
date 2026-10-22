// terminal/factory-room.js — "New factory room" (task 6.1): validates the form and builds the one launch it makes.
// Pure (no DOM, no Tauri), so it can run in node. It launches the `orchestrator` role only; the workers and testers
// come later, from the orchestrator. The limits are checked here; terminal.js stores them in the room settings (6.4).

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

  // form: { room, cwd, workers, testers, harness, choice, roleHarness }; existingAgents: names already in the roster.
  // `harness` is the launch harness ('claude' default). `choice` is the grid choice {model, provider, effort} (each null
  // when it equals the role default). `roleHarness` is the orchestrator role's own harness: on any other harness the
  // role has no default model, so a model must be chosen (task 9.6, same rule as the spawn modal).
  // → { error } or { launch: { agent, cwd, room, role, harness, model, provider, effort }, limits: { workers, testers } }
  // tmux changes a '.' in a session name, so a terminal agent cannot have one (same text as pty.rs). The hub still
  // accepts dots for external agents. null when the name is fine.
  function terminalNameError(name) {
    return String(name ?? '').includes('.') ? 'a dot is not allowed in a terminal agent name: tmux changes it' : null;
  }

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
    const harness = form?.harness ?? 'claude';
    if (harness !== 'claude' && harness !== 'pi') return { error: `Unknown harness '${harness}'.` };
    const c = form?.choice || {};
    if (form?.roleHarness && form.roleHarness !== harness && !c.model) {
      return { error: `Pick a model for ${harness}: the orchestrator role has no default there.` };
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
      launch: { agent, cwd, room, role: 'orchestrator', harness, model: c.model || null, provider: c.provider || null, effort: c.effort || null },
      limits: { workers: w.n, testers: t.n },
    };
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
  window.__CUBILOT_TERM__.factoryRoom = { buildFactoryRoom, nutshellTemplate, nutshellSeedRequests, terminalNameError };
})();
