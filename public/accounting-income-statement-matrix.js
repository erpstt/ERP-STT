const byId = id => document.getElementById(id);
const vector = (row, columns) => columns.map(column => Number(row.dimensions?.[column.id] || 0));
const add = (left, right, factor = 1) => left.map((value, index) => value + Number(right[index] || 0) * factor);
const sum = values => values.reduce((total, value) => total + Number(value || 0), 0);

export function renderIncomeStatementMatrix(context) {
  const { data, options, financial, escapeHtml, incomeSection, toggleTree, openLedger, renderPager } = context;
  const rows = [...(data.rows || [])];
  const usedIds = new Set(rows.flatMap(row => Object.entries(row.dimensions || {}).filter(([id, value]) => id !== 'unassigned' && Math.abs(Number(value || 0)) >= 0.000001).map(([id]) => id)));
  const catalog = new Map((data.columns || []).map(column => [String(column.id), column]));
  const orderedIds = [...(data.columns || []).map(column => String(column.id)).filter(id => usedIds.has(id)), ...[...usedIds].filter(id => !catalog.has(id)).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))];
  const columns = [...orderedIds.map(id => catalog.get(id) || { id, name: `Dimensión ${id}` }), { id: 'unassigned', name: 'Sin Asignar / General' }];
  const zero = () => columns.map(() => 0);
  const sections = { revenue: [], cost: [], expense: [], nonop: [], tax: [] };
  rows.forEach(row => sections[incomeSection(row)].push(row));
  const sectionVector = key => sections[key].reduce((total, row) => add(total, vector(row, columns)), zero());
  const revenue = sectionVector('revenue'), cost = sectionVector('cost'), expense = sectionVector('expense'), tax = sectionVector('tax');
  const nonop = sections.nonop.reduce((total, row) => add(total, vector(row, columns), row.category === 'Ingreso' ? 1 : -1), zero());
  const gross = add(revenue, cost, -1), operating = add(gross, expense, -1), beforeTax = add(operating, nonop), net = add(beforeTax, tax, -1);
  const definitions = [
    ['revenue', 'Ingresos Operacionales', revenue], ['cost', '(-) Costo de Ventas', cost],
    ['gross', '= UTILIDAD BRUTA', gross, 'subtotal'], ['expense', '(-) Gastos de Operación (Ventas y Administración)', expense],
    ['operating', '= UTILIDAD OPERATIVA', operating, 'subtotal'], ['nonop', '(+/-) Ingresos y Gastos No Operativos (Financieros)', nonop],
    ['beforeTax', '= UTILIDAD ANTES DE IMPUESTOS (UAI)', beforeTax, 'subtotal'], ['tax', '(-) Provisión Impuesto sobre la Renta', tax],
    ['net', '= UTILIDAD O PÉRDIDA NETA DEL PERIODO', net, 'net']
  ];
  const cells = (values, accountId = null) => values.map(value => `<td class="number ${value < 0 ? 'negative' : ''}">${accountId && value !== 0 ? `<button class="account-drill ${value < 0 ? 'negative' : ''}" data-account="${accountId}" title="Abrir Libro Mayor">${financial(value)}</button>` : financial(value)}</td>`).join('') + `<td class="number matrix-total ${sum(values) < 0 ? 'negative' : ''}">${financial(sum(values))}</td>`;
  byId('thead').innerHTML = `<tr><th class="matrix-code">Código</th><th class="matrix-account">Cuenta Contable</th>${columns.map(column => `<th class="number">${escapeHtml(column.name)}</th>`).join('')}<th class="number matrix-total">Total Consolidado</th></tr>`;
  const html = [];
  for (const [key, label, values, kind] of definitions) {
    if (kind) { html.push(`<tr class="statement-${kind}"><td class="matrix-code"></td><td class="matrix-account">${label}</td>${cells(values)}</tr>`); continue; }
    const sectionId = `matrix-section-${key}`;
    html.push(`<tr class="statement-section" data-node="${sectionId}"><td class="matrix-code"><button class="tree-toggle" data-toggle="${sectionId}">−</button></td><td class="matrix-account">${label}</td>${cells(values)}</tr>`);
    const grouped = new Map();
    for (const row of sections[key]) {
      const groupId = String(row.group_id || 'other'), group = (options.accountGroups || []).find(item => String(item.id) === groupId);
      const entry = grouped.get(groupId) || { group, rows: [], values: zero() };
      entry.rows.push(row); entry.values = add(entry.values, vector(row, columns), key === 'nonop' && row.category !== 'Ingreso' ? -1 : 1); grouped.set(groupId, entry);
    }
    const sorted = [...grouped].sort((a, b) => String(a[1].group?.code || '').localeCompare(String(b[1].group?.code || ''), 'es', { numeric: true }));
    for (const [groupId, entry] of sorted) {
      const nodeId = `${sectionId}-group-${groupId}`, indent = Math.max(1, Math.min(4, Number(entry.group?.level || 1))) * 18;
      html.push(`<tr data-parent="${sectionId}" data-node="${nodeId}" class="tree-group"><td class="matrix-code">${escapeHtml(entry.group?.code || '')}</td><td class="matrix-account" style="padding-left:${indent}px"><button class="tree-toggle" data-toggle="${nodeId}">−</button>${escapeHtml(entry.group?.name || 'Otras cuentas')}</td>${cells(entry.values)}</tr>`);
      entry.rows.sort((a, b) => String(a.account_number).localeCompare(String(b.account_number), 'es', { numeric: true }));
      for (const row of entry.rows) {
        const values = vector(row, columns).map(value => key === 'nonop' && row.category !== 'Ingreso' ? -value : value);
        html.push(`<tr data-parent="${nodeId}" class="tree-account"><td class="matrix-code">${escapeHtml(row.account_number)}</td><td class="matrix-account" style="padding-left:${indent + 28}px">${escapeHtml(row.account_name)}</td>${cells(values, row.account_id)}</tr>`);
      }
    }
  }
  byId('tbody').innerHTML = html.join('') || `<tr><td colspan="${columns.length + 3}">No hay movimientos para los filtros seleccionados.</td></tr>`;
  document.querySelector('#workspace table')?.classList.add('income-matrix');
  document.querySelectorAll('[data-toggle]').forEach(button => button.onclick = () => toggleTree(button.dataset.toggle, button));
  document.querySelectorAll('[data-account]').forEach(button => button.onclick = () => openLedger(button.dataset.account));
  const matrixResult = sum(net), ledgerResult = Number(data.summary?.periodResult || 0), difference = matrixResult - ledgerResult, matched = Math.abs(difference) < 0.005;
  byId('summary').innerHTML = `<div class="metric"><small>Resultado neto del reporte</small><b class="${matrixResult < 0 ? 'negative' : ''}">${financial(matrixResult)}</b></div><div class="metric"><small>Resultado según Mayor General</small><b class="${ledgerResult < 0 ? 'negative' : ''}">${financial(ledgerResult)}</b></div><div class="metric ${matched ? 'reconciled' : 'unreconciled'}"><small>Conciliación al centavo</small><b>${matched ? 'Coincide al centavo' : `Diferencia ${financial(difference)}`}</b></div>`;
  renderPager();
}
