// pins-model.js — which chat entries are pinned at the top of the chat. Pure (no DOM), so it runs in node.
// A pin is an entry addressed to the human: `to` is "you" or the human's name. "all" is never pinned, and an
// entry without a hub id (a local audit line) cannot be pinned, because its id would not be stable.

(function () {
  const KEY = 'cubilot_unpinned_pins';
  const UNPINNED_MAX = 500;   // oldest ids fall out; the pin list itself is bounded by the chat history
  const MAX_SHOWN = 3;

  function loadUnpinned(storage) {
    try {
      const v = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : [];
    } catch {
      return [];
    }
  }

  const isForHuman = (e, human) => e.to === 'you' || (!!human && e.to === human);

  // → true when `e` is pinned: a hub id, addressed to the human, not written by the human.
  function isPinned(e, human) {
    if (!e || typeof e.id !== 'number') return false;
    if (e.from === 'you' || (human && e.from === human)) return false;
    return isForHuman(e, human);
  }

  // storage: localStorage-like. human: () => the human's name (it can change after the first roster).
  function createPins(storage, human) {
    const entries = new Map();                       // id -> entry; the same id is never pinned twice
    let unpinned = loadUnpinned(storage);

    return {
      // → true when the entry is a new pin.
      add(e) {
        if (!isPinned(e, human()) || entries.has(e.id)) return false;
        entries.set(e.id, e);
        return true;
      },
      unpin(id) {
        if (unpinned.includes(id)) return;
        unpinned = [...unpinned, id].slice(-UNPINNED_MAX);
        storage.setItem(KEY, JSON.stringify(unpinned));
      },
      // room: the selected room label, or null for "All rooms". An entry without a room shows everywhere.
      // → { pins: newest first, hidden: how many the "+N more" toggle holds }
      list(room, expanded) {
        const all = [...entries.values()]
          .filter((e) => !unpinned.includes(e.id) && (!room || !e.room || e.room === room))
          .sort((a, b) => b.id - a.id);
        const pins = expanded ? all : all.slice(0, MAX_SHOWN);
        return { pins, hidden: all.length - pins.length, total: all.length };
      },
    };
  }

  const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim()) ?? '';

  window.__CUBILOT_PINS__ = { isPinned, createPins, firstLine, MAX_SHOWN };
})();
