// terminal/role-list.js — the dark role listbox of the spawn modal (task 5.7). A native <select> cannot be styled
// while open, so #spawn-role-select stays the hidden source of the value and this draws button + menu over it.
// DOM only (no Tauri), so it runs in a vm with a fake DOM.

(function () {
  function attach({ select, button, menu, doc }) {
    const label = button.querySelector('.role-label');
    let active = -1;

    const items = () => [...menu.children];
    const isOpen = () => menu.classList.contains('open');

    function setActive(i) {
      const list = items();
      if (!list.length) return;
      active = (i + list.length) % list.length;
      list.forEach((el, n) => el.classList.toggle('active', n === active));
      list[active].scrollIntoView?.({ block: 'nearest' });
    }
    function open() {
      sync();
      menu.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      setActive(select.selectedIndex);
    }
    function close() {
      menu.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }
    function choose(i) {
      const opt = select.options[i];
      if (!opt) return;
      const changed = select.value !== opt.value;
      select.value = opt.value;
      close();
      sync();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Rebuild the list from the select's options and show the current one on the button.
    function sync() {
      menu.textContent = '';
      [...select.options].forEach((opt, i) => {
        const el = doc.createElement('div');
        el.className = 'role-option' + (opt.value === select.value ? ' selected' : '');
        el.setAttribute('role', 'option');
        el.dataset.value = opt.value;
        el.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');
        const name = doc.createElement('span');
        name.textContent = opt.textContent;
        const check = doc.createElement('span');
        check.className = 'role-check';
        check.textContent = opt.value === select.value ? '✓' : '';
        el.append(name, check);
        el.addEventListener('click', (e) => { e.stopPropagation(); choose(i); button.focus?.(); });
        menu.append(el);
      });
      if (label) label.textContent = select.selectedOptions?.[0]?.textContent ?? select.options[select.selectedIndex]?.textContent ?? '';
    }

    button.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
    button.addEventListener('keydown', (e) => {
      const k = e.key;
      if (!isOpen()) {
        if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); open(); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (k === 'Tab') close();
    });
    doc.addEventListener('click', (e) => {
      if (isOpen() && !menu.contains(e.target) && !button.contains(e.target)) close();
    });
    select.addEventListener('change', sync);

    sync();
    return { sync, open, close };
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.roleList = { attach };
})();
