const $=id=>document.getElementById(id);
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token');
const money=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=value=>String(value??'—').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let data,editing=null,existingAdvances=[];

async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device||'','Content-Type':'application/json'}});
  const result=await response.json();
  if(!response.ok)throw Error(result?.error?.message||result?.message||'No fue posible procesar el cobro.');
  return result;
}
const option=(rows,id,label,empty)=>`<option value="">${empty}</option>`+rows.map(row=>`<option value="${row[id]}">${esc(label(row))}</option>`).join('');
function currencies(){
  const rows=[...(data.accounts||[]),...(data.invoices||[]),...(data.advances||[])];
  const values=new Map();
  for(const row of rows){const key=String(row.currencyId),name=row.currency||row.currencyCode;const current=values.get(key);if(!current||name)values.set(key,{id:row.currencyId,name:name||current?.name||`Moneda ${row.currencyId}`});}
  return [...values.values()];
}
async function options(paymentId=null){
  const base='/api/sales/customer-payments/options';
  data=await api(paymentId?`${base}?paymentId=${encodeURIComponent(paymentId)}`:base);
  $('subsidiary').value=data.subsidiary.name;$('location').value=data.location?.id||'';$('locationName').value=data.location?.name||'Sin ubicación';
  $('customer').innerHTML=option(data.customers,'id',row=>row.name,'Seleccione un cliente');
  $('currency').innerHTML=option(currencies(),'id',row=>row.name,'Seleccione una moneda');
}
function period(){const date=$('date').value,current=data.periods.find(row=>date>=row.start&&date<=row.end);$('period').value=current?.id||'';$('periodName').value=current?.name||'Sin período abierto';}
function refreshAccounts(selected=''){
  const rows=data.accounts.filter(row=>String(row.currencyId)===$('currency').value);
  $('account').innerHTML=option(rows,'id',row=>`${row.bank} · ${row.number} · ${row.currency}`,'Seleccione una cuenta bancaria en esta moneda');
  if(rows.some(row=>String(row.id)===String(selected)))$('account').value=String(selected);
}
function selectedInvoices(){return [...$('invoiceRows').querySelectorAll('.apply')].filter(input=>Number(input.value)>0).map(input=>({invoice_id:input.dataset.id,amount:Number(input.value)}));}
function selectedAdvances(){return [...$('advanceRows').querySelectorAll('.advance-apply')].filter(input=>Number(input.value)>0).map(input=>({advanceLineId:input.dataset.id,amount:Number(input.value)}));}
function total(){
  const invoiceTotal=selectedInvoices().reduce((sum,row)=>sum+row.amount,0),advanceTotal=selectedAdvances().reduce((sum,row)=>sum+row.amount,0),cash=invoiceTotal-advanceTotal;
  $('total').textContent=money(invoiceTotal);$('advanceTotal').textContent=money(advanceTotal);$('cashTotal').textContent=money(Math.max(cash,0));
  $('save').disabled=advanceTotal>invoiceTotal||invoiceTotal<=0;
  $('advanceRows').querySelectorAll('.advance-apply').forEach(input=>input.setCustomValidity(advanceTotal>invoiceTotal?'Los anticipos no pueden superar el total de facturas.':''));
}
function invoices(existing=[]){
  const rows=data.invoices.filter(row=>String(row.customerId)===$('customer').value&&String(row.currencyId)===$('currency').value),known=new Set(rows.map(row=>String(row.id))),currency=$('currency').selectedOptions[0]?.textContent||'';
  const historical=existing.filter(item=>!known.has(String(item.invoice_id))).map(item=>({id:item.invoice_id,number:item.invoiceNumber||`Factura ${item.invoice_id}`,date:item.invoiceDate||'—',dueDate:item.invoiceDueDate||'—',currency:item.invoiceCurrency||currency,balance:0,currentApplied:item.amount,editableBalance:item.amount}));
  $('invoiceRows').innerHTML=[...historical,...rows].map(row=>{const old=existing.find(item=>String(item.invoice_id)===String(row.id)),lock=null,blocked=Boolean(lock)&&!old,fallbackMax=Number(row.balance||0)+Number(old?.amount||0),editableBalance=Number(row.editableBalance),max=editing&&Number.isFinite(editableBalance)?editableBalance:fallbackMax,applied=Number(old?.amount??row.currentApplied??0),overApplied=Boolean(old)&&applied>max+.000001;return `<tr class="${blocked?'payment-request-locked':''}${overApplied?' application-over-balance':''}"><td><input type="checkbox" data-check ${applied>0?'checked':''} ${blocked?'disabled':''}></td><td><b>${esc(row.number)}</b>${overApplied?`<small class="application-warning">Aplicado actual: ${money(applied)} · Máximo permitido: ${money(max)}. Reduzca el importe para poder guardar la corrección.</small>`:''}${blocked?`<small class="request-lock"><b>${esc(lock.requestNumber)}</b> · ${esc(lock.status.replaceAll('_',' '))}</small>`:''}</td><td>${esc(row.date)}</td><td>${esc(row.dueDate)}</td><td>${esc(row.currency)}</td><td class="num">${money(max)}</td><td class="num">${blocked?'<span class="lock-label">Gestionar en Tesorería</span>':`<input class="apply" data-id="${row.id}" data-max="${max}" type="number" min="0" max="${max}" step="0.01" value="${applied}">`}</td></tr>`;}).join('')||'<tr><td colspan="7">No hay facturas pendientes para este cliente y moneda.</td></tr>';
  $('invoiceRows').querySelectorAll('[data-check]:not(:disabled)').forEach(check=>check.onchange=()=>{const input=check.closest('tr').querySelector('.apply');input.value=check.checked?input.dataset.max:0;total();});
  $('invoiceRows').querySelectorAll('.apply').forEach(input=>input.oninput=()=>{input.closest('tr').querySelector('[data-check]').checked=Number(input.value)>0;input.setCustomValidity(Number(input.value)>Number(input.dataset.max)?`Máximo ${money(input.dataset.max)}`:'');total();});
  $('invoiceRows').querySelectorAll('.apply').forEach(input=>input.setCustomValidity(Number(input.value)>Number(input.dataset.max)?`El importe aplicado supera el saldo editable de ${money(input.dataset.max)}.`:''));
  total();
}
function advances(existing=[]){
  const rows=(data.advances||[]).filter(row=>String(row.customerId)===$('customer').value&&String(row.currencyId)===$('currency').value);
  const available=rows.reduce((sum,row)=>sum+Number(row.available||0),0);$('advanceAvailable').textContent=`Disponible: ${money(available)}`;
  $('advanceRows').innerHTML=rows.map(row=>{const old=existing.find(item=>String(item.sourceLineId)===String(row.id)),max=Number(row.available)+Number(old?.amount||0);return `<tr><td><input type="checkbox" data-advance-check ${old?'checked':''}></td><td><b>${esc(row.number)}</b></td><td>${esc(String(row.date).slice(0,10))}</td><td>${esc(row.account)}</td><td class="num available-advance">${money(max)}</td><td class="num"><input class="advance-apply" data-id="${row.id}" data-max="${max}" type="number" min="0" max="${max}" step="0.01" value="${old?.amount||0}"></td></tr>`;}).join('')||'<tr><td colspan="6">Este cliente no tiene anticipos disponibles en la moneda seleccionada.</td></tr>';
  $('advanceRows').querySelectorAll('[data-advance-check]').forEach(check=>check.onchange=()=>{const input=check.closest('tr').querySelector('.advance-apply');input.value=check.checked?Math.min(Number(input.dataset.max),selectedInvoices().reduce((sum,row)=>sum+row.amount,0)):0;total();});
  $('advanceRows').querySelectorAll('.advance-apply').forEach(input=>input.oninput=()=>{input.closest('tr').querySelector('[data-advance-check]').checked=Number(input.value)>0;input.setCustomValidity(Number(input.value)>Number(input.dataset.max)?`Máximo ${money(input.dataset.max)}`:'');total();});
  total();
}
function refreshDocuments(applications=[],advanceApplications=[]){invoices(applications);advances(advanceApplications);}
async function open(id=null){
  try{window.NexoRecordAudit.show('customer_payment',id,'#entry');editing=id;$('entry').reset();$('entryMode').textContent=id?'EDITAR · COB_CLI':'NUEVO · COB_CLI';$('entryTitle').textContent='Cobro a cliente';$('invoicesTitle').textContent=id?'Facturas aplicadas y pendientes':'Facturas pendientes';$('invoicesHelp').textContent=id?'El saldo disponible excluye el importe ya aplicado por este cobro.':'Se muestran únicamente las facturas del cliente en la moneda seleccionada.';$('balanceHeading').textContent=id?'Saldo disponible para este cobro':'Saldo pendiente';$('save').textContent=id?'Guardar cambios':'Guardar y contabilizar';existingAdvances=[];
    const detailRequest=id?api(`/api/sales/customer-payments/${id}`):null;await options(id);$('subsidiary').value=data.subsidiary.name;$('location').value=data.location?.id||'';$('locationName').value=data.location?.name||'';$('date').value=new Date().toLocaleDateString('en-CA');period();
    if(id){const detail=await detailRequest,header=detail.header;existingAdvances=detail.advances||[];$('entryTitle').textContent=`Cobro a cliente · ${header.payment_number||id}`;$('customer').value=header.customer_id;$('currency').value=header.currency_id;refreshAccounts(header.bank_account_id);$('date').value=String(header.payment_date).slice(0,10);period();$('rate').value=header.exchange_rate;$('reference').value=header.bank_reference;$('memo').value=header.memo;refreshDocuments(detail.applications||[],existingAdvances);}
    else{$('currency').value=String(data.subsidiary.currencyId);if(!$('currency').value&&currencies().length)$('currency').value=String(currencies()[0].id);refreshAccounts();$('rate').value=1;$('invoiceRows').innerHTML='';$('advanceRows').innerHTML='';$('advanceAvailable').textContent='';total();}
    $('modal').hidden=false;
  }catch(error){editing=null;$('message').textContent=error.message;}
}
async function load(){
  try{const report=await api('/api/sales/customer-payments/report',{method:'POST',body:JSON.stringify({from:$('from').value,to:$('to').value})}),query=$('search').value.toLowerCase(),rows=report.rows.filter(row=>`${row.number} ${row.customer} ${row.reference}`.toLowerCase().includes(query));$('count').textContent=`${rows.length} registros`;
    $('rows').innerHTML=rows.map(row=>{const active=!['ANULADO','CANCELADO'].includes(String(row.status||'APROBADO').toUpperCase());return `<tr><td>${row.date}</td><td><b>${row.number}</b>${Number(row.advanceTotal)>0?`<small class="advance-badge">Anticipo: ${money(row.advanceTotal)}</small>`:''}</td><td>${row.customer}</td><td>${row.bank} · ${row.account}</td><td>${row.reference}</td><td>${row.currency}</td><td class="num"><b>${money(row.amount)}</b></td><td><div class="row-actions"><button data-view="${row.id}">Ver</button>${active&&Number(row.advanceTotal)<=0?`<button data-edit="${row.id}">Editar</button><button class="delete" data-delete="${row.id}">Eliminar</button>`:''}</div></td></tr>`;}).join('')||'<tr><td colspan="8">No se encontraron cobros.</td></tr>';
    document.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>open(button.dataset.edit));document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>location.href=`/customer-payment-view.html?id=${button.dataset.view}`);document.querySelectorAll('[data-delete]').forEach(button=>button.onclick=async()=>{if(confirm('¿Eliminar este cobro y revertir la entrada bancaria?')){await api(`/api/sales/customer-payments/${button.dataset.delete}`,{method:'DELETE'});load();}});
  }catch(error){$('message').textContent=error.message;}
}
$('new').onclick=()=>open();$('close').onclick=$('cancel').onclick=()=>$('modal').hidden=true;$('date').onchange=period;
$('customer').onchange=()=>refreshDocuments();$('currency').onchange=()=>{refreshAccounts();refreshDocuments();$('rate').value=String($('currency').value)===String(data.subsidiary.currencyId)?1:'';};
$('entry').onsubmit=async event=>{event.preventDefault();try{const applications=selectedInvoices(),advanceApplications=selectedAdvances();$('save').disabled=true;$('save').textContent='Procesando…';const payload={customer_id:$('customer').value,account_id:$('account').value,date:$('date').value,period_id:$('period').value,location_id:$('location').value,rate:$('rate').value,reference:$('reference').value,memo:$('memo').value,applications,advances:advanceApplications},result=await api(editing?`/api/sales/customer-payments/${editing}`:'/api/sales/customer-payments/save',{method:editing?'PUT':'POST',body:JSON.stringify(payload)});$('modal').hidden=true;$('message').textContent=`${result.number} registrado. Facturas: ${money(result.grossTotal||result.total)} · Anticipos: ${money(result.advanceTotal)} · Banco: ${money(result.cashTotal??result.total)}`;await options();await load();}catch(error){alert(error.message);}finally{$('save').disabled=false;$('save').textContent=editing?'Guardar cambios':'Guardar y contabilizar';}};
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(item=>item.classList.toggle('active',item===button));for(const id of['applications','impact','supports'])$(id).hidden=id!==button.dataset.tab;});
const now=new Date(),first=new Date(now.getFullYear(),now.getMonth(),1);$('from').value=first.toLocaleDateString('en-CA');$('to').value=now.toLocaleDateString('en-CA');await options();await load();



