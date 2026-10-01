const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=()=>localStorage.getItem('nexo_device_token')||'';
const state={options:{},report:{rows:[],summary:{},total:0,page:1,pageSize:50},page:1,selectedSuppliers:new Set(),expanded:new Set(),loading:false};
if(!token())location.assign('/');

function headers(hasBody=false){return{Authorization:`Bearer ${token()}`,'X-Device-Token':device(),...(hasBody?{'Content-Type':'application/json'}:{})}}
async function api(path,init={}){
  const response=await fetch(path,{...init,headers:{...headers(Boolean(init.body)),...(init.headers||{})}});
  const text=await response.text();let payload=null;try{payload=text?JSON.parse(text):null}catch{payload=text}
  if(!response.ok)throw Error(payload?.error?.message||payload?.message||'No fue posible completar la operación.');
  return payload;
}
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>Number(value||0);
const fmt=value=>number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const money=(value,symbol='',currency='')=>`${symbol||currency||''} ${fmt(value)}`.trim();
const date=value=>{if(!value)return'—';const parsed=new Date(`${String(value).slice(0,10)}T12:00:00`);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleDateString('es-CR',{day:'2-digit',month:'short',year:'numeric'})};
const month=value=>{const parsed=new Date(`${value}-01T12:00:00`);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleDateString('es-CR',{month:'long',year:'numeric'})};
const typeClass=type=>type==='PAYMENT'?'payment':type==='CREDIT_NOTE'?'credit':'mixed';
const typeGroupLabel=type=>type==='PAYMENT'?'Liquidaciones con pagos a proveedor':type==='CREDIT_NOTE'?'Aplicaciones de Notas de Crédito':'Liquidaciones Mixtas';

function setLoading(value,label='Generar reporte'){
  state.loading=value;document.body.classList.toggle('loading',value);
  $('generate').disabled=value;$('downloadPdf').disabled=value;$('downloadExcel').disabled=value;
  $('generate').textContent=value?'Generando…':label;
}
function showMessage(text='',success=false){$('message').textContent=text;$('message').classList.toggle('success',success)}
function filters(){return{periodMonth:$('periodMonth').value,supplierIds:[...state.selectedSuppliers].map(Number),settlementType:$('settlementType').value,groupBySettlementType:$('groupBySettlementType').checked,page:state.page,pageSize:Number($('pageSize').value)}}

function renderSuppliers(){
  const rows=state.options.suppliers||[];
  $('supplierOptions').innerHTML=rows.map(item=>`<label><input type="checkbox" value="${esc(item.id)}" ${state.selectedSuppliers.has(String(item.id))?'checked':''}><span>${esc(item.name)}</span>${item.number?`<small>${esc(item.number)}</small>`:''}</label>`).join('')||'<div class="seller-empty">No hay proveedores registrados para esta empresa.</div>';
  $('supplierOptions').querySelectorAll('input').forEach(input=>input.onchange=()=>{input.checked?state.selectedSuppliers.add(String(input.value)):state.selectedSuppliers.delete(String(input.value));renderSupplierSummary()});
  renderSupplierSummary();
}
function renderSupplierSummary(){
  const count=state.selectedSuppliers.size,rows=state.options.suppliers||[];
  $('supplierSummary').textContent=!count?'Todos los proveedores':count===1?rows.find(item=>state.selectedSuppliers.has(String(item.id)))?.name||'1 proveedor':`${count} proveedores seleccionados`;
  $('clearSuppliers').disabled=!count;
}
$('clearSuppliers').onclick=event=>{event.preventDefault();state.selectedSuppliers.clear();renderSuppliers()};

