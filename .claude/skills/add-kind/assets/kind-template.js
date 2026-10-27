// ui/kinds/<kind>.js
//
// Starter skeleton for a kind's UI module.
// Exports { dispatch(event), bootstrap(cap) } — matches the shape main.js iterates.
// Replace <kind> with the actual name (e.g. "signoff").
//
// Pre-v0.9.5: paste this logic inline into ui/main.js next to the existing
// renderHandoffCard / renderInterruptCard / renderPermissionCard functions.
// Use the existing `authedFetch` helper (defined around ui/main.js:52) — do NOT
// call `fetch` directly, mutating routes require the Bearer token that
// authedFetch injects automatically.

// Version-reconcile map: entity_id -> last version applied. Prevents replay from
// stomping newer live events on reconnect. Share across renderCard/updateDom.
const applied = new Map();

// Snapshot of current UI state per entity. Keep the shape close to the row.
const state = new Map();

function renderCard(entity) {
  const el = document.createElement("div");
  el.className = "<kind>-card";
  el.dataset.id = entity.id;
  buildDom(el, entity);
  return el;
}

function buildDom(el, entity) {
  el.innerHTML = `
    <header><span class="<kind>-id">${entity.id}</span></header>
    <div class="<kind>-body"><!-- fill --></div>
    <footer><button data-action="resolve">Resolve</button></footer>
  `;
  el.querySelector('[data-action="resolve"]')
    .addEventListener("click", () => handleAction("resolve", entity.id));
}

function updateDom(el, entity) {
  // Targeted updates only — don't reinnerHTML or you'll lose focus/selection.
  // Update the state-badge, swap button visibility, etc. Same pattern as
  // updateHandoffCardDom / updatePermissionCardDom in ui/main.js.
}

// POST via authedFetch — mutating routes require the Bearer token that
// `fetch` alone will NOT send. `authedFetch` is defined in ui/main.js
// (module-level). The hub emits a follow-up SSE event on success that lands
// back here in dispatch() and reconciles the card — avoid optimistic mutation
// unless you specifically want an instant visual response.
async function handleAction(action, id) {
  try {
    const r = await authedFetch(`/<kind>/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: HUMAN_NAME }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: "system", to: HUMAN_NAME, text: `<kind> ${action} failed: ${err}`, ts: "" });
    }
  } catch (e) {
    addMessage({ from: "system", to: HUMAN_NAME, text: `<kind> ${action} error: ${e?.message ?? e}`, ts: "" });
  }
}

// -- Exported surface ------------------------------------------------------

export function bootstrap(cap) {
  // Called once on page load. Post-v0.9.5 UI modules: create and mount the
  // kind's root container here (e.g. <section id="<kind>-list">) so dispatch()
  // has a prepend target. Also GET any pre-existing entities and render them:
  //
  //     const r = await cap.authedFetch('/<kind>?status=pending&limit=500');
  //     if (r.ok) for (const snap of await r.json()) dispatch(snapshotToEvent(snap));
  //
  // Pre-v0.9.5: no-op here; the existing loadPendingHandoffs/Interrupts/Permissions
  // pattern in ui/main.js is where you hook in. Copy that function for your kind.
}

// SSE event shape (matches handoffEntry / interruptEntry / permissionEntry in hub.ts):
//   { from, to, text, ts, image, kind, <kind>_id, version, replay, snapshot }
// where `kind` is "<kind>.new" / "<kind>.update" / etc, and `snapshot` is the
// full row payload the card renders.
export function dispatch(event) {
  const verb = event.kind.split(".")[1];
  const id = event["<kind>_id"];
  if (!id) return;

  // Version reconciliation: drop events older than what's already applied.
  // `version` is MAX(events.seq) for this entity — monotonic.
  const incomingVersion = Number(event.version ?? event.snapshot?.version ?? 0);
  if ((applied.get(id) ?? -1) >= incomingVersion) return;
  applied.set(id, incomingVersion);

  const snap = event.snapshot ?? safeParse(event.text);
  if (!snap) return;

  switch (verb) {
    case "new": {
      state.set(id, snap);
      const card = renderCard(snap);
      const container = document.querySelector("#<kind>-list");
      if (container) container.prepend(card);
      break;
    }
    case "update":
    // include your transition verbs here (e.g. "resolved", "dismissed" for permission)
    {
      const prev = state.get(id);
      const next = { ...prev, ...snap };
      state.set(id, next);
      const el = document.querySelector(`.<kind>-card[data-id="${id}"]`);
      if (el) updateDom(el, next);
      break;
    }
    // add verbs to match your state machine
  }
}

function safeParse(s) {
  try { return JSON.parse(s ?? ""); } catch { return null; }
}
