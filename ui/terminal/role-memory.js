// terminal/role-memory.js — remembers the role and the model override of each agent name, like the cwd cache in
// terminal.js. Pure over a storage object (localStorage in the app), so it can run without a DOM.

(function () {
  const KEY = 'cubilot_agent_roles';

  function load(storage) {
    try {
      const v = JSON.parse(storage.getItem(KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  // A launch with "None" forgets the agent: reopening the modal for it then shows "None", as today.
  // `choice` = the grid choice of that launch ({model, provider, effort}, each null when it was the default) plus the
  // launch `harness`.
  function remember(storage, agent, role, choice) {
    const all = load(storage);
    const c = choice && typeof choice === 'object' ? choice : { model: choice };   // an older call passed the model alone
    const keep = {};
    for (const k of ['model', 'provider', 'effort', 'harness']) if (typeof c[k] === 'string' && c[k]) keep[k] = c[k];
    if (role) all[agent] = { role, ...keep };
    else delete all[agent];
    storage.setItem(KEY, JSON.stringify(all));
  }

  // → { role, model, provider, effort, harness } or null. Own keys only, so an agent called "constructor" cannot hit the prototype.
  function recall(storage, agent) {
    const all = load(storage);
    const e = Object.prototype.hasOwnProperty.call(all, agent) ? all[agent] : null;
    if (!(e && typeof e.role === 'string' && e.role)) return null;
    const str = (v) => (typeof v === 'string' ? v : '');
    return { role: e.role, model: str(e.model), provider: str(e.provider), effort: str(e.effort), harness: str(e.harness) };
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.roleMemory = { remember, recall };
})();