function renderSummary(){
  const summary=state.report.summary||{},header=state.report.header||{},symbol=header.symbol||state.options.subsidiary?.symbol||'',currency=header.currency||state.options.subsidiary?.currency||'';
  const payments=number(summary.paymentAppliedAmount),cash=number(summary.cashAmount),advances=number(summary.advanceAmount),withholdings=number(summary.withholdingAmount);
  const other=summary.otherFundingAmount==null?Math.max(0,payments-cash-advances-withholdings):number(summary.otherFundingAmount);
  const credits=number(summary.creditNoteAmount),debits=number(summary.debitNoteAmount);
  const net=summary.netAppliedAmount==null?payments+credits-debits:number(summary.netAppliedAmount),exchangeDifference=number(summary.exchangeDifferenceAmount);
  const invoiceWithholding=number(summary.invoiceWithholdingAmount),payable=number(summary.payableAmount??number(summary.invoiceAmount)-invoiceWithholding),settlementBase=number(summary.settlementBaseAmount??payable+debits);
  const overCount=number(summary.overappliedCount),overAmount=number(summary.overappliedAmount);
  const funding=[
    ['Caja / Banco',cash,'cash','Salida efectiva desde cuentas bancarias o caja.'],
    ['Anticipos aplicados',advances,'advance','Saldo entregado previamente al proveedor aplicado a la factura.'],
    ['Retenciones al pagar',withholdings,'withholding','Impuestos retenidos al aplicar el pago que reducen la salida al proveedor.'],
    ['Otros medios',other,'other','Parte del pago pendiente de clasificar en banco, anticipos o retenciones.']
  ];
  $('summary').innerHTML=`<div class="summary-overview">
    <article class="metric"><small>Facturas liquidadas</small><b>${esc(number(summary.invoiceCount).toLocaleString('es-CR'))}</b></article>
    <article class="metric"><small>Total facturado · ${esc(currency)}</small><b>${esc(money(summary.invoiceAmount,symbol,currency))}</b></article>
    <article class="metric base"><small>Base a liquidar · ${esc(currency)}</small><b>${esc(money(settlementBase,symbol,currency))}</b><span>Factura ${esc(money(summary.invoiceAmount,symbol,currency))} − retención en origen ${esc(money(invoiceWithholding,symbol,currency))} + ND ${esc(money(debits,symbol,currency))}</span></article>
    <article class="metric dpo"><small>Días promedio para pagar</small><b>${esc(number(summary.averageDpo).toLocaleString('es-CR',{maximumFractionDigits:1}))} días</b></article>
  </div>
  <article class="reconciliation-card" aria-label="Conciliación de la liquidación">
    <header><div><b>Conciliación de la liquidación</b><small>Cómo los movimientos dejaron la cuenta por pagar en cero.</small></div><span class="formula-label">Pagos + NC − ND = aplicación neta</span></header>
    <div class="equation">
      <div class="equation-value payment"><small>Pagos aplicados</small><b>${esc(money(payments,symbol,currency))}</b></div>
      <span class="operator" aria-hidden="true">+</span>
      <div class="equation-value credit"><small>Notas de crédito</small><b>${esc(money(credits,symbol,currency))}</b></div>
      <span class="operator" aria-hidden="true">−</span>
      <div class="equation-value debit"><small>Notas de débito</small><b>${esc(money(debits,symbol,currency))}</b></div>
      <span class="operator equals" aria-hidden="true">=</span>
      <div class="equation-value net"><small>Aplicación neta</small><b>${esc(money(net,symbol,currency))}</b><span>CxP ${esc(money(payable,symbol,currency))} · Dif. cambiaria ${esc(money(exchangeDifference,symbol,currency))}${overAmount?` · Exceso ${esc(money(overAmount,symbol,currency))}`:' · Conciliado'}</span></div>
    </div>
  </article>
  <article class="funding-card" aria-label="Composición de los pagos aplicados">
    <header><div><b>Composición de los pagos aplicados</b><small>Cada pago puede combinar efectivo, anticipos y retenciones.</small></div><div class="funding-total"><small>Total pagos</small><b>${esc(money(payments,symbol,currency))}</b></div></header>
    <div class="funding-grid">${funding.map(([label,value,kind,help])=>`<div class="funding-item ${kind}"><span class="funding-dot" aria-hidden="true"></span><div><small>${esc(label)}</small><b>${esc(money(value,symbol,currency))}</b><span>${esc(help)}</span></div></div>`).join('')}</div>
  </article>`;
  $('overappliedWarning').hidden=!overCount&&!overAmount;
  $('overappliedWarning').innerHTML=overCount||overAmount?`<b>Revisión requerida:</b> ${overCount} factura${overCount===1?' presenta':'s presentan'} una sobreaplicación${overAmount?` por ${esc(money(overAmount,symbol,currency))}`:''}. La aplicación neta excede el saldo que debía liquidarse; revise pagos, notas de crédito y notas de débito.`:'';
}

