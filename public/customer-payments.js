const $=id=>document.getElementById(id);
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token');
const money=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const rounded=value=>Math.round((Number(value||0)+Number.EPSILON)*100)/100;
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
  const feeAccount=data.bankFeeAccount;
  $('bankFeeAccount').value=feeAccount?`${feeAccount.number} · ${feeAccount.name}`:'Cuenta no configurada para la subsidiaria';
}
function period(){const date=$('date').value,current=data.periods.find(row=>date>=row.start&&date<=row.end);$('period').value=current?.id||'';$('periodName').value=current?.name||'Sin período abierto';}
function exchangeRate(){
  const date=$('date').value,base=String(data?.subsidiary?.currencyId??''),selectedAccount=(data?.accounts||[]).find(row=>String(row.id)===String($('account').value)),from=String(selectedAccount?.currencyId??$('currency').value??'');
  if(!date||!from||!base)return null;
  if(from===base)return{value:1,date,inverse:false,local:true};
  const eligible=(data.rates||[]).filter(row=>String(row.date||'').slice(0,10)<=date),latest=(a,b)=>String(b.date).localeCompare(String(a.date));
  const direct=eligible.filter(row=>String(row.fromCurrencyId)===from&&String(row.toCurrencyId)===base&&Number(row.rate)>0).sort(latest)[0];
  if(direct)return{value:Number(direct.rate),date:String(direct.date).slice(0,10),inverse:false,local:false};
  const inverse=eligible.filter(row=>String(row.fromCurrencyId)===base&&String(row.toCurrencyId)===from&&Number(row.rate)>0).sort(latest)[0];
  return inverse?{value:1/Number(inverse.rate),date:String(inverse.date).slice(0,10),inverse:true,local:false}:null;
}
function syncExchangeRate(){
  const input=$('rate'),field=$('rateField'),help=$('rateHelp'),resolved=exchangeRate(),date=$('date').value,currency=$('currency').selectedOptions[0]?.textContent?.trim()||'la moneda seleccionada';
  const displayDate=value=>{const [year,month,day]=String(value||'').slice(0,10).split('-');return year&&month&&day?`${day}/${month}/${year}`:String(value||'');};
  field.classList.remove('rate-ready','rate-fallback','rate-missing');
  if(resolved?.value>0){
    input.value=String(Number(resolved.value.toFixed(10)));input.setCustomValidity('');
    const usesPrevious=!resolved.local&&resolved.date!==date;
    field.classList.add(usesPrevious?'rate-fallback':'rate-ready');
    help.textContent=resolved.local?'Moneda funcional de la subsidiaria: tasa 1.':usesPrevious?`No hay una tasa configurada para el ${displayDate(date)}. Se utiliza la anterior más cercana, del ${displayDate(resolved.date)}${resolved.inverse?' (calculada desde la cotización inversa)':''}.`:`Tasa configurada para el ${displayDate(resolved.date)}${resolved.inverse?' (calculada desde la cotización inversa)':''}.`;
  }else{
    input.value='';const message=!date?'Seleccione la fecha para calcular la tasa.':!$('currency').value?'Seleccione la moneda para calcular la tasa.':`No existe un tipo de cambio para ${currency} en el ${displayDate(date)} ni en una fecha anterior.`;
    input.setCustomValidity(message);field.classList.add('rate-missing');help.textContent=message;
  }
  total();
}
function refreshAccounts(selected=''){
  const rows=data.accounts.filter(row=>String(row.currencyId)===$('currency').value);
  $('account').innerHTML=option(rows,'id',row=>`${row.bank} · ${row.number} · ${row.currency}`,'Seleccione una cuenta bancaria en esta moneda');
  if(rows.some(row=>String(row.id)===String(selected)))$('account').value=String(selected);
}
function selectedInvoices(){return [...$('invoiceRows').querySelectorAll('.apply')].filter(input=>Number(input.value)>0).map(input=>({invoice_id:input.dataset.id,amount:Number(input.value)}));}
function selectedAdvances(){return [...$('advanceRows').querySelectorAll('.advance-apply')].filter(input=>Number(input.value)>0).map(input=>({advanceLineId:input.dataset.id,amount:Number(input.value)}));}
function setBankFee(enabled,amount=0){$('bankFeeEnabled').checked=Boolean(enabled);$('bankFeeFields').hidden=!enabled;$('bankFeeAmount').required=Boolean(enabled);$('bankFeeAmount').value=enabled?String(rounded(amount)||''): '0';total();}
function total(){
  const invoiceTotal=rounded(selectedInvoices().reduce((sum,row)=>sum+row.amount,0)),advanceTotal=rounded(selectedAdvances().reduce((sum,row)=>sum+row.amount,0)),availableCash=rounded(invoiceTotal-advanceTotal),feeEnabled=$('bankFeeEnabled').checked,feeValue=Number($('bankFeeAmount').value),fee=feeEnabled&&Number.isFinite(feeValue)?rounded(feeValue):0,cash=rounded(availableCash-fee),feeAccount=data?.bankFeeAccount;
  let feeError='';if(feeEnabled&&feeValue<0)feeError='La comisión bancaria no puede ser negativa.';else if(feeEnabled&&fee>availableCash)feeError=`La comisión no puede superar el efectivo disponible de ${money(Math.max(availableCash,0))}.`;else if(feeEnabled&&fee>0&&!feeAccount?.id)feeError='Configure la cuenta de comisiones bancarias para la subsidiaria antes de continuar.';
  $('bankFeeAmount').setCustomValidity(feeError);$('bankFeePreview').classList.toggle('invalid',Boolean(feeError));$('bankFeePreview').querySelector('b').textContent=money(Math.max(fee,0));
  $('total').textContent=money(invoiceTotal);$('advanceTotal').textContent=money(advanceTotal);$('bankFeeTotal').textContent=money(Math.max(fee,0));$('bankFeeTotalItem').hidden=!feeEnabled;$('cashTotal').textContent=money(Math.max(cash,0));
  $('impactReceivable').textContent=`${money(invoiceTotal)} por el total aplicado a las facturas.`;$('impactAdvance').hidden=advanceTotal<=0;$('impactFee').hidden=fee<=0;$('impactFeeDetail').textContent=`${money(Math.max(fee,0))} en ${feeAccount?`${feeAccount.number} · ${feeAccount.name}`:'la cuenta de gastos pendiente de configurar'}.`;$('impactBank').textContent=`${money(Math.max(cash,0))} por el ingreso neto recibido.`;
  $('save').disabled=advanceTotal>invoiceTotal||invoiceTotal<=0||Boolean(feeError)||!(Number($('rate').value)>0);
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
  try{window.NexoRecordAudit.show('customer_payment',id,'#entry');editing=id;$('entry').reset();$('bankFeeFields').hidden=true;$('bankFeeAmount').required=false;$('entryMode').textContent=id?'EDITAR · COB_CLI':'NUEVO · COB_CLI';$('entryTitle').textContent='Cobro a cliente';$('invoicesTitle').textContent=id?'Facturas aplicadas y pendientes':'Facturas pendientes';$('invoicesHelp').textContent=id?'El saldo disponible excluye el importe ya aplicado por este cobro.':'Se muestran únicamente las facturas del cliente en la moneda seleccionada.';$('balanceHeading').textContent=id?'Saldo disponible para este cobro':'Saldo pendiente';$('save').textContent=id?'Guardar cambios':'Guardar y contabilizar';existingAdvances=[];
    const detailRequest=id?api(`/api/sales/customer-payments/${id}`):null;await options(id);$('subsidiary').value=data.subsidiary.name;$('location').value=data.location?.id||'';$('locationName').value=data.location?.name||'';$('date').value=new Date().toLocaleDateString('en-CA');period();
    if(id){const detail=await detailRequest,header=detail.header,bankFee=detail.bankFee||{},feeAmount=Number(bankFee.amount??bankFee.bank_fee_amount??header.bank_fee_amount??0);existingAdvances=detail.advances||[];$('entryTitle').textContent=`Cobro a cliente · ${header.payment_number||id}`;$('customer').value=header.customer_id;$('currency').value=header.currency_id;refreshAccounts(header.bank_account_id);$('date').value=String(header.payment_date).slice(0,10);period();syncExchangeRate();$('reference').value=header.bank_reference;$('memo').value=header.memo;refreshDocuments(detail.applications||[],existingAdvances);setBankFee(feeAmount>0,feeAmount);}
    else{$('currency').value=String(data.subsidiary.currencyId);if(!$('currency').value&&currencies().length)$('currency').value=String(currencies()[0].id);refreshAccounts();syncExchangeRate();$('invoiceRows').innerHTML='';$('advanceRows').innerHTML='';$('advanceAvailable').textContent='';setBankFee(false,0);}
    $('modal').hidden=false;
  }catch(error){editing=null;$('message').textContent=error.message;}
}
async function load(){
  try{const report=await api('/api/sales/customer-payments/report',{method:'POST',body:JSON.stringify({from:$('from').value,to:$('to').value})}),query=$('search').value.toLowerCase(),rows=report.rows.filter(row=>`${row.number} ${row.customer} ${row.reference}`.toLowerCase().includes(query));$('count').textContent=`${rows.length} registros`;
    $('rows').innerHTML=rows.map(row=>{const active=!['ANULADO','CANCELADO'].includes(String(row.status||'APROBADO').toUpperCase()),fee=Number(row.bankFeeTotal??row.bankFeeAmount??row.bank_fee_amount??0),bankNet=Number(row.cashNet??row.cashTotal??row.cash_total??Number(row.amount||0)-fee);return `<tr><td>${row.date}</td><td><b>${row.number}</b>${Number(row.advanceTotal)>0?`<small class="advance-badge">Anticipo: ${money(row.advanceTotal)}</small>`:''}${fee>0?`<small class="bank-fee-badge">Comisión: ${money(fee)} · Banco: ${money(bankNet)}</small>`:''}</td><td>${row.customer}</td><td>${row.bank} · ${row.account}</td><td>${row.reference}</td><td>${row.currency}</td><td class="num"><b>${money(row.grossTotal??row.amount)}</b></td><td><div class="row-actions"><button data-view="${row.id}">Ver</button>${active&&Number(row.advanceTotal)<=0?`<button data-edit="${row.id}">Editar</button><button class="delete" data-delete="${row.id}">Eliminar</button>`:''}</div></td></tr>`;}).join('')||'<tr><td colspan="8">No se encontraron cobros.</td></tr>';
    document.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>open(button.dataset.edit));document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>location.href=`/customer-payment-view.html?id=${button.dataset.view}`);document.querySelectorAll('[data-delete]').forEach(button=>button.onclick=async()=>{if(confirm('¿Eliminar este cobro y revertir la entrada bancaria?')){await api(`/api/sales/customer-payments/${button.dataset.delete}`,{method:'DELETE'});load();}});
  }catch(error){$('message').textContent=error.message;}
}
$('new').onclick=()=>open();$('close').onclick=$('cancel').onclick=()=>$('modal').hidden=true;$('date').onchange=()=>{period();syncExchangeRate();};
$('bankFeeEnabled').onchange=()=>{const enabled=$('bankFeeEnabled').checked;$('bankFeeFields').hidden=!enabled;$('bankFeeAmount').required=enabled;if(!enabled)$('bankFeeAmount').value='0';else if(Number($('bankFeeAmount').value)<=0)$('bankFeeAmount').value='';total();if(enabled)$('bankFeeAmount').focus();};$('bankFeeAmount').oninput=total;
$('customer').onchange=()=>refreshDocuments();$('currency').onchange=()=>{refreshAccounts();refreshDocuments();syncExchangeRate();};$('account').onchange=syncExchangeRate;
$('entry').onsubmit=async event=>{event.preventDefault();try{total();if(!$('entry').reportValidity())return;const applications=selectedInvoices(),advanceApplications=selectedAdvances(),bankFeeAmount=$('bankFeeEnabled').checked?rounded($('bankFeeAmount').value):0;$('save').disabled=true;$('save').textContent='Procesando…';const payload={customer_id:$('customer').value,account_id:$('account').value,date:$('date').value,period_id:$('period').value,location_id:$('location').value,rate:$('rate').value,reference:$('reference').value,memo:$('memo').value,bank_fee_amount:bankFeeAmount,applications,advances:advanceApplications},result=await api(editing?`/api/sales/customer-payments/${editing}`:'/api/sales/customer-payments/save',{method:editing?'PUT':'POST',body:JSON.stringify(payload)});$('modal').hidden=true;$('message').textContent=`${result.number} registrado. Facturas: ${money(result.grossTotal||result.total)} · Anticipos: ${money(result.advanceTotal)} · Comisión: ${money(result.bankFeeTotal??result.bankFeeAmount??bankFeeAmount)} · Banco: ${money(result.cashTotal??result.total)}`;await options();await load();}catch(error){alert(error.message);}finally{$('save').textContent=editing?'Guardar cambios':'Guardar y contabilizar';total();}};
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(item=>item.classList.toggle('active',item===button));for(const id of['applications','impact','supports'])$(id).hidden=id!==button.dataset.tab;});
const now=new Date(),first=new Date(now.getFullYear(),now.getMonth(),1);$('from').value=first.toLocaleDateString('en-CA');$('to').value=now.toLocaleDateString('en-CA');await options();await load();



