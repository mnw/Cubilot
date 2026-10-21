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
  function remember(storage, agent, role, model) {
    const all = load(storage);
    if (role) all[agent] = model ? { role, model } : { role };
    else delete all[agent];
    storage.setItem(KEY, JSON.stringify(all));
  }

  // → { role, model } or null. Own keys only, so an agent called "constructor" cannot hit the prototype.
  function recall(storage, agent) {
    const all = load(storage);
    const e = Object.prototype.hasOwnProperty.call(all, agent) ? all[agent] : null;
    return e && typeof e.role === 'string' && e.role ? { role: e.role, model: typeof e.model === 'string' ? e.model : '' } : null;
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.roleMemory = { remember, recall };
})();
