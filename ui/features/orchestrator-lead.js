// orchestrator-lead.js — which agents become the lead of their room (task 6.2). Pure, so it runs in node.
// The hub does not know roles; the role of a running agent comes from its tmux session (pty_roles), so the UI
// makes the call: an ONLINE agent whose role is `orchestrator` leads its room. Found by role, not by name, because
// the app may call it `orchestrator-<room>`.

(function () {
  const key = (room, agent) => `${room}\u0000${agent}`;

  // roles: { agent: { role } }; roster: [{ name, room }]; presence: { agent: bool };
  // attempted: Set of keys already tried. → [{ room, agent }], at most one per room, stable order.
  function pickLeadTargets(roles, roster, presence, attempted) {
    const byRoom = new Map();
    for (const a of roster || []) {
      if (!a || typeof a.room !== 'string' || !a.room) continue;
      const info = roles?.[a.name];
      if (info?.role !== 'orchestrator' || !presence?.[a.name]) continue;
      if (attempted.has(key(a.room, a.name))) continue;
      if (!byRoom.has(a.room)) byRoom.set(a.room, a.name);
    }
    return [...byRoom].map(([room, agent]) => ({ room, agent }));
  }

  window.pickLeadTargets = pickLeadTargets;
  window.leadAttemptKey = key;
})();
