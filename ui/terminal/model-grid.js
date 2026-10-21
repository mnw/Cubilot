// terminal/model-grid.js — the model x effort grid of the spawn modal (task 5.5). Pure (no DOM, no Tauri), so it
// runs in node. Rows are models, columns are effort levels, one cell is selected, the role's default cell is marked.
// Only what differs from the role default is sent to pty_spawn; without a role the chosen cell is sent whole.

(function () {
  const EFFORTS = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],              // claude --effort
    pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], // pi --thinking
  };

  const rowKey = (provider, model) => `${provider || ''}/${model}`;
  const rowLabel = (harness, r) => (harness === 'pi' ? `${r.model} [${r.provider}]` : r.model);

  // harness: 'claude' | 'pi'; models: [{provider, model, thinking, ready}] from list_models;
  // filter: type-to-filter text (Pi); role: {harness, model, provider, thinking} from list_roles, or null.
  function gridModel({ harness, models, filter = '', role = null }) {
    const h = harness === 'pi' ? 'pi' : 'claude';
    const all = (models || []).map((r) => ({
      key: rowKey(h === 'pi' ? r.provider : '', r.model),
      label: rowLabel(h, r),
      provider: h === 'pi' ? r.provider : '',
      model: r.model,
      ready: r.ready !== false,       // a provider that is not signed in stays in the list, marked
      thinking: r.thinking !== false,
    }));
    const q = String(filter || '').trim().toLowerCase();
    const rows = q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
    // The role default: its row and, when the role names one (Pi: `thinking`), its column. A Claude role has no
    // default effort, so only the row is marked.
    let defaultCell = null;
    if (role && role.harness === h && role.model) {
      const key = rowKey(h === 'pi' ? role.provider : '', role.model);
      if (all.some((r) => r.key === key)) {
        defaultCell = { rowKey: key, effort: role.thinking && h === 'pi' ? role.thinking : null };
      }
    }
    return { harness: h, columns: EFFORTS[h], rows, count: { shown: rows.length, total: all.length }, defaultCell, all };
  }

  // The cell that is selected when the modal opens or the role changes: the role's default cell, else none.
  function initialSelection(grid) {
    const d = grid.defaultCell;
    return d && d.effort ? { rowKey: d.rowKey, effort: d.effort } : null;
  }

  // → { model, provider, effort } with only the parts that differ from the role default, or null for "send nothing".
  // Without a role every part of the chosen cell is sent. With a role, the model (and provider) only when the row is
  // not the role's row, and the effort only when it is not the role's effort (a Claude role has none: always sent).
  function choiceFromSelection(grid, selected) {
    if (!selected) return null;
    const row = grid.all.find((r) => r.key === selected.rowKey);
    if (!row || !grid.columns.includes(selected.effort)) return null;
    const d = grid.defaultCell;
    const out = { model: null, provider: null, effort: null };
    if (!d || d.rowKey !== row.key) {
      out.model = row.model;
      out.provider = grid.harness === 'pi' ? row.provider : null;
    }
    if (!d || d.effort !== selected.effort) out.effort = selected.effort;
    return out.model || out.effort ? out : null;
  }

  // For the remembered choice of an agent (role-memory): the selection a stored choice stands for, or null when the
  // model is no longer in the list.
  function selectionFromChoice(grid, choice) {
    if (!choice || !choice.effort) return null;
    const key = choice.model ? rowKey(grid.harness === 'pi' ? choice.provider : '', choice.model) : grid.defaultCell?.rowKey;
    return key && grid.all.some((r) => r.key === key) ? { rowKey: key, effort: choice.effort } : null;
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.modelGrid = { EFFORTS, gridModel, initialSelection, choiceFromSelection, selectionFromChoice };
})();
