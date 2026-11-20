const formatNumber = new Intl.NumberFormat('pl-PL').format;

export function h(tag, classes = '', value) {
  const node = document.createElement(tag);
  if (classes) node.className = classes;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

export function button(title, classes, action) {
  const control = h('button', classes, title);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}

export function table(headings, rows) {
  const wrap = h('div', 'table-wrap');
  const table = h('table');
  const thead = h('thead');
  const header = h('tr');
  for (const heading of headings) {
    const cell = h('th', '', heading);
    cell.scope = 'col';
    if (!heading) cell.setAttribute('aria-label', 'Akcje');
    header.append(cell);
  }
  thead.append(header);
  const tbody = h('tbody');
  for (const cells of rows) {
    const row = h('tr');
    row.append(...cells);
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

export function pager(page, count, size, change, noun, {alwaysShowControls = false} = {}) {
  const bar = h('div', 'pager');
  const first = (page - 1) * size + 1;
  const last = Math.min(page * size, count);
  const range = count ? formatNumber(first) + '–' + formatNumber(last) + ' z ' : '';
  bar.append(h('span', '', range + formatNumber(count) + ' ' + noun));
  if (alwaysShowControls || count > size) {
    const controls = h('div', 'pager-controls');
    const previous = button('‹ Wstecz', 'page-button', () => change(page - 1));
    const next = button('Dalej ›', 'page-button', () => change(page + 1));
    previous.disabled = page === 1 || !count;
    next.disabled = last === count;
    controls.append(previous, next);
    bar.append(controls);
  }
  return bar;
}


export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = h('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
