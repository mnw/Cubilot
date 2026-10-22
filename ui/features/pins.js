// pins.js — the strip above #messages with every message addressed to the human. The rules live in pins-model.js.

(function () {
  const strip = document.getElementById('pin-strip');
  if (!strip || !window.__CUBILOT_PINS__) return;
  const { createPins, firstLine } = window.__CUBILOT_PINS__;
  const pins = createPins(localStorage, () => HUMAN_NAME);
  let expanded = false;

  const room = () => (SELECTED_ROOM === ROOM_ALL ? null : SELECTED_ROOM);

  function render() {
    const { pins: shown, hidden, total } = pins.list(room(), expanded);
    strip.textContent = '';
    strip.hidden = total === 0;
    for (const e of shown) {
      const row = document.createElement('div');
      row.className = 'pin';
      row.dataset.msgId = e.id;
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'pin-main';
      const who = document.createElement('span');
      who.className = 'pin-from';
      who.textContent = NAMES[e.from] || e.from || 'system';
      if (COLORS[e.from]) who.style.color = COLORS[e.from];
      main.append(who);
      if (!room() && e.room) {
        const r = document.createElement('span');
        r.className = 'pin-room';
        r.textContent = `# ${e.room}`;
        main.append(r);
      }
      const ts = document.createElement('span');
      ts.className = 'pin-ts';
      ts.textContent = e.ts || '';
      const text = document.createElement('span');
      text.className = 'pin-text';
      text.textContent = firstLine(e.text);
      main.append(ts, text);
      main.addEventListener('click', () => scrollToMessage(e.id));
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pin-x';
      x.title = 'Unpin';
      x.setAttribute('aria-label', 'Unpin');
      x.textContent = '×';
      x.addEventListener('click', () => { pins.unpin(e.id); render(); });
      row.append(main, x);
      strip.append(row);
    }
    if (total > window.__CUBILOT_PINS__.MAX_SHOWN) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'pin-more';
      t.textContent = expanded ? 'Show fewer' : `+${hidden} more`;
      t.addEventListener('click', () => { expanded = !expanded; render(); });
      strip.append(t);
    }
  }

  function scrollToMessage(id) {
    const el = messagesEl.querySelector(`.msg[data-msg-id="${id}"]`);
    if (!el) { showCopyToast('That message is no longer in the chat'); return; }
    el.scrollIntoView({ block: 'center' });
    el.classList.add('pin-flash');
    setTimeout(() => el.classList.remove('pin-flash'), 1600);
  }

  // addMessage (messages.js) calls this for every entry, live or replayed.
  window.notePin = (entry) => { if (pins.add(entry)) render(); };
  document.addEventListener('cubilot:room-filter', render);
  render();
})();
