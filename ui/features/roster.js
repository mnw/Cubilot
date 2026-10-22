// roster.js — legend, presence, composer target dropdown/menu.

function applyRoster(agents) {
  ROSTER = Array.isArray(agents) ? agents : [];
  for (const k of Object.keys(NAMES)) {
    if (k !== 'you' && k !== 'system' && k !== 'all') delete NAMES[k];
  }
  for (const k of Object.keys(COLORS)) delete COLORS[k];
  for (const k of Object.keys(BODY_COLORS)) delete BODY_COLORS[k];

  for (const a of ROSTER) {
    NAMES[a.name] = cap(a.name);
    COLORS[a.name] = a.color;
    BODY_COLORS[a.name] = shade(a.color, 0.25);
  }

  renderLegend();
  refreshRolePills();
  renderTargetDropdown();
  renderRoomSwitcher();
  // An agent removed from the hub drops its pause there without an entry; re-read every tab's state.
  window.syncAllPauseStates?.();
  window.refreshRoomLead?.();
}

legendEl.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('.legend-remove');
  if (!btn) return;
  const item = btn.closest('.legend-item');
  const name = item?.dataset?.agent;
  if (!name || name === 'you') return;
  btn.disabled = true;
  try {
    const r = await authedFetch('/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: name }),
    });
    if (!r.ok) {
      const err = await parseErrorBody(r);
      addMessage({ from: 'system', to: 'you', text: `Remove failed: ${err}`, ts: '' });
      btn.disabled = false;
    }
  } catch (err) {
    addMessage({ from: 'system', to: 'you', text: `Remove failed: ${err?.message ?? err}`, ts: '' });
    btn.disabled = false;
  }
});

function renderLegend() {
  hidePillCard();   // every pill is replaced: a card for a removed pill must not stay
  legendEl.innerHTML = '';

  for (const a of ROSTER) {
    const isHuman = a.name === HUMAN_NAME;
    const legItem = document.createElement('div');
    legItem.className = 'legend-item offline';
    legItem.dataset.agent = a.name;
    legItem.tabIndex = 0;   // keyboard focus opens the details card, like hover
    // Human visible in every room (no data-room attr).
    if (!isHuman && typeof a.room === 'string' && a.room) legItem.dataset.room = a.room;
    const removeBtn = isHuman
      ? ''
      : `<button type="button" class="legend-remove" title="Remove agent" aria-label="Remove ${a.name}">×</button>`;
    legItem.innerHTML =
      `<div class="legend-dot" style="background:${a.color}"></div>` +
      `<span class="legend-label">${a.name}</span>` +
      `<span class="presence-dot" title="offline"></span>` +
      `<span class="legend-state">off</span>` +
      removeBtn;
    legendEl.appendChild(legItem);
  }

  if (!ROSTER.length) {
    const empty = document.createElement('div');
    empty.className = 'legend-item offline';
    empty.style.fontStyle = 'italic';
    empty.innerHTML = '<span class="legend-label">waiting for agents…</span>';
    legendEl.appendChild(empty);
  }
}

// The pill shows only the dot, the name and the presence. Role, harness, model, provider and effort are in a card
// on hover or keyboard focus (pillCardFields, pill-card.js), the same five fields for every agent. The data comes
// from the tmux session (pty_roles); outside the desktop app there is none.
let pillRoles = {};
let pillCardEl = null;
let pillCardFor = null;

function hidePillCard() {
  pillCardFor = null;
  if (pillCardEl) pillCardEl.hidden = true;
}