function paymentBreakdown(source){
  const payment=number(source.paymentAmount??(source.type==='PAYMENT'?source.amount:0)),cash=number(source.cashAmount),advance=number(source.advanceAmount),withholding=number(source.withholdingAmount);
  const other=source.otherFundingAmount==null?Math.max(0,payment-cash-advance-withholding):number(source.otherFundingAmount);
  return{payment,cash,advance,withholding,other};
}
function fundingAmount(value,row){return number(value)?esc(money(value,row.symbol,row.currency)):'—'}
function applicationTable(row){
  const items=row.applications||[];
  return`<div class="application-panel"><header><div><b>Movimientos que afectan el saldo</b><small>El desglose identifica el pago bancario, los anticipos, las retenciones y otros medios.</small></div><span>${items.length} movimiento${items.length===1?'':'s'}</span></header><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Movimiento</th><th>Documento</th><th>Referencia bancaria</th><th>Medio</th><th class="number">Impacto en saldo</th><th class="number funding-column cash-column">Caja/Banco</th><th class="number funding-column advance-column">Anticipos</th><th class="number funding-column withholding-column">Retenciones al pagar</th><th class="number funding-column other-column">Otros</th></tr></thead><tbody>${items.map(item=>{const parts=paymentBreakdown(item),isPayment=item.type==='PAYMENT';return`<tr><td>${esc(date(item.date))}</td><td><span class="movement-type ${esc(item.type)}">${esc(item.typeLabel)}</span></td><td>${esc(item.reference||'—')}</td><td>${esc(item.secondaryReference||'—')}</td><td>${esc(item.method||'—')}</td><td class="number movement-amount ${number(item.amount)<0?'negative':''}">${esc(money(item.amount,row.symbol,row.currency))}</td><td class="number funding-column cash-column">${isPayment?fundingAmount(parts.cash,row):'—'}</td><td class="number funding-column advance-column">${isPayment?fundingAmount(parts.advance,row):'—'}</td><td class="number funding-column withholding-column">${isPayment?fundingAmount(parts.withholding,row):'—'}</td><td class="number funding-column other-column">${isPayment?fundingAmount(parts.other,row):'—'}</td></tr>`}).join('')}</tbody></table></div></div>`;
}
function invoiceRows(rows){return rows.map(row=>{
  const open=state.expanded.has(String(row.invoiceId));
  const payments=number(row.paymentAmount),credits=number(row.creditNoteAmount),debits=number(row.debitNoteAmount),net=row.netAppliedAmount==null?payments+credits-debits:number(row.netAppliedAmount),over=number(row.overappliedAmount),parts=paymentBreakdown(row);
  const sourceNote=`<span class="cell-note reconciliation-note">Pagos ${esc(money(payments,row.symbol,row.currency))} · NC ${esc(money(credits,row.symbol,row.currency))} · ND −${esc(money(debits,row.symbol,row.currency))}</span>`;
  const fundingNote=payments?`<span class="cell-note funding-note">Banco ${esc(money(parts.cash,row.symbol,row.currency))} · Anticipos ${esc(money(parts.advance,row.symbol,row.currency))} · Ret. ${esc(money(parts.withholding,row.symbol,row.currency))}${parts.other?` · Otros ${esc(money(parts.other,row.symbol,row.currency))}`:''}</span>`:'';
  const header=state.report.header||{},fx=number(row.exchangeDifferenceAmount);
  return`<tr class="invoice-record ${over>0?'has-overapplication':''}"><td><button class="expand-button" type="button" data-expand="${esc(row.invoiceId)}" aria-expanded="${open}" title="${open?'Ocultar':'Ver'} movimientos">${open?'−':'+'}</button></td><td><span class="invoice-number">${esc(row.invoiceNumber)}</span>${over>0?'<span class="row-alert">Sobreaplicada</span>':''}</td><td><span class="supplier-name">${esc(row.supplierName)}</span><span class="cell-note">${esc(row.supplierTaxId||row.supplierNumber||'Sin identificación fiscal')}</span></td><td>${esc(date(row.issueDate))}<span class="cell-note">Vence ${esc(date(row.dueDate))}</span></td><td class="number">${esc(money(row.invoiceAmount,row.symbol,row.currency))}<span class="cell-note">Moneda ${esc(row.currency)} · TC factura ${esc(fmt(row.exchangeRate||1))}</span><span class="cell-note">CxP ${esc(money(row.payableAmount,row.symbol,row.currency))}${number(row.invoiceWithholdingAmount)?` · Ret. origen −${esc(money(row.invoiceWithholdingAmount,row.symbol,row.currency))}`:''}</span></td><td>${esc(date(row.settlementDate))}</td><td><span class="settlement-badge ${typeClass(row.settlementType)}">${esc(row.settlementTypeLabel)}</span></td><td class="reference-cell">${esc(row.settlementReferences)}</td><td class="number net-cell"><b>${esc(money(net,row.symbol,row.currency))}</b>${sourceNote}${fundingNote}${fx?`<span class="cell-note">Dif. cambiaria local: ${esc(money(fx,header.symbol,header.currency))}</span>`:''}${over>0?`<span class="cell-note over-note">Exceso: ${esc(money(over,row.symbol,row.currency))}</span>`:''}</td><td class="number">${number(row.daysToPay).toLocaleString('es-CR')}</td></tr><tr class="application-row" ${open?'':'hidden'}><td colspan="10">${applicationTable(row)}</td></tr>`;
}).join('')}
function table(items){return`<div class="table-wrap"><table><thead><tr><th aria-label="Detalle"></th><th>N.º factura</th><th>Proveedor</th><th>Emisión / vencimiento</th><th class="number">Total factura</th><th>Liquidación</th><th>Tipo</th><th>Documentos</th><th class="number">Aplicación neta</th><th class="number">DPO</th></tr></thead><tbody>${invoiceRows(items)}</tbody></table></div>`}
function renderRows(){
  const rows=state.report.rows||[],grouped=$('groupBySettlementType').checked;
  if(!rows.length){$('reportGroups').innerHTML='<div class="empty-state"><span aria-hidden="true">✓</span><b>No hay facturas de proveedor liquidadas con estos filtros</b><small>Pruebe otro mes, proveedor o tipo de liquidación.</small></div>';return}
  if(!grouped){$('reportGroups').innerHTML=table(rows)}else{
    const groups=['PAYMENT','CREDIT_NOTE','MIXED'].map(type=>[type,rows.filter(row=>row.settlementType===type)]).filter(([,items])=>items.length);
    $('reportGroups').innerHTML=groups.map(([type,items])=>`<section class="group-section ${typeClass(type)}"><div class="group-heading"><div><span class="group-dot"></span><b>${esc(typeGroupLabel(type))}</b></div><span>${items.length} factura${items.length===1?'':'s'}</span></div>${table(items)}</section>`).join('');
  }
  $('reportGroups').querySelectorAll('[data-expand]').forEach(button=>button.onclick=()=>{const id=String(button.dataset.expand);state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);renderRows()});
}
function renderPager(){const total=number(state.report.total),size=Number($('pageSize').value),pages=Math.max(1,Math.ceil(total/size));$('resultCount').textContent=`${total.toLocaleString('es-CR')} registro${total===1?'':'s'}`;$('pageCaption').textContent=`Página ${state.page} de ${pages}`;$('previousPage').disabled=state.page<=1;$('nextPage').disabled=state.page>=pages}
function render(){const period=state.report.header?.periodMonth||$('periodMonth').value,currency=state.report.header?.currency||state.options.subsidiary?.currency||'';$('periodCaption').textContent=period?`Liquidaciones de ${month(period)}. Resumen en ${currency}; detalle en moneda original.`:'Seleccione el mes a consultar.';renderSummary();renderRows();renderPager()}

