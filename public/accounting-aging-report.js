import {csvCell,reportWorkbook,reportNumber} from './spreadsheet-safety.js?v=20261102-a03-spreadsheet';
import {escapeHtml as htmlText} from './html-safety.js?v=20261101-a03-1';
import { indexBy } from './frontend-performance.js?v=20261023-second-pass-v3';

const buckets = ['CURRENT', '1_30', '31_60', '61_90', '91_120', 'OVER_120'];
const bucketNames = {
  CURRENT: 'Por vencer',
  '1_30': '1 - 30 días',
  '31_60': '31 - 60 días',
  '61_90': '61 - 90 días',
  '91_120': '91 - 120 días',
  OVER_120: 'Más de 120 días',
};

const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const moneyFormatter = new Intl.NumberFormat('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const optionIndexes = new WeakMap();
export const payableInvoiceTypes=Object.freeze([
  {code:'STANDARD',label:'Estándar'},{code:'EXPENSE',label:'Expense'},{code:'CARD',label:'Tarjeta'},
  {code:'PETTY_CASH',label:'Caja Chica'},{code:'FIXED_ASSET',label:'Activos Fijos'},{code:'OTHER',label:'Otros / sin tipo'},
].map(Object.freeze));
const payableTypeByCode=new Map(payableInvoiceTypes.map(type=>[type.code,type]));
const payableType=value=>payableTypeByCode.get(String(value??'').trim().toUpperCase())||payableTypeByCode.get('OTHER');

function indexedOptions(context) {
  const source = context.options || {};
  let indexes = optionIndexes.get(source);
  if (indexes) return indexes;
  const currencies = source.currencies || [];
  indexes = {
    currenciesById: indexBy(currencies, item => item.id),
    currenciesByCode: indexBy(currencies, item => String(item.code || '').toUpperCase()),
    subsidiariesById: indexBy(source.subsidiaries, item => item.id),
  };
  optionIndexes.set(source, indexes);
  return indexes;
}

function first(source, ...keys) {
  for (const key of keys) if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  return null;
}

function originalMode(context) {
  return String(context.currencyMode || 'LOCAL').toUpperCase() === 'ORIGINAL';
}

function currencyMeta(context, source = {}) {
  const id = first(source, 'currencyId', 'currency_id');
  const code = String(first(source, 'currencyCode', 'currency_code', 'presentationCurrency', 'presentation_currency') || '').trim();
  const indexes = indexedOptions(context);
  const known = indexes.currenciesById.get(String(id))
    || (code ? indexes.currenciesByCode.get(code.toUpperCase()) : undefined);
  if (originalMode(context)) return {
    id: id ?? known?.id ?? code,
    code: code || known?.code || 'MONEDA',
    name: String(first(source, 'currencyName', 'currency_name') || known?.name || ''),
    symbol: String(first(source, 'currencySymbol', 'currency_symbol') || known?.symbol || code || ''),
  };
  if (context.data.consolidated) return { id: 'USD', code: 'USD', name: 'Dólar estadounidense', symbol: 'US$' };
  const company = indexes.subsidiariesById.get(String(context.subsidiaryId));
  const local = indexes.currenciesById.get(String(company?.currencyId));
  return { id: local?.id, code: local?.code || '', name: local?.name || '', symbol: local?.symbol || local?.code || '' };
}

function money(context, value, source = {}) {
  const amount = Number(value || 0);
  const currency = currencyMeta(context, source);
  const prefix = currency.symbol || currency.code;
  const number = moneyFormatter.format(Math.abs(amount));
  return `${amount < 0 ? '(' : ''}${prefix ? `${prefix} ` : ''}${number}${amount < 0 ? ')' : ''}`.trim();
}

function currencyLabel(context, source = {}) {
  const currency = currencyMeta(context, source);
  return [currency.code, currency.name].filter(Boolean).join(' · ') || 'Moneda original';
}

export function agingCurrencyBreakdown(context) {
  const raw = first(context.data.summary || {}, 'currencyBreakdown', 'currency_breakdown');
  if (!Array.isArray(raw)) return [];
  const globalAvailability = first(context.data.summary || {}, 'reconciliationAvailable', 'reconciliation_available');
  const globalReason = first(context.data.summary || {}, 'reconciliationReason', 'reconciliation_reason');
  return raw.map(item => {
    const control = first(item, 'controlBalance', 'control_balance');
    const difference = first(item, 'difference');
    const itemAvailability = first(item, 'reconciliationAvailable', 'reconciliation_available');
    const reconciliationAvailable = itemAvailability ?? globalAvailability ?? (control !== null && difference !== null);
    return {
      source: item,
      currency: currencyMeta(context, item),
      subledger: Number(first(item, 'subledger') || 0),
      advances: Number(first(item, 'advances') || 0),
      netBalance: Number(first(item, 'netBalance', 'net_balance') || 0),
      controlBalance: reconciliationAvailable ? Number(control || 0) : null,
      difference: reconciliationAvailable ? Number(difference || 0) : null,
      reconciliationAvailable: Boolean(reconciliationAvailable),
      reconciliationReason: first(item, 'reconciliationReason', 'reconciliation_reason') || globalReason || null,
    };
  });
}

function amount(context, value, source) {
  return html(money(context, value, source));
}

function renderSummary(context, receivables) {
  const summaryElement = context.elements.summary;
  if (!originalMode(context)) {
    const summary = context.data.summary || {};
    const difference = Number(summary.difference || 0);
    const available=receivables||first(summary,'reconciliationAvailable','reconciliation_available')!==false;
    const matched = available&&Math.abs(difference) < .005;
    const unavailableMessage=first(summary,'reconciliationReason','reconciliation_reason')==='INVOICE_TYPE_FILTER'?'Seleccione Todos los tipos para comparar con el Mayor.':'Conciliación no disponible con estos filtros.';
    summaryElement.innerHTML = `<div class="metric"><small>Auxiliar ${receivables ? 'clientes' : 'proveedores'}</small><b>${htmlText(context.financial(summary.subledger))}</b></div>
      <div class="metric"><small>Anticipos / saldos sin aplicar</small><b>${htmlText(context.financial(summary.advances))}</b></div>
      <div class="metric"><small>Saldo neto</small><b>${htmlText(context.financial(summary.netBalance))}</b></div>
      <div class="metric"><small>Cuenta de control del Mayor</small><b>${available?htmlText(context.financial(summary.controlBalance)):'No disponible con este filtro'}</b></div>
      <div class="metric ${!available?'unavailable':matched?'reconciled':'unreconciled'}"><small>Conciliación</small><b>${!available?unavailableMessage:matched ? 'Coincide al centavo' : `Advertencia: diferencia de ${htmlText(context.financial(difference))} entre el auxiliar y el Mayor General.`}</b></div>`;
    return;
  }

  const breakdown = agingCurrencyBreakdown(context);
  if (!breakdown.length) {
    if(context.reportKey==='payables-aging'&&Array.isArray(context.data.invoiceTypeTotals)&&context.data.total===0&&!(context.data.rows||[]).length){summaryElement.innerHTML='<section class="aging-original-note"><b>Sin facturas para los filtros seleccionados.</b></section>';return;}
    summaryElement.innerHTML = '<section class="aging-original-note"><b>Valores en moneda original</b><span>Los importes de monedas distintas no se suman ni se comparan con la cuenta de control en moneda local. Genere nuevamente el reporte para obtener el desglose por moneda.</span></section>';
    return;
  }
  summaryElement.innerHTML = `<section class="aging-currency-overview">
    <div class="aging-currency-overview-heading"><div><small>MONEDA ORIGINAL</small><h2>Auxiliar y conciliación separados por moneda</h2></div><p>Cada moneda se presenta y concilia por separado; no se suman USD, JMD ni otras divisas.</p></div>
    <div class="aging-currency-grid">${breakdown.map(item => {
      const matched = item.reconciliationAvailable && Math.abs(item.difference) < .005;
      return `<article class="aging-currency-card ${!item.reconciliationAvailable ? 'unavailable' : matched ? 'reconciled' : 'unreconciled'}">
        <div class="aging-currency-title"><span>${html(item.currency.code || 'MONEDA')}</span><div><b>${html(item.currency.name || item.currency.code || 'Moneda original')}</b><small>${receivables ? 'Cuentas por cobrar' : 'Cuentas por pagar'}</small></div></div>
        <dl><div><dt>Auxiliar</dt><dd>${amount(context, item.subledger, item.source)}</dd></div><div><dt>Anticipos / sin aplicar</dt><dd>${amount(context, item.advances, item.source)}</dd></div><div><dt>Saldo neto</dt><dd>${amount(context, item.netBalance, item.source)}</dd></div><div><dt>Mayor</dt><dd>${item.reconciliationAvailable ? amount(context, item.controlBalance, item.source) : 'No disponible'}</dd></div></dl>
        <p class="aging-reconciliation-result">${!item.reconciliationAvailable ? item.reconciliationReason === 'CROSS_CURRENCY' ? 'Conciliación por moneda no disponible por aplicaciones entre monedas; consulte la presentación local.' : 'Conciliación no disponible con filtros analíticos' : matched ? '✓ Coincide al centavo' : `⚠ Diferencia ${amount(context, item.difference, item.source)}`}</p>
      </article>`;
    }).join('')}</div></section>`;
}

function payableCurrencyKey(context,source){const currency=currencyMeta(context,source);return String(currency.id??currency.code);}
function emptyPayableTotal(context,source,type){return{type,source,currency:currencyMeta(context,source),documentCount:0,originalAmount:0,appliedAmount:0,pending:0,buckets:Object.fromEntries(buckets.map(bucket=>[bucket,0]))};}
function addPayableTotal(target,source){for(const key of['documentCount','originalAmount','appliedAmount','pending'])target[key]+=Number(source[key]||0);for(const bucket of buckets)target.buckets[bucket]+=Number(source.buckets?.[bucket]||0);}
function payableModel(context){
 const rows=context.data.rows||[],global=Array.isArray(context.data.invoiceTypeTotals),complete=global||context.data.allRowsLoaded||Number(context.data.total||0)<=rows.length,blocks=new Map(),totals=new Map();
 const ensure=type=>{if(!blocks.has(type.code))blocks.set(type.code,{type,rows:[],totals:[]});return blocks.get(type.code);};
 const add=(type,source,values)=>{const key=`${type.code}|${payableCurrencyKey(context,source)}`;let total=totals.get(key);if(!total){total=emptyPayableTotal(context,source,type);totals.set(key,total);ensure(type).totals.push(total);}addPayableTotal(total,values);};
 if(global)for(const total of context.data.invoiceTypeTotals)add(payableType(total.invoiceTypeCode),total,total);
 for(const row of rows){const type=payableType(row.invoice_type_code);ensure(type).rows.push(row);if(!global)add(type,row,{documentCount:1,originalAmount:row.original_amount,appliedAmount:row.applied_amount,pending:row.pending,buckets:{[row.bucket]:row.pending}});else if(!totals.has(`${type.code}|${payableCurrencyKey(context,row)}`))throw Error('Los totales por tipo de factura están incompletos. Vuelva a generar el reporte.');}
 const ordered=payableInvoiceTypes.map(type=>blocks.get(type.code)).filter(block=>block&&(block.rows.length||block.totals.some(total=>total.documentCount>0))),currencies=new Map();
 for(const block of ordered)for(const total of block.totals){const key=payableCurrencyKey(context,total.source);if(!currencies.has(key))currencies.set(key,emptyPayableTotal(context,total.source,null));addPayableTotal(currencies.get(key),total);}
 return{blocks:ordered,currencies:[...currencies.values()],complete};
}
function payableEntityGroups(context,rows){
 const groups=new Map();for(const row of rows){const key=`${row.entity_id}|${payableCurrencyKey(context,row)}`;let group=groups.get(key);if(!group){group={row,docs:[],total:emptyPayableTotal(context,row,payableType(row.invoice_type_code)),domId:`aging-payable-${payableType(row.invoice_type_code).code.toLowerCase()}-${groups.size+1}`};groups.set(key,group);}group.docs.push(row);addPayableTotal(group.total,{documentCount:1,originalAmount:row.original_amount,appliedAmount:row.applied_amount,pending:row.pending,buckets:{[row.bucket]:row.pending}});}
 return[...groups.values()].sort((left,right)=>String(left.row.entity_name||'').localeCompare(String(right.row.entity_name||''),'es',{sensitivity:'base',numeric:true})||left.total.currency.code.localeCompare(right.total.currency.code));
}
function payableAdvances(context){return context.data.summary?.typeFilterActive||context.data.summary?.unallocatedAdvancesExcluded?[]:(Array.isArray(context.data.unallocatedAdvancesByEntity)?context.data.unallocatedAdvancesByEntity:[]).filter(row=>Number(row.amount)!==0);}
function payableAdvanceCompany(context,row){return context.data.consolidated?indexedOptions(context).subsidiariesById.get(String(row.subsidiaryId))?.name||`Subsidiaria #${row.subsidiaryId}`:'';}
function renderPayableAdvances(context){
 const summary=context.elements.summary,excluded=context.data.summary?.typeFilterActive||context.data.summary?.unallocatedAdvancesExcluded,rows=payableAdvances(context);
 if(excluded){summary.insertAdjacentHTML('beforeend','<p class="aging-payable-note">Anticipos sin aplicar se presentan al seleccionar Todos los tipos. Este filtro incluye únicamente documentos; no clasifica ni distribuye anticipos.</p>');return;}
 if(!rows.length)return;
 summary.insertAdjacentHTML('beforeend',`<section class="aging-payable-advances"><h3>Anticipos sin aplicar · sin asignación a un tipo de factura</h3><p>Se presentan una sola vez por proveedor, empresa y moneda. El saldo neto general ya los incluye.</p><div class="table-wrap"><table><thead><tr><th>Proveedor</th><th>Moneda</th><th class="number">Anticipo sin aplicar</th></tr></thead><tbody>${rows.map(row=>`<tr data-payable-advance="${html(row.entityId)}"><td>${html([row.entityCode,row.entityName].filter(Boolean).join(' · '))}${context.data.consolidated?`<small>${html(payableAdvanceCompany(context,row))}</small>`:''}</td><td>${html(currencyMeta(context,row).code||'—')}</td><td class="number">${amount(context,row.amount,row)}</td></tr>`).join('')}</tbody></table></div></section>`);
}
function renderPayableTypes(context){
 const rows=context.data.rows||[],model=payableModel(context),detail=context.view==='DETAIL',columns=detail?16:10,body=[],rowsByDocument=indexBy(rows,row=>row.document_id);
 context.elements.tbody.closest('table')?.classList.add('aging-payables');
 context.elements.thead.innerHTML=detail?`<tr><th>Identificación</th><th>Proveedor</th><th>Categoría</th><th>Factura proveedor / Ref. interna</th><th>Moneda</th><th>Emisión</th><th>Vencimiento</th><th class="number">Días mora</th><th class="number">Monto original</th><th class="number">Saldo pendiente</th>${buckets.map(bucket=>`<th class="number">${bucketNames[bucket]}</th>`).join('')}</tr>`:`<tr><th>Proveedor</th><th>Moneda</th>${buckets.map(bucket=>`<th class="number">${bucketNames[bucket]}</th>`).join('')}<th class="number">Saldo facturas</th><th>Acciones</th></tr>`;
 const detailRow=row=>`<tr class="aging-detail aging-${htmlText(String(row.bucket).toLowerCase())}" data-payable-document="${html(row.document_id)}"><td>${html(row.identification||row.entity_code)}</td><td>${html(row.entity_name)}${row.subsidiary_name?`<small>${html(row.subsidiary_name)}</small>`:''}</td><td>${html(row.entity_category||'—')}</td><td><button class="ledger-link" data-journal="${html(row.journal_id||'')}">${html(row.external_document_number?`${row.external_document_number} (Ref. ${row.document_number})`:row.document_number)}</button></td><td><span class="aging-currency-badge">${html(currencyMeta(context,row).code||'—')}</span></td><td>${html(row.issue_date)}</td><td>${html(row.due_date)}</td><td class="number">${Number(row.overdue_days||0)}</td><td class="number">${amount(context,row.original_amount,row)}</td><td class="number"><button class="account-drill" data-aging-app="${html(row.document_id)}">${amount(context,row.pending,row)}</button></td>${buckets.map(bucket=>`<td class="number">${amount(context,row.bucket===bucket?row.pending:0,row)}</td>`).join('')}</tr>`;
 const totalRow=(total,label,kind)=>detail?`<tr class="${kind}"><td colspan="8">${html(label)} · ${html(total.currency.code)}</td><td class="number">${amount(context,total.originalAmount,total.source)}</td><td class="number">${amount(context,total.pending,total.source)}</td>${buckets.map(bucket=>`<td class="number">${amount(context,total.buckets[bucket],total.source)}</td>`).join('')}</tr>`:`<tr class="${kind}"><td colspan="2">${html(label)} · ${html(total.currency.code)}</td>${buckets.map(bucket=>`<td class="number">${amount(context,total.buckets[bucket],total.source)}</td>`).join('')}<td class="number">${amount(context,total.pending,total.source)}</td><td></td></tr>`;
 for(const block of model.blocks){const count=block.totals.reduce((sum,total)=>sum+total.documentCount,0),visible=block.rows.length;body.push(`<tr class="aging-payable-type" data-invoice-type="${html(block.type.code)}"><th colspan="${columns}"><span>${html(block.type.label)}</span><small>${detail?`${visible} de ${model.complete?count:'—'} documentos en esta página`:`${count} documentos`}</small></th></tr>`);
  if(detail)body.push(block.rows.map(detailRow).join('')||`<tr class="aging-payable-page-empty"><td colspan="${columns}">Sin documentos de este tipo en esta página. Use el filtro Tipo de factura para consultarlos.</td></tr>`);
  else for(const group of payableEntityGroups(context,block.rows)){const row=group.row,total=group.total;body.push(`<tr class="aging-summary" data-payable-supplier="${html(row.entity_id)}"><td><button class="tree-toggle" data-aging-toggle="${html(group.domId)}">+</button>${html(`${row.entity_code} - ${row.entity_name}`)}${context.data.consolidated?`<small>${html([...new Set(group.docs.map(item=>item.subsidiary_name).filter(Boolean))].join(' · '))}</small>`:''}</td><td><span class="aging-currency-badge">${html(total.currency.code)}</span></td>${buckets.map(bucket=>`<td class="number">${amount(context,total.buckets[bucket],row)}</td>`).join('')}<td class="number">${amount(context,total.pending,row)}</td><td>${context.data.consolidated?'':`<button data-statement="${html(row.entity_id)}">Estado de cuenta</button>`}</td></tr>`);for(const item of group.docs)body.push(`<tr hidden data-aging-parent="${html(group.domId)}" data-payable-document="${html(item.document_id)}" class="aging-child aging-aligned"><td class="aging-document"><b>${html(item.document_number)}</b><small>Emisión ${html(item.issue_date)} · Vence ${html(item.due_date)}</small></td><td><span class="aging-currency-badge">${html(currencyMeta(context,item).code)}</span></td>${buckets.map(bucket=>`<td class="number">${amount(context,item.bucket===bucket?item.pending:0,item)}</td>`).join('')}<td class="number">${amount(context,item.pending,item)}</td><td><a class="ledger-link" href="/supplier-invoice-view.html?id=${encodeURIComponent(item.document_id)}">Ver</a> <button data-aging-app="${html(item.document_id)}">Aplicaciones</button></td></tr>`);}
  for(const total of block.totals)body.push(totalRow(total,`Subtotal ${block.type.label} · ${model.complete?'todas las páginas':'página actual'}`,'aging-payable-subtotal'));
 }
 for(const total of model.currencies)body.push(totalRow(total,`Total documentos · ${model.complete?'todas las páginas':'página actual'}`,'aging-payable-total'));
 context.elements.tbody.innerHTML=body.join('')||`<tr><td colspan="${columns}">No existen documentos para los filtros seleccionados.</td></tr>`;
 context.elements.tbody.querySelectorAll('[data-aging-toggle]').forEach(button=>button.onclick=()=>{const children=[...context.elements.tbody.querySelectorAll(`[data-aging-parent="${button.dataset.agingToggle}"]`)],show=children.every(child=>child.hidden);children.forEach(child=>child.hidden=!show);button.textContent=show?'−':'+';});
 context.elements.tbody.querySelectorAll('[data-journal]').forEach(button=>button.onclick=()=>button.dataset.journal&&context.openJournal(button.dataset.journal));context.elements.tbody.querySelectorAll('[data-aging-app]').forEach(button=>button.onclick=()=>showApplications(context,rowsByDocument.get(String(button.dataset.agingApp))));
 renderSummary(context,false);renderPayableAdvances(context);context.renderPager();
}

function showApplications(context, row) {
  if (!row) return;
  const get = id => document.getElementById(id);
  get('variationModal').hidden = false;
  get('variationTitle').textContent = `Aplicaciones de ${row.document_number}`;
  get('variationBalances').hidden = false;
  get('variationBalances').innerHTML = `<div class="metric"><small>Monto original · ${html(currencyLabel(context, row))}</small><b>${amount(context, row.original_amount, row)}</b></div><div class="metric"><small>Total aplicado</small><b>${amount(context, row.applied_amount, row)}</b></div><div class="metric"><small>Saldo pendiente</small><b>${amount(context, row.pending, row)}</b></div>`;
  get('variationRows').closest('.table-wrap').hidden = false;
  get('variationRows').innerHTML = (row.applications || []).map(item => `<tr><td>${html(item.date)}</td><td>${html([item.type, item.reference].filter(Boolean).join(': '))}</td><td class="number">${amount(context, item.amount, row)}</td><td colspan="3"></td></tr>`).join('') || '<tr><td colspan="6">No existen cobros o pagos aplicados a este documento.</td></tr>';
}

export function renderCurrencyAwareAgingReport(context) {
  if(context.reportKey==='payables-aging')return renderPayableTypes(context);
  context.elements.tbody.closest('table')?.classList.remove('aging-payables');
  const rows = context.data.rows || [];
  const rowsByDocument = indexBy(rows, row => row.document_id);
  const receivables = context.reportKey === 'receivables-aging';
  const original = originalMode(context);
  const groups = new Map();
  for (const row of rows) {
    const currency = currencyMeta(context, row);
    const key = original ? `${row.entity_id}|${currency.id || currency.code}` : String(row.entity_id);
    let group = groups.get(key);
    if (!group) {
      group = { row, docs: [], totals: Object.fromEntries(buckets.map(bucket => [bucket, 0])), domId: `aging-group-${groups.size + 1}`, currency };
      groups.set(key, group);
    }
    group.docs.push(row);
    group.totals[row.bucket] = (group.totals[row.bucket] || 0) + Number(row.pending || 0);
  }

  const detail = row => `<tr class="aging-detail aging-${htmlText(String(row.bucket).toLowerCase())}"><td>${html(row.identification || row.entity_code)}</td><td>${html(row.entity_name)}${row.subsidiary_name ? `<small>${html(row.subsidiary_name)}</small>` : ''}</td><td>${html(receivables ? row.manager || '—' : row.entity_category || '—')}</td><td><button class="ledger-link" data-journal="${htmlText(row.journal_id || '')}">${html(!receivables && row.external_document_number ? `${row.external_document_number} (Ref. ${row.document_number})` : row.document_number)}</button></td><td><span class="aging-currency-badge">${html(currencyMeta(context, row).code || '—')}</span></td><td>${html(row.issue_date)}</td><td>${html(row.due_date)}</td><td class="number">${Number(row.overdue_days || 0)}</td><td class="number">${amount(context, row.original_amount, row)}</td><td class="number"><button class="account-drill" data-aging-app="${htmlText(row.document_id)}">${amount(context, row.pending, row)}</button></td>${buckets.map(bucket => `<td class="number">${row.bucket === bucket ? amount(context, row.pending, row) : amount(context, 0, row)}</td>`).join('')}</tr>`;

  if (context.view === 'DETAIL') {
    context.elements.thead.innerHTML = `<tr><th>Identificación</th><th>${receivables ? 'Cliente' : 'Proveedor'}</th><th>${receivables ? 'Vendedor / Gestor' : 'Categoría'}</th><th>${receivables ? 'Documento' : 'Factura proveedor / Ref. interna'}</th><th>Moneda</th><th>Emisión</th><th>Vencimiento</th><th class="number">Días mora</th><th class="number">Monto original</th><th class="number">Saldo pendiente</th>${buckets.map(bucket => `<th class="number">${bucketNames[bucket]}</th>`).join('')}</tr>`;
    context.elements.tbody.innerHTML = rows.map(detail).join('') || '<tr><td colspan="16">No existen documentos para la fecha de corte.</td></tr>';
  } else {
    context.elements.thead.innerHTML = `<tr><th>${receivables ? 'Cliente' : 'Proveedor'}</th><th>Moneda</th>${buckets.map(bucket => `<th class="number">${bucketNames[bucket]}</th>`).join('')}<th class="number">Saldo facturas</th><th class="number">Anticipos / Sin aplicar</th><th class="number">Saldo neto</th><th>Acciones</th></tr>`;
    const body = [];
    for (const group of groups.values()) {
      const row = group.row;
      const total = buckets.reduce((sum, bucket) => sum + group.totals[bucket], 0);
      const advance = Number(row.entity_advances || 0);
      body.push(`<tr class="aging-summary"><td><button class="tree-toggle" data-aging-toggle="${htmlText(group.domId)}">+</button>${html(`${row.entity_code} - ${row.entity_name}`)}${context.data.consolidated ? `<small>${html([...new Set(group.docs.map(item => item.subsidiary_name).filter(Boolean))].join(' · '))}</small>` : ''}</td><td><span class="aging-currency-badge">${html(group.currency.code || '—')}</span><small>${html(group.currency.name || '')}</small></td>${buckets.map(bucket => `<td class="number aging-${bucket.toLowerCase()}">${amount(context, group.totals[bucket], row)}</td>`).join('')}<td class="number">${amount(context, total, row)}</td><td class="number">${amount(context, advance, row)}</td><td class="number">${amount(context, total - advance, row)}</td><td><button data-statement="${htmlText(row.entity_id)}">Estado de cuenta</button>${receivables ? `<button data-email-statement="${htmlText(row.entity_id)}">Enviar Estado de Cuenta</button>` : ''}</td></tr>`);
      for (const item of group.docs) body.push(`<tr hidden data-aging-parent="${htmlText(group.domId)}" class="aging-child aging-aligned"><td class="aging-document"><b>${html(item.document_number)}</b><small>Emisión ${html(item.issue_date)} · Vence ${html(item.due_date)} · ${Number(item.overdue_days || 0)} días</small></td><td><span class="aging-currency-badge">${html(currencyMeta(context, item).code || '—')}</span></td>${buckets.map(bucket => `<td class="number aging-${bucket.toLowerCase()}">${amount(context, item.bucket === bucket ? item.pending : 0, item)}</td>`).join('')}<td class="number">${amount(context, item.pending, item)}</td><td class="number">${amount(context, 0, item)}</td><td class="number">${amount(context, item.pending, item)}</td><td><a class="ledger-link" href="${receivables ? '/sales-invoice-view.html' : '/supplier-invoice-view.html'}?id=${encodeURIComponent(item.document_id)}">Ver</a> <button class="account-drill" data-aging-app="${htmlText(item.document_id)}">Aplicaciones</button></td></tr>`);
    }
    context.elements.tbody.innerHTML = body.join('') || '<tr><td colspan="12">No existen saldos pendientes para la fecha de corte.</td></tr>';
    document.querySelectorAll('[data-aging-toggle]').forEach(button => button.onclick = () => {
      const children = [...document.querySelectorAll(`[data-aging-parent="${button.dataset.agingToggle}"]`)];
      const show = children.every(child => child.hidden);
      children.forEach(child => child.hidden = !show);
      button.textContent = show ? '−' : '+';
    });
    if (context.data.consolidated) document.querySelectorAll('[data-statement],[data-email-statement]').forEach(button => button.remove());
  }

  document.querySelectorAll('[data-journal]').forEach(button => button.onclick = () => button.dataset.journal && context.openJournal(button.dataset.journal));
  document.querySelectorAll('[data-aging-app]').forEach(button => button.onclick = () => showApplications(context, rowsByDocument.get(String(button.dataset.agingApp))));
  renderSummary(context, receivables);
  context.renderPager();
}

function exportRows(context) {
  const receivables = context.reportKey === 'receivables-aging';
  return (context.data.rows || []).map(row => [
    row.identification || row.entity_code,
    row.entity_name,
    receivables ? row.manager || '' : row.entity_category || '',
    !receivables && row.external_document_number ? row.external_document_number : row.document_number,
    row.issue_date,
    row.due_date,
    Number(row.overdue_days || 0),
    currencyMeta(context, row).code,
    Number(row.original_amount || 0),
    Number(row.applied_amount || 0),
    Number(row.pending || 0),
    bucketNames[row.bucket] || row.bucket,
  ]);
}

function payableExportRows(context){
 const model=payableModel(context),rows=[],record=(kind,type,source,values={})=>[
  kind,type?.label||'',values.identification||'',values.entityName||'',values.document||'',values.issueDate||'',values.dueDate||'',values.overdueDays??'',currencyMeta(context,source).code,
  values.originalAmount??'',values.appliedAmount??'',values.pending??'',...buckets.map(bucket=>values.buckets?.[bucket]??''),values.advance??'',values.netBalance??'',
 ];
 for(const block of model.blocks){
  if(context.view==='DETAIL')for(const row of block.rows)rows.push(record('Documento',block.type,row,{identification:row.identification||row.entity_code,entityName:row.entity_name,document:row.external_document_number||row.document_number,issueDate:row.issue_date,dueDate:row.due_date,overdueDays:Number(row.overdue_days||0),originalAmount:Number(row.original_amount||0),appliedAmount:Number(row.applied_amount||0),pending:Number(row.pending||0),buckets:Object.fromEntries(buckets.map(bucket=>[bucket,row.bucket===bucket?Number(row.pending||0):0]))}));
  else for(const group of payableEntityGroups(context,block.rows))rows.push(record('Proveedor',block.type,group.row,{...group.total,identification:group.row.identification||group.row.entity_code,entityName:group.row.entity_name}));
  for(const total of block.totals)rows.push(record('Subtotal tipo',block.type,total.source,total));
 }
 for(const total of model.currencies)rows.push(record('Total documentos',null,total.source,total));
 for(const advance of payableAdvances(context))rows.push(record('Anticipo sin aplicar',null,advance,{identification:advance.entityCode,entityName:[advance.entityName,payableAdvanceCompany(context,advance)].filter(Boolean).join(' · '),advance:Number(advance.amount)}));
 const balanceLabel=context.data.summary?.typeFilterActive||context.data.summary?.unallocatedAdvancesExcluded?'Saldo de facturas del tipo':'Saldo neto general';
 if(originalMode(context))for(const item of agingCurrencyBreakdown(context))rows.push(record(balanceLabel,null,item.source,{pending:item.subledger,advance:item.advances,netBalance:item.netBalance}));
 else{const summary=context.data.summary||{};rows.push(record(balanceLabel,null,{}, {pending:Number(summary.subledger||0),advance:Number(summary.advances||0),netBalance:Number(summary.netBalance||0)}));}
 return rows;
}

export async function buildAgingExport(context,type){
 if(context.reportKey==='payables-aging'){
  const headers=['Registro','Tipo de factura','Identificación','Proveedor','Documento','Emisión','Vencimiento','Días de mora','Moneda','Monto original','Monto aplicado','Saldo pendiente',...buckets.map(bucket=>bucketNames[bucket]),'Anticipo sin aplicar','Saldo neto'],rows=payableExportRows(context),name=context.reportKey+'-'+context.cutoff;
  if(type==='csv')return{blob:new Blob(['\ufeff'+[headers,...rows].map(row=>row.map(value=>csvCell(value)).join(',')).join('\r\n')],{type:'text/csv'}),name:name+'.csv'};
  const breakdown=agingCurrencyBreakdown(context),extraSheets=originalMode(context)?[{headers:['Moneda','Auxiliar','Anticipos / sin aplicar','Saldo neto','Mayor','Diferencia'],rows:breakdown.map(item=>[currencyLabel(context,item.source),item.subledger,item.advances,item.netBalance,item.reconciliationAvailable?item.controlBalance:'No disponible',item.reconciliationAvailable?item.difference:'Filtro analítico'])}]:[];
  return{blob:await reportWorkbook({headers,rows,context:context.exportContext,title:context.reportTitle,extraSheets}),name:name+'.xlsx'};
 }
 const receivables=context.reportKey==='receivables-aging',headers=['Identificaci\u00f3n',receivables?'Cliente':'Proveedor',receivables?'Vendedor / Gestor':'Categor\u00eda','Documento','Emisi\u00f3n','Vencimiento','D\u00edas de mora','Moneda','Monto original','Monto aplicado','Saldo pendiente','Antig\u00fcedad'],rows=exportRows(context),name=context.reportKey+'-'+context.cutoff;
 if(type==='csv')return{blob:new Blob(['\ufeff'+[headers,...rows].map(row=>row.map(value=>csvCell(value)).join(',')).join('\r\n')],{type:'text/csv'}),name:name+'.csv'};
 const breakdown=agingCurrencyBreakdown(context),extraSheets=originalMode(context)?[{headers:['Moneda','Auxiliar','Anticipos / sin aplicar','Saldo neto','Mayor','Diferencia'],rows:breakdown.map(item=>[currencyLabel(context,item.source),item.subledger,item.advances,item.netBalance,item.reconciliationAvailable?item.controlBalance:'No disponible',item.reconciliationAvailable?item.difference:'Filtro anal\u00edtico'])}]:[];
 return{blob:await reportWorkbook({headers,rows,context:context.exportContext,title:context.reportTitle,extraSheets}),name:name+'.xlsx'};
}

export function agingPresentationLabel(currencyMode) {
  return String(currencyMode).toUpperCase() === 'ORIGINAL' ? 'monedas originales por documento' : '';
}
