// terminal/grid-view.js — draws a model x effort grid (ui/terminal/model-grid.js) into an element. Used by the
// New factory room window (task 9.6). The spawn modal still draws its own copy in terminal.js (renderSpawnGrid): its
// unit test slices that code out of terminal.js, so merging the two is a separate change.
// `doc` is passed in so the function runs in node with a fake DOM.

(function () {
  function renderGrid({ doc, gridEl, filterEl, countEl, grid, selected }) {
    const isPi = grid.harness === 'pi';
    if (filterEl) filterEl.hidden = !isPi;
    if (countEl) countEl.textContent = isPi ? `${grid.count.shown}/${grid.count.total}` : '';
    const cols = `minmax(130px, 1.8fr) repeat(${grid.columns.length}, minmax(28px, 1fr))`;
    gridEl.textContent = '';
    const head = doc.createElement('div');
    head.className = 'grid-head';
    head.style.gridTemplateColumns = cols;
    head.append(doc.createElement('span'));
    for (const c of grid.columns) { const h = doc.createElement('span'); h.textContent = c; head.append(h); }
    gridEl.append(head);
    if (!grid.rows.length) {
      const empty = doc.createElement('div');
      empty.className = 'grid-empty';
      empty.textContent = grid.count.total ? 'No model matches the filter.' : 'No models.';
      gridEl.append(empty);
    }
    for (const r of grid.rows) {
      const row = doc.createElement('div');
      row.className = 'grid-row';
      row.style.gridTemplateColumns = cols;
      const label = doc.createElement('span');
      label.className = 'row-label' + (r.ready ? '' : ' not-ready') + (grid.defaultCell?.rowKey === r.key ? ' default' : '');
      label.textContent = r.label;
      label.title = r.ready ? r.label : `${r.label}: not signed in. A launch with it stops with a sign-in message.`;
      row.append(label);
      for (const c of grid.columns) {
        const b = doc.createElement('button');
        b.type = 'button';
        const isDefault = grid.defaultCell && grid.defaultCell.rowKey === r.key && grid.defaultCell.effort === c;
        const isSel = selected && selected.rowKey === r.key && selected.effort === c;
        b.className = 'cell' + (isDefault ? ' default' : '') + (isSel ? ' selected' : '');
        b.dataset.row = r.key;
        b.dataset.effort = c;
        b.setAttribute('aria-pressed', isSel ? 'true' : 'false');
        b.title = `${r.label}, ${c}${isDefault ? ' (role default)' : ''}`;
        row.append(b);
      }
      gridEl.append(row);
    }
  }

  window.__CUBILOT_TERM__ = window.__CUBILOT_TERM__ || {};
  window.__CUBILOT_TERM__.gridView = { renderGrid };
})();