async function run(){
  if(!$('periodMonth').value)return showMessage('Seleccione el mes de liquidación.');
  setLoading(true);showMessage('');
  try{state.report=await api('/api/v1/reports/purchases/settled-invoices',{method:'POST',body:JSON.stringify(filters())});state.expanded.clear();render()}
  catch(error){showMessage(error.message)}finally{setLoading(false)}
}
$('filters').onsubmit=event=>{event.preventDefault();$('supplierPicker').open=false;state.page=1;run()};
$('pageSize').onchange=()=>{state.page=1;run()};
$('previousPage').onclick=()=>{if(state.page>1){state.page--;run()}};
$('nextPage').onclick=()=>{const pages=Math.ceil(number(state.report.total)/Number($('pageSize').value));if(state.page<pages){state.page++;run()}};
$('groupBySettlementType').onchange=()=>renderRows();

function filename(response,fallback){const disposition=response.headers.get('Content-Disposition')||'',encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i),plain=disposition.match(/filename="?([^";]+)"?/i);try{return encoded?decodeURIComponent(encoded[1]):plain?.[1]||fallback}catch{return fallback}}
function save(blob,name){const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
async function exportReport(format){
  const button=format==='pdf'?$('downloadPdf'):$('downloadExcel'),label=button.innerHTML;setLoading(true);button.innerHTML='Preparando descarga…';showMessage('');
  try{const response=await fetch(`/api/v1/reports/purchases/settled-invoices/${format}`,{method:'POST',headers:headers(true),body:JSON.stringify(filters())});if(!response.ok){const text=await response.text();let data={};try{data=JSON.parse(text)}catch{}throw Error(data?.error?.message||data?.message||'No fue posible preparar la descarga.')}const blob=await response.blob();save(blob,filename(response,`facturas-proveedor-liquidadas-${$('periodMonth').value}.${format==='pdf'?'pdf':'xlsx'}`));showMessage('La descarga se generó correctamente.',true)}catch(error){showMessage(error.message)}finally{setLoading(false);button.innerHTML=label}
}
$('downloadPdf').onclick=()=>exportReport('pdf');
$('downloadExcel').onclick=()=>exportReport('excel');

async function init(){
  const now=new Date(),local=new Date(now.getTime()-now.getTimezoneOffset()*60000);$('periodMonth').value=local.toISOString().slice(0,7);
  setLoading(true);
  try{state.options=await api('/api/v1/reports/purchases/settled-invoices/options');if(!state.options?.subsidiary)throw Error('No se encontró una empresa activa autorizada.');$('subsidiary').value=state.options.subsidiary.name;renderSuppliers();await run()}
  catch(error){showMessage(error.message);$('reportGroups').innerHTML=`<div class="empty-state"><span aria-hidden="true">!</span><b>No fue posible cargar el reporte</b><small>${esc(error.message)}</small></div>`}finally{setLoading(false)}
}
init();