function showPillCard(item) {
  const name = item.dataset.agent;
  if (!name || pillCardFor === name) return;
  pillCardFor = name;
  if (!pillCardEl) {
    pillCardEl = document.createElement('div');
    pillCardEl.className = 'pill-card';
    pillCardEl.setAttribute('role', 'tooltip');
    document.body.appendChild(pillCardEl);
  }
  const info = pillRoles[name];
  pillCardEl.innerHTML = pillCardFields(info).map(([k, v]) =>
    `<div class="pill-card-row"><span class="pill-card-k">${escAttr(k)}</span><span class="pill-card-v">${escAttr(v)}</span></div>`).join('');
  // Fixed position under the pill: the card floats, so the pills do not move or wrap.
  const r = item.getBoundingClientRect();
  pillCardEl.hidden = false;   // shown first: a hidden card has no width to measure
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const left = Math.max(8, Math.min(r.left, vw - pillCardEl.getBoundingClientRect().width - 8));
  Object.assign(pillCardEl.style, { top: `${r.bottom + 6}px`, left: `${left}px` });
}

legendEl.addEventListener('mouseover', (e) => {
  const item = e.target.closest?.('.legend-item[data-agent]');
  if (item) showPillCard(item);
});
legendEl.addEventListener('mouseout', (e) => {
  const item = e.target.closest?.('.legend-item[data-agent]');
  if (item && !item.contains(e.relatedTarget)) hidePillCard();
});
legendEl.addEventListener('focusin', (e) => {
  const item = e.target.closest?.('.legend-item[data-agent]');
  if (item) showPillCard(item);
});
legendEl.addEventListener('focusout', hidePillCard);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePillCard(); });

// Task 6.2: an online agent with role `orchestrator` becomes the lead of its room, once, and only when the room has
// no lead yet (the human's choice is never overridden). The hub route is human-only, so the call is made as the human.
const leadAttempted = new Set();
async function ensureOrchestratorLead(roles) {
  for (const { room, agent } of pickLeadTargets(roles, ROSTER, presenceState, leadAttempted)) {
    const k = leadAttemptKey(room, agent);
    leadAttempted.add(k);
    try {
      const cur = await authedFetch(`/rooms/${encodeURIComponent(room)}/lead`);
      if (!cur.ok) throw new Error(`read lead: ${cur.status}`);
      if ((await cur.json())?.lead) continue;   // a lead is set: leave it
      const r = await authedFetch(`/rooms/${encodeURIComponent(room)}/lead`, {
        method: 'POST',
        body: JSON.stringify({ by: HUMAN_NAME, agent }),
      });
      if (!r.ok) throw new Error(`set lead: ${r.status}`);
      window.refreshRoomLead?.();
    } catch (e) {
      leadAttempted.delete(k);   // try again on the next refresh
      console.warn('[roster] orchestrator lead:', e?.message ?? e);
    }
  }
}

let rolePillTimer = null;
function refreshRolePills() {
  clearTimeout(rolePillTimer);
  rolePillTimer = setTimeout(async () => {
    let roles = {};
    try { roles = (await tauriInvoke('pty_roles')) || {}; } catch { return; }
    pillRoles = roles;
    ensureOrchestratorLead(roles);
    for (const el of legendEl.querySelectorAll('.legend-role')) el.remove();   // old inline text, if any
  }, 300);
}

function renderTargetDropdown() {
  const prev = targetEl.value || 'auto';
  targetEl.innerHTML = '';
  // ALL view = god view (everyone); concrete room = same-room + human.
  const visibleRoster = SELECTED_ROOM === ROOM_ALL
    ? ROSTER
    : ROSTER.filter((a) => a.room === null || a.room === SELECTED_ROOM);
  const optAuto = document.createElement('option');
  optAuto.value = 'auto';
  optAuto.textContent = '@ mentions';
  targetEl.appendChild(optAuto);
  for (const a of visibleRoster) {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = `→ ${cap(a.name)}`;
    targetEl.appendChild(opt);
  }
  if (visibleRoster.length > 1) {
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '→ All';
    targetEl.appendChild(optAll);
  }
  // "!<agent>" routes through POST /interrupts.
  const sep = document.createElement('option');
  sep.disabled = true;
  sep.textContent = '──────────';
  targetEl.appendChild(sep);
  for (const a of visibleRoster) {
    if (a.name === HUMAN_NAME) continue;
    const opt = document.createElement('option');
    opt.value = `!${a.name}`;
    opt.textContent = `⚠ Interrupt ${cap(a.name)}`;
    targetEl.appendChild(opt);
  }
  const match = [...targetEl.options].some((o) => o.value === prev);
  targetEl.value = match ? prev : 'auto';
  renderTargetMenu();
}

