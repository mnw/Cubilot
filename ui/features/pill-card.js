// pill-card.js — the fields of the hover card on a roster pill. Pure, so it runs in node.
// The same five fields, in the same order, for every agent and both harnesses. The data is what pty_roles gives
// (role, model, provider, effort, harness, all recorded at launch); a field that is not known is "-".

(function () {
  // info: { role, model, provider, effort, harness } from pty_roles (every launch of this app has one), or undefined
  // for an external agent. harness and effort default to the info's own; passing them overrides.
  function pillCardFields(info, harness = info?.harness, effort = info?.effort) {
    const or = (v) => (v ? String(v) : '-');
    const h = harness === 'claude' || harness === 'pi' ? harness : '';
    // Shows what the launch recorded: "no role" for a launch without a role, and "default" only when pty_spawn
    // wrote it (no model or effort flag). A missing value (an older session, an external agent) is "-".
    return [
      ['Role', info ? (info.role || 'no role') : '-'],
      ['Harness', or(h)],
      ['Model', or(info?.model)],
      ['Provider', or(info?.provider || (h === 'claude' ? 'anthropic' : ''))],
      ['Effort', or(effort)],
    ];
  }

  window.pillCardFields = pillCardFields;
})();