function renderTargetMenu() {
  if (!targetMenu) return;
  targetMenu.innerHTML = '';

  const build = (value, label, extraClass = '') => {
    const el = document.createElement('div');
    el.className = 'target-option' + (extraClass ? ' ' + extraClass : '');
    if (value === targetEl.value) el.classList.add('selected');
    el.dataset.value = value;
    el.role = 'option';
    el.textContent = label;
    el.addEventListener('click', () => {
      targetEl.value = value;
      renderTargetMenu();
      updateTargetDisplayLabel();
      closeTargetMenu();
    });
    return el;
  };

  const visibleRoster = SELECTED_ROOM === ROOM_ALL
    ? ROSTER
    : ROSTER.filter((a) => a.room === null || a.room === SELECTED_ROOM);

  targetMenu.appendChild(build('auto', '@ mentions'));
  for (const a of visibleRoster) {
    targetMenu.appendChild(build(a.name, `→ ${cap(a.name)}`));
  }
  if (visibleRoster.length > 1) {
    targetMenu.appendChild(build('all', '→ All'));
  }

  const interruptAgents = visibleRoster.filter((a) => a.name !== HUMAN_NAME);
  if (interruptAgents.length) {
    const divider = document.createElement('div');
    divider.className = 'target-menu-divider';
    targetMenu.appendChild(divider);
    for (const a of interruptAgents) {
      targetMenu.appendChild(build(`!${a.name}`, `⚠ Interrupt ${cap(a.name)}`, 'interrupt'));
    }
  }

  updateTargetDisplayLabel();
}

function updateTargetDisplayLabel() {
  if (!targetDisplayText) return;
  const v = targetEl.value || 'auto';
  const opt = [...targetEl.options].find((o) => o.value === v);
  targetDisplayText.textContent = opt ? opt.textContent : '@ mentions';
}

function openTargetMenu() {
  if (!targetMenu || !targetDisplay) return;
  targetMenu.classList.add('open');
  targetDisplay.setAttribute('aria-expanded', 'true');
}
function closeTargetMenu() {
  if (!targetMenu || !targetDisplay) return;
  targetMenu.classList.remove('open');
  targetDisplay.setAttribute('aria-expanded', 'false');
}

if (targetDisplay) {
  targetDisplay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (targetMenu.classList.contains('open')) closeTargetMenu();
    else openTargetMenu();
  });
  document.addEventListener('click', (e) => {
    if (!targetMenu?.classList.contains('open')) return;
    if (targetMenu.contains(e.target) || targetDisplay.contains(e.target)) return;
    closeTargetMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && targetMenu?.classList.contains('open')) closeTargetMenu();
  });
}

function applyPresence(agents) {
  presenceState = { ...agents };
  window.noteJoinPresence?.(presenceState);
  for (const a of ROSTER) {
    const item = legendEl.querySelector(`[data-agent="${a.name}"]`);
    if (!item) continue;
    const online = !!agents[a.name];
    item.classList.toggle('online', online);
    item.classList.toggle('offline', !online);
    const state = item.querySelector('.legend-state');
    if (state) state.textContent = online ? 'on' : 'off';
    const pd = item.querySelector('.presence-dot');
    if (pd) pd.title = online ? 'connected' : 'offline';
  }
  refreshRolePills();
  const names = ROSTER.map(a => a.name);
  const onCount = names.filter(n => agents[n]).length;
  let hubLabel = '';
  try {
    const p = new URL(BUS).port;
    if (p) hubLabel = ` · hub :${p}`;
  } catch {}
  statusText.textContent = `${onCount}/${names.length} agents${hubLabel}`;
  if (mentionPop?.classList.contains('open') && typeof updateMentionPopover === 'function') {
    updateMentionPopover();
  }
}

function markAllOffline() {
  const empty = {};
  for (const a of ROSTER) empty[a.name] = false;
  applyPresence(empty);
}
