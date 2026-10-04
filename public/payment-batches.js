const $=id=>document.getElementById(id);
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token')||'';
const device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'';
if(!token)location.replace('/');

const API='/api/treasury/payment-batches';
const state={
  options:{accounts:[],formats:[],currencies:[],suppliers:[]},
  candidates:[],selected:new Set(),batches:[],activeView:'generator',
  historyLoaded:false,busy:false,detail:null,settlementBatch:null,pendingAction:null
};

const statusLabels={
  DRAFT:'Borrador',FILE_GENERATED:'Archivo generado',SENT_TO_BANK:'Enviado al banco',
  FULLY_APPLIED:'Aplicado completamente',PARTIALLY_REJECTED:'Rechazo parcial',CANCELLED:'Cancelado',
  UNASSIGNED:'Sin asignar',LOCKED_IN_BATCH:'Bloqueado en lote',PAID_CONFIRMED:'Pago confirmado',REJECTED_BANK:'Rechazado por el banco'
};
const permissionKeys={
  generate:['manage','generate','canGenerate','can_generate','GENERATE','payment-batches:generate','treasury:payment-batches:generate'],
  download:['manage','download','canDownload','can_download','DOWNLOAD','payment-batches:download','treasury:payment-batches:download'],
  sent:['manage','sent','markSent','canMarkSent','can_mark_sent','SEND','payment-batches:send','treasury:payment-batches:send'],
  cancel:['manage','cancel','canCancel','can_cancel','CANCEL','payment-batches:cancel','treasury:payment-batches:cancel'],
  apply:['execute','apply','canApply','can_apply','APPLY','payment-batches:apply','treasury:payment-batches:apply']
};

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>Number.isFinite(Number(value))?Number(value):0;
const same=(a,b)=>String(a??'')===String(b??'');
const array=value=>Array.isArray(value)?value:[];
const first=(object,...keys)=>{for(const key of keys)if(object?.[key]!==undefined&&object?.[key]!==null&&object?.[key]!=='')return object[key];return''};
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/Costa_Rica'});
const dateLabel=value=>{if(!value)return'—';const raw=String(value).slice(0,10),parts=raw.split('-');return parts.length===3?`${parts[2]}/${parts[1]}/${parts[0]}`:raw};
const dateTimeLabel=value=>value?new Date(value).toLocaleString('es-CR',{dateStyle:'short',timeStyle:'short'}):'—';
const currencyCode=value=>String(value||'').trim();
const money=(value,currency='')=>`${number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})}${currency?` ${currency}`:''}`;
const statusLabel=value=>statusLabels[String(value||'').toUpperCase()]||String(value||'—').replaceAll('_',' ');

function headers(json=false){return{Authorization:`Bearer ${token}`,'X-Device-Token':device,...(json?{'Content-Type':'application/json'}:{})}}
async function api(path,{method='GET',payload}={}){
  const response=await fetch(path,{method,headers:headers(payload!==undefined),body:payload===undefined?undefined:JSON.stringify(payload)});
  const raw=await response.text();let result=null;
  try{result=raw?JSON.parse(raw):null}catch{result={message:raw}}
  if(!response.ok)throw Error(result?.error?.message||(typeof result?.error==='string'?result.error:'')||result?.message||'No fue posible procesar el lote de pagos.');
  return result;
}
async function withBusy(button,label,work){
  if(state.busy)return;state.busy=true;document.body.classList.add('is-busy');
  const previousText=button?.textContent,previousDisabled=button?.disabled;if(button){button.disabled=true;if(label)button.textContent=label}
  try{return await work()}finally{state.busy=false;document.body.classList.remove('is-busy');if(button){button.textContent=previousText;button.disabled=previousDisabled}updateSelectionSummary()}
}
function message(text,type='success'){$('message').textContent=text||'';$('message').className=`page-message ${type==='success'?'':type}`;if(text&&type==='error')$('message').scrollIntoView({behavior:'smooth',block:'center'})}
function clearMessage(){message('')}
function closeDialog(id){const dialog=$(id);if(dialog?.open)dialog.close()}

function permission(action){
  const permissions=state.options?.permissions;if(permissions===undefined||permissions===null)return true;
  const aliases=permissionKeys[action]||[action];
  if(typeof permissions==='boolean')return permissions;
  if(Array.isArray(permissions))return aliases.some(key=>permissions.some(value=>String(value).toLowerCase()===String(key).toLowerCase()));
  if(typeof permissions==='object'){
    for(const key of aliases)if(Object.prototype.hasOwnProperty.call(permissions,key))return Boolean(permissions[key]);
    const list=permissions.actions||permissions.allowed||permissions.codes;
    if(Array.isArray(list))return aliases.some(key=>list.some(value=>String(value).toLowerCase()===String(key).toLowerCase()));
  }
  return false;
}

function fillSelect(id,rows,{empty='Seleccione',label=item=>item.name,value=item=>item.id,disabled=()=>false}={}){
  const select=$(id);select.replaceChildren(new Option(empty,''));
  for(const item of rows){const option=new Option(String(label(item)??''),String(value(item)??''));option.disabled=Boolean(disabled(item));select.append(option)}
}
function selectedAccount(){return state.options.accounts.find(item=>same(item.id,$('bankAccount').value))}
function selectedFormat(){return state.options.formats.find(item=>same(item.id,$('format').value))}
function candidateCurrency(){return currencyCode(selectedAccount()?.currencyCode||state.options.currencies.find(item=>same(item.id,$('currency').value))?.code||state.options.currencies.find(item=>same(item.id,$('currency').value))?.name)}
function compatibleFormats(){
  const account=selectedAccount(),currencyId=$('currency').value;
  if(!account)return[];
  return state.options.formats.filter(format=>(!format.bankId||same(format.bankId,account.bankId))&&(!format.currencyId||same(format.currencyId,currencyId||account.currencyId)));
}
function renderFormats(){
  const formats=compatibleFormats();
  fillSelect('format',formats,{empty:formats.length?'Seleccione un formato compatible':'Sin formatos compatibles',label:item=>`${item.name||item.code}${item.extension?` · ${item.extension}`:''}${item.verified===false?' · Pendiente de validación bancaria':''}`});
  if(formats.length===1)$('format').value=String(formats[0].id);
  renderFormatContext();
}
function renderFormatContext(){
  const format=selectedFormat();
  if(!format)$('formatHelp').textContent=compatibleFormats().length?'Seleccione la plantilla habilitada para el banco y la moneda.':'No hay una plantilla compatible con esta cuenta.';
  else if(format.verified===false)$('formatHelp').textContent=`Plantilla configurable pendiente de validación con el banco.${format.sourceReference?` ${format.sourceReference}`:''}`;
  else $('formatHelp').textContent='Formato validado para el banco y la moneda seleccionados.';
  updateSelectionSummary();
}
function renderAccountContext(){
  const account=selectedAccount();
  if(!account){$('accountHelp').textContent='Elija una cuenta bancaria activa de la subsidiaria.';$('currency').disabled=false;$('accountBalance').textContent='—';renderFormats();return}
  if(account.currencyId!==undefined&&account.currencyId!==null){$('currency').value=String(account.currencyId);$('currency').disabled=true}else $('currency').disabled=false;
  $('accountHelp').textContent=`Saldo disponible: ${money(account.balance,account.currencyCode)}${account.iban?` · IBAN ${account.iban}`:''}`;
  $('accountBalance').textContent=money(account.balance,account.currencyCode);
  renderFormats();
}
function renderOptions(){
  $('company').textContent=state.options.company?.name||state.options.companyName||'Subsidiaria activa';
  fillSelect('bankAccount',state.options.accounts,{empty:'Seleccione una cuenta pagadora',label:item=>`${item.bank||item.name}${item.number?` · ${item.number}`:''}${item.currencyCode?` · ${item.currencyCode}`:''} · Saldo ${money(item.balance)}`});
  fillSelect('historyAccount',state.options.accounts,{empty:'Todas las cuentas pagadoras',label:item=>`${item.bank||item.name}${item.number?` · ${item.number}`:''}${item.currencyCode?` · ${item.currencyCode}`:''}`});
  fillSelect('currency',state.options.currencies,{empty:'Seleccione una moneda',label:item=>item.code||item.name||item.currencyCode});
  fillSelect('supplier',state.options.suppliers,{empty:'Todos los proveedores',label:item=>item.name||item.companyName||item.company_name});
  $('generateBatch').hidden=!permission('generate');
  $('selectAllCandidates').disabled=!permission('generate');
  if(!permission('generate'))message('Su rol permite consultar lotes, pero no generar nuevos archivos de pago.','warning');
}

function resetCandidates(){
  state.candidates=[];state.selected.clear();$('candidateTabCount').textContent='0';$('candidateMetrics').hidden=true;
  $('candidateDescription').textContent='Use los filtros para consultar solicitudes listas para pago.';
  $('candidateRows').innerHTML='<tr><td colspan="8"><div class="empty-state"><span>⌕</span><b>Consulte las solicitudes aprobadas</b><small>Seleccione una cuenta pagadora y una fecha de vencimiento.</small></div></td></tr>';
  updateSelectionSummary();
}
function candidateErrors(row){
  const errors=array(row.errors).map(String).filter(Boolean);
  if(row.ibanValid===false&&!errors.some(value=>/iban/i.test(value)))errors.push('IBAN incompleto o inválido');
  if(row.taxIdValid===false&&!errors.some(value=>/identific|cédula|cedula/i.test(value)))errors.push('Identificación fiscal inválida');
  return errors;
}
function candidateValid(row){return row.valid!==false&&row.ibanValid!==false&&row.taxIdValid!==false&&!candidateErrors(row).length}
function invoiceMarkup(invoices){
  const rows=array(invoices);if(!rows.length)return'<span class="cell-note">Sin detalle de facturas</span>';
  const shown=rows.slice(0,2).map(invoice=>{if(typeof invoice==='string'||typeof invoice==='number')return`<span>${esc(invoice)}</span>`;const number=first(invoice,'number','invoiceNumber','invoice_number','documentNumber','document_number'),amount=first(invoice,'amount','total','balance');return`<span>${esc(number||'Factura')}${amount!==''?` · ${esc(money(amount))}`:''}</span>`}).join('');
  return`<div class="invoice-list">${shown}${rows.length>2?`<span class="more">+ ${rows.length-2} factura${rows.length-2===1?'':'s'} adicional${rows.length-2===1?'':'es'}</span>`:''}</div>`;
}
function renderCandidateLoading(){
  $('candidateRows').innerHTML='<tr><td colspan="8"><div class="empty-state loading-state"><span>•••</span><b>Consultando solicitudes</b><small>Validando saldos, IBAN e identificación fiscal.</small></div></td></tr>';
}
function renderCandidates(){
  const account=selectedAccount(),code=candidateCurrency(),valid=state.candidates.filter(candidateValid),invalid=state.candidates.length-valid.length;
  $('candidateTabCount').textContent=String(state.candidates.length);$('candidateCount').textContent=String(state.candidates.length);$('validCount').textContent=String(valid.length);$('invalidCount').textContent=String(invalid);$('candidateMetrics').hidden=false;
  $('accountBalance').textContent=account?money(account.balance,account.currencyCode||code):'—';
  $('candidateDescription').textContent=state.candidates.length?`${valid.length} solicitud${valid.length===1?'':'es'} puede${valid.length===1?'':'n'} incluirse en el archivo; ${invalid} requiere${invalid===1?'':'n'} corrección.`:'No hay solicitudes aprobadas disponibles con estos filtros.';
  if(!state.candidates.length){$('candidateRows').innerHTML='<tr><td colspan="8"><div class="empty-state"><span>✓</span><b>No hay solicitudes elegibles</b><small>Amplíe el vencimiento o revise solicitudes aprobadas que aún no pertenezcan a un lote.</small></div></td></tr>';updateSelectionSummary();return}
  $('candidateRows').innerHTML=state.candidates.map(row=>{
    const id=String(row.id),isValid=candidateValid(row),selectable=isValid&&permission('generate'),checked=selectable&&state.selected.has(id),errors=candidateErrors(row),rowCode=currencyCode(row.currency||code);
    return`<tr class="candidate-row ${checked?'selected ':''}${isValid?'':'invalid-row'}" data-candidate-id="${esc(id)}">
      <td class="check-column"><input class="candidate-check" type="checkbox" aria-label="Seleccionar ${esc(row.number)}" ${checked?'checked':''} ${selectable?'':'disabled'}></td>
      <td><b class="request-number">${esc(row.number)}</b><small class="cell-note">Programada ${esc(dateLabel(row.plannedDate))}</small></td>
      <td><b class="supplier-name">${esc(row.supplier)}</b><small class="cell-note">ID: ${esc(row.taxId||'No registrada')}</small></td>
      <td>${invoiceMarkup(row.invoices)}</td>
      <td><b>${esc(dateLabel(row.dueDate))}</b><small class="cell-note">Vencimiento CxP</small></td>
      <td><b class="iban">${esc(row.iban||'Sin IBAN')}</b><small class="cell-note">Cuenta del proveedor</small></td>
      <td><div class="validation-stack"><span class="validation-chip ${row.ibanValid===false?'bad':'good'}">IBAN ${row.ibanValid===false?'inválido':'válido'}</span><span class="validation-chip ${row.taxIdValid===false?'bad':'good'}">ID ${row.taxIdValid===false?'inválida':'válida'}</span></div>${errors.length?`<small class="validation-errors">${errors.map(esc).join(' · ')}</small>`:''}</td>
      <td class="num amount-cell"><b>${esc(money(row.amount))}</b><span class="currency-code">${esc(rowCode)}</span></td>
    </tr>`;
  }).join('');
  updateSelectionSummary();
}
function selectedRows(){return state.candidates.filter(row=>state.selected.has(String(row.id)))}
function updateSelectionSummary(){
  const rows=selectedRows(),total=rows.reduce((sum,row)=>sum+number(row.amount),0),gross=rows.reduce((sum,row)=>sum+number(row.applicationAmount||row.amount),0),account=selectedAccount(),format=selectedFormat(),balance=number(account?.balance),code=candidateCurrency();
  $('selectedCount').textContent=String(rows.length);$('selectedAmount').textContent=money(total,code);
  const validIds=state.candidates.filter(candidateValid).map(row=>String(row.id)),checked=validIds.filter(id=>state.selected.has(id)).length;
  $('selectAllCandidates').checked=validIds.length>0&&checked===validIds.length;$('selectAllCandidates').indeterminate=checked>0&&checked<validIds.length;
  let warning='',blocking=false;
  if(rows.some(row=>!candidateValid(row))){warning='La selección contiene solicitudes con datos bancarios inválidos.';blocking=true}
  else if(account&&gross>balance){warning=`El saldo no cubre el importe solicitado antes de retenciones. Faltan ${money(gross-balance,account.currencyCode||code)} para que el motor contable procese el lote.`;blocking=true}
  else if(rows.length&&!compatibleFormats().length){warning='No existe un formato bancario compatible para la cuenta y moneda seleccionadas.';blocking=true}
  else if(format?.verified===false)warning='Esta plantilla está pendiente de validación con el banco. Confirme que coincide con la versión habilitada en su portal antes de cargar el archivo.';
  $('selectionWarning').textContent=warning;$('selectionWarning').hidden=!warning;$('selectionWarning').classList.toggle('blocking',blocking);
  $('generateBatch').disabled=state.busy||!permission('generate')||!rows.length||!format||!$('executionDate').value||number($('rate').value)<=0||blocking;
}
function candidatePayload(){return{dueTo:$('dueTo').value,currencyId:$('currency').value,supplierId:$('supplier').value||null,bankAccountId:$('bankAccount').value}}
function validateCandidateFilters(){
  if(!$('bankAccount').value)throw Error('Seleccione la cuenta pagadora.');
  if(!$('currency').value)throw Error('Seleccione la moneda.');
  if(!$('dueTo').value)throw Error('Indique la fecha máxima de vencimiento de CxP.');
}
async function queryCandidates(){
  validateCandidateFilters();renderCandidateLoading();state.selected.clear();
  const result=await api(`${API}/candidates`,{method:'POST',payload:candidatePayload()});
  state.candidates=Array.isArray(result)?result:array(result?.rows||result?.candidates);renderCandidates();
}
async function loadCandidates(button=$('findCandidates')){
  clearMessage();try{await withBusy(button,'Consultando…',queryCandidates)}catch(error){resetCandidates();message(error.message,'error')}
}

function validateGeneration(){
  const rows=selectedRows(),account=selectedAccount(),format=selectedFormat(),total=rows.reduce((sum,row)=>sum+number(row.amount),0),gross=rows.reduce((sum,row)=>sum+number(row.applicationAmount||row.amount),0);
  if(!permission('generate'))throw Error('Su rol no permite generar lotes de pago.');
  if(!rows.length)throw Error('Seleccione al menos una solicitud válida.');
  if(rows.some(row=>!candidateValid(row)))throw Error('Quite las solicitudes con datos bancarios inválidos.');
  if(!account)throw Error('Seleccione la cuenta pagadora.');
  if(!format)throw Error('Seleccione un formato bancario compatible.');
  if(format.bankId&&!same(format.bankId,account.bankId))throw Error('El formato seleccionado no corresponde al banco de la cuenta pagadora.');
  if(format.currencyId&&!same(format.currencyId,account.currencyId))throw Error('El formato seleccionado no admite la moneda de la cuenta pagadora.');
  if(!$('executionDate').value)throw Error('Indique la fecha de ejecución del lote.');
  if(number($('rate').value)<=0)throw Error('Indique un tipo de cambio mayor que cero.');
  if(gross>number(account.balance))throw Error('El saldo disponible no cubre el importe solicitado antes de retenciones.');
  return{rows,account,format,total,gross};
}
function openGenerateDialog(){
  try{
    clearMessage();const{rows,account,format,total,gross}=validateGeneration(),code=account.currencyCode||candidateCurrency();
    $('generatePreview').innerHTML=`<div><small>Cuenta pagadora</small><b>${esc(account.name)}</b></div><div><small>Formato</small><b>${esc(format.name||format.code)} · ${esc(format.extension||'')}</b></div><div><small>Fecha de ejecución</small><b>${esc(dateLabel($('executionDate').value))}</b></div><div><small>Solicitudes</small><b>${rows.length}</b></div><div><small>Tipo de cambio</small><b>${esc(number($('rate').value).toLocaleString('es-CR',{maximumFractionDigits:8}))}</b></div><div><small>Importe solicitado</small><b>${esc(money(gross,code))}</b></div><div class="preview-total"><small>Total neto a transferir</small><b>${esc(money(total,code))}</b></div>`;
    const notice=$('generateNotice');
    if(format.verified===false)notice.innerHTML=`<b>Validación bancaria pendiente</b><span>${esc(format.sourceReference||'Confirme con el banco que esta plantilla coincide con la versión habilitada en su portal.')} Al confirmar, las solicitudes quedarán bloqueadas en este lote.</span>`;
    else notice.innerHTML='<b>Al confirmar</b><span>Las solicitudes quedarán asociadas al lote y no podrán pagarse por otra vía mientras permanezcan bloqueadas.</span>';
    $('generateDialog').showModal();
  }catch(error){message(error.message,'error')}
}

function dispositionFilename(response,fallback){
  const disposition=response.headers.get('Content-Disposition')||'',encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i),plain=disposition.match(/filename="?([^";]+)"?/i);
  try{return encoded?decodeURIComponent(encoded[1]):plain?.[1]||fallback}catch{return fallback}
}
function saveBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
async function downloadUrl(url,fallback){
  const target=new URL(url,location.origin);
  if(target.origin!==location.origin){const link=document.createElement('a');link.href=target.href;link.target='_blank';link.rel='noopener';link.download=fallback||'';document.body.append(link);link.click();link.remove();return}
  const response=await fetch(target.href,{headers:headers(false)});
  if(!response.ok){const raw=await response.text();let result={};try{result=JSON.parse(raw)}catch{}throw Error(result?.error?.message||result?.message||'El lote se generó, pero no fue posible descargar el archivo.')}
  saveBlob(await response.blob(),dispositionFilename(response,fallback||'lote-pagos'));
}
async function downloadBatch(id,numberValue='',button){
  try{await withBusy(button,'Descargando…',()=>downloadUrl(`${API}/${encodeURIComponent(id)}/download`,`${numberValue||'lote-pagos'}.txt`));message(`Archivo del lote ${numberValue||''} descargado correctamente.`)}catch(error){message(error.message,'error')}
}
async function generateBatch(){
  let generation;
  try{generation=validateGeneration()}catch(error){closeDialog('generateDialog');message(error.message,'error');return}
  try{
    await withBusy($('confirmGenerate'),'Generando archivo…',async()=>{
      const result=await api(`${API}/generate`,{method:'POST',payload:{bankAccountId:generation.account.id,formatId:generation.format.id,executionDate:$('executionDate').value,rate:number($('rate').value),requestIds:generation.rows.map(row=>row.id)}}),batch=result?.batch||{};
      closeDialog('generateDialog');
      let downloaded=true;try{await downloadUrl(result?.downloadUrl||`${API}/${encodeURIComponent(batch.id)}/download`,batch.fileName||`${batch.number||'lote-pagos'}${generation.format.extension||''}`)}catch(error){downloaded=false;message(`${batch.number||'El lote'} fue generado por ${money(batch.total,generation.account.currencyCode)}, pero la descarga falló: ${error.message}`,'warning')}
      await Promise.allSettled([queryHistory(),queryCandidates()]);
      switchView('history',{load:false});
      if(downloaded)message(`${batch.number||'Lote generado'} · ${batch.itemCount??generation.rows.length} solicitudes · ${money(batch.total??generation.total,generation.account.currencyCode)}. El archivo se descargó correctamente.`);
    });
  }catch(error){message(error.message,'error')}
}

function historyPayload(){return{from:$('historyFrom').value,to:$('historyTo').value,status:$('historyStatus').value||null,bankAccountId:$('historyAccount').value||null}}
function validateHistoryFilters(){if(!$('historyFrom').value||!$('historyTo').value)throw Error('Indique el rango de fechas del historial.');if($('historyFrom').value>$('historyTo').value)throw Error('La fecha inicial no puede ser posterior a la fecha final.')}
function amountSummary(rows){
  const totals=new Map();for(const row of rows){const code=currencyCode(row.currency)||'MONEDA';totals.set(code,(totals.get(code)||0)+number(row.total))}
  return[...totals].map(([code,total])=>money(total,code)).join(' · ')||'0,00';
}
function canDownloadBatch(row){return permission('download')&&Boolean(first(row,'fileName','generated_file_name','hasFile'))}
function canMarkSent(row){return permission('sent')&&String(row.status)==='FILE_GENERATED'}
function canApplyBatch(row){return permission('apply')&&['FILE_GENERATED','SENT_TO_BANK','PARTIALLY_REJECTED'].includes(String(row.status))}
function canCancelBatch(row){return permission('cancel')&&['DRAFT','FILE_GENERATED'].includes(String(row.status))}
function batchActions(row){
  const attrs=`data-batch-id="${esc(row.id)}" data-batch-number="${esc(row.number)}"`;
  return`<div class="row-actions"><button type="button" class="link-action" data-batch-action="detail" ${attrs}>Ver detalle</button>${canDownloadBatch(row)?`<button type="button" data-batch-action="download" ${attrs}>Descargar</button>`:''}${canMarkSent(row)?`<button type="button" data-batch-action="sent" ${attrs}>Marcar enviado</button>`:''}${canApplyBatch(row)?`<button type="button" class="apply-action" data-batch-action="apply" ${attrs}>Aplicar respuesta</button>`:''}${canCancelBatch(row)?`<button type="button" class="danger-action" data-batch-action="cancel" ${attrs}>Cancelar</button>`:''}</div>`;
}
function renderHistory(){
  const rows=state.batches,pending=rows.filter(row=>!['FULLY_APPLIED','CANCELLED'].includes(String(row.status))).length;
  $('historyTabCount').textContent=String(rows.length);$('historyCount').textContent=`${rows.length} lote${rows.length===1?'':'s'}`;$('historySummary').hidden=false;
  $('summaryBatches').textContent=String(rows.length);$('summaryItems').textContent=String(rows.reduce((sum,row)=>sum+number(row.itemCount),0));$('summaryAmount').textContent=amountSummary(rows);$('summaryPending').textContent=String(pending);
  $('historyDescription').textContent=rows.length?`${pending} lote${pending===1?'':'s'} pendiente${pending===1?'':'s'} de liquidación o cierre.`:'No se encontraron lotes en el período seleccionado.';
  if(!rows.length){$('historyRows').innerHTML='<tr><td colspan="9"><div class="empty-state"><span>≡</span><b>No se encontraron lotes</b><small>Cambie el período o los filtros de estado y cuenta.</small></div></td></tr>';return}
  $('historyRows').innerHTML=rows.map(row=>`<tr>
    <td><b class="batch-number">${esc(row.number)}</b><small class="cell-note">${esc(dateTimeLabel(row.createdAt))}</small></td>
    <td><b>${esc(dateLabel(row.executionDate))}</b></td>
    <td><b>${esc(row.bank||'—')}</b><small class="cell-note">${esc(row.account||'—')}</small></td>
    <td><span class="currency-code">${esc(row.currency||'—')}</span></td>
    <td class="num">${esc(row.itemCount??0)}</td>
    <td class="num amount-cell"><b>${esc(money(row.total))}</b></td>
    <td><span class="status-pill ${esc(row.status)}">${esc(statusLabel(row.status))}</span>${row.bankReference?`<small class="cell-note">Ref. ${esc(row.bankReference)}</small>`:''}</td>
    <td>${esc(row.createdBy||'—')}</td>
    <td class="actions-cell">${batchActions(row)}</td>
  </tr>`).join('');
}
async function queryHistory(){
  validateHistoryFilters();const result=await api(`${API}/report`,{method:'POST',payload:historyPayload()});
  state.batches=array(result?.rows??result);state.historyLoaded=true;renderHistory();
}
async function loadHistory(button=$('findBatches')){clearMessage();try{await withBusy(button,'Consultando…',queryHistory)}catch(error){message(error.message,'error')}}

function detailHeader(){return state.detail?.header||{}}
function detailItems(){return array(state.detail?.items)}
function findBatch(id){return state.batches.find(row=>same(row.id,id))||{id,number:''}}
function renderDetail(){
  const header=detailHeader(),items=detailItems(),numberValue=first(header,'number','batchNumber','batch_number')||findBatch(header.id)?.number||'Lote de pago',status=first(header,'status'),code=first(header,'currency','currencyCode','currency_code');
  $('detailTitle').textContent=String(numberValue);$('detailSubtitle').textContent=`${statusLabel(status)}${first(header,'bankReference','bank_reference')?` · Referencia ${first(header,'bankReference','bank_reference')}`:''}`;$('detailItemCount').textContent=`${items.length} transferencia${items.length===1?'':'s'}`;
  const summary=[['Estado',statusLabel(status)],['Banco',first(header,'bank','bankName','bank_name')||'—'],['Cuenta pagadora',first(header,'account','accountName','account_number')||'—'],['Fecha de ejecución',dateLabel(first(header,'executionDate','execution_date'))],['Solicitudes',first(header,'itemCount','item_count')||items.length],['Total',money(first(header,'total','totalAmount','total_amount'),code)]];
  $('detailSummary').innerHTML=summary.map(([label,value])=>`<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('');
  $('detailRows').innerHTML=items.map(item=>{
    const itemStatus=String(first(item,'processingStatus','processing_status','status')||'LOCKED_IN_BATCH');
    return`<tr><td><b class="request-number">${esc(first(item,'requestNumber','request_number','number')||'—')}</b>${invoiceMarkup(array(item.invoices))}</td><td><b class="supplier-name">${esc(first(item,'supplier','supplierName','supplier_name')||'—')}</b></td><td><small class="cell-note">ID: ${esc(first(item,'taxId','tax_id')||'—')}</small><b class="iban">${esc(first(item,'iban','vendorIban','vendor_iban')||'—')}</b></td><td class="num amount-cell"><b>${esc(money(first(item,'applicationAmount','application_amount','amount'),code))}</b><small class="cell-note">Antes de retenciones al pago</small></td><td><span class="item-status ${esc(itemStatus)}">${esc(statusLabel(itemStatus))}</span>${first(item,'bankReference','bank_reference','bankReferenceNumber')?`<small class="cell-note">Ref. ${esc(first(item,'bankReference','bank_reference','bankReferenceNumber'))}</small>`:''}${first(item,'rejectionReason','rejection_reason','error')?`<small class="validation-errors">${esc(first(item,'rejectionReason','rejection_reason','error'))}</small>`:''}</td><td class="num amount-cell"><b>${esc(money(first(item,'amount','total'),code))}</b></td></tr>`;
  }).join('')||'<tr><td colspan="6"><div class="empty-state"><span>≡</span><b>El lote no tiene solicitudes</b></div></td></tr>';
  const row={...findBatch(first(header,'id','batchId','batch_id')),...header,id:first(header,'id','batchId','batch_id')||findBatch(header.id).id,number:numberValue,status};
  $('detailActions').innerHTML=`<button type="button" class="button secondary" data-close="detailDialog">Cerrar</button>${canDownloadBatch(row)?`<button type="button" class="button secondary" data-batch-action="download" data-batch-id="${esc(row.id)}" data-batch-number="${esc(numberValue)}">Descargar archivo</button>`:''}${canMarkSent(row)?`<button type="button" class="button secondary" data-batch-action="sent" data-batch-id="${esc(row.id)}" data-batch-number="${esc(numberValue)}">Marcar enviado</button>`:''}${canApplyBatch(row)?`<button type="button" class="button primary" data-batch-action="apply" data-batch-id="${esc(row.id)}" data-batch-number="${esc(numberValue)}">Aplicar respuesta bancaria</button>`:''}`;
}
async function openDetail(id,button){
  try{await withBusy(button,'Abriendo…',async()=>{state.detail=await api(`${API}/${encodeURIComponent(id)}/detail`);renderDetail();$('detailDialog').showModal()})}catch(error){message(error.message,'error')}
}

function setSettlementMode(mode){
  const response=mode==='response';$('responseMode').hidden=!response;$('referenceMode').hidden=response;$('responseModeTab').setAttribute('aria-selected',String(response));$('referenceModeTab').setAttribute('aria-selected',String(!response));$('settlementForm').dataset.mode=mode;$('settlementError').textContent='';
}
function openSettlement(id,numberValue){
  if(!permission('apply')){message('Su rol no permite liquidar lotes de pago.','error');return}
  state.settlementBatch={id,number:numberValue};$('settlementTitle').textContent=`Aplicar pagos · ${numberValue||'Lote'}`;$('settlementForm').reset();$('selectedFile').hidden=true;$('selectedFile').replaceChildren();setSettlementMode('response');closeDialog('detailDialog');$('settlementDialog').showModal();
}
function validateResponseFile(file){
  if(!file)throw Error('Seleccione el archivo de respuesta del banco.');
  const extension=file.name.toLowerCase().split('.').pop();if(!['ack','res','csv','txt','xml'].includes(extension))throw Error('El archivo debe tener extensión ACK, RES, CSV, TXT o XML.');
  if(!file.size)throw Error('El archivo de respuesta está vacío.');
  if(file.size>5*1024*1024)throw Error('El archivo de respuesta supera el límite de 5 MB.');
}
function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',').pop()||'');reader.onerror=()=>reject(Error('No fue posible leer el archivo seleccionado.'));reader.readAsDataURL(file)})}
async function applySettlement(){
  const mode=$('settlementForm').dataset.mode,batch=state.settlementBatch;if(!batch)return;
  try{
    $('settlementError').textContent='';let endpoint,payload;
    if(mode==='response'){const file=$('responseFile').files?.[0];validateResponseFile(file);endpoint='apply-response';payload={fileName:file.name,contentBase64:await fileBase64(file)}}
    else{const reference=$('globalReference').value.trim();if(!reference)throw Error('Ingrese la referencia global de la transferencia.');endpoint='apply-reference';payload={reference}}
    await withBusy($('applySettlement'),'Procesando pagos…',async()=>{await api(`${API}/${encodeURIComponent(batch.id)}/${endpoint}`,{method:'POST',payload});closeDialog('settlementDialog');await queryHistory();message(`${batch.number||'El lote'} fue procesado. Revise el estado y el detalle de cada transferencia.`)});
  }catch(error){$('settlementError').textContent=error.message}
}

function openAction(type,id,numberValue){
  state.pendingAction={type,id,number:numberValue};
  if(type==='sent'){$('actionTitle').textContent='Marcar lote como enviado';$('actionDescription').textContent=`Confirme que ${numberValue} fue cargado en el portal bancario.`;$('actionNotice').innerHTML='<b>Estado del lote</b><span>Quedará pendiente de la respuesta o referencia del banco.</span>';$('confirmAction').textContent='Confirmar envío';$('confirmAction').className='button primary'}
  else{$('actionTitle').textContent='Cancelar lote de pago';$('actionDescription').textContent=`Esta acción cancelará ${numberValue}.`;$('actionNotice').innerHTML='<b>Solicitudes liberadas</b><span>Las solicitudes volverán a estar disponibles para corregirse o incluirse en otro lote.</span>';$('confirmAction').textContent='Cancelar lote';$('confirmAction').className='button danger'}
  closeDialog('detailDialog');$('actionDialog').showModal();
}
async function runPendingAction(){
  const action=state.pendingAction;if(!action)return;
  try{await withBusy($('confirmAction'),action.type==='sent'?'Confirmando…':'Cancelando…',async()=>{await api(`${API}/${encodeURIComponent(action.id)}/${action.type}`,{method:'POST',payload:{}});closeDialog('actionDialog');await Promise.allSettled([queryHistory(),$('bankAccount').value?queryCandidates():Promise.resolve()]);message(action.type==='sent'?`${action.number} quedó marcado como enviado al banco.`:`${action.number} fue cancelado y sus solicitudes quedaron liberadas.`)})}catch(error){closeDialog('actionDialog');message(error.message,'error')}
}

function switchView(view,{updateUrl=true,load=true}={}){
  const selected=view==='history'?'history':'generator';state.activeView=selected;$('generatorView').hidden=selected!=='generator';$('historyView').hidden=selected!=='history';
  for(const button of document.querySelectorAll('[data-view]'))button.setAttribute('aria-selected',String(button.dataset.view===selected));
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('view',selected);history.replaceState(history.state,'',url.pathname+url.search+url.hash)}
  clearMessage();if(selected==='history'&&load&&!state.historyLoaded)void loadHistory();
}

$('bankAccount').onchange=()=>{renderAccountContext();resetCandidates()};
$('currency').onchange=()=>{renderFormats();resetCandidates()};
$('supplier').onchange=resetCandidates;$('dueTo').onchange=resetCandidates;
$('format').onchange=renderFormatContext;$('executionDate').onchange=updateSelectionSummary;$('rate').oninput=updateSelectionSummary;
$('candidateFilters').onsubmit=event=>{event.preventDefault();void loadCandidates()};
$('historyFilters').onsubmit=event=>{event.preventDefault();void loadHistory()};
$('generateBatch').onclick=openGenerateDialog;
$('generateForm').onsubmit=event=>{event.preventDefault();void generateBatch()};
$('settlementForm').onsubmit=event=>{event.preventDefault();void applySettlement()};
$('actionForm').onsubmit=event=>{event.preventDefault();void runPendingAction()};
$('generatorViewTab').onclick=()=>switchView('generator');$('historyViewTab').onclick=()=>switchView('history');
$('responseModeTab').onclick=()=>setSettlementMode('response');$('referenceModeTab').onclick=()=>setSettlementMode('reference');
$('selectAllCandidates').onchange=event=>{for(const row of state.candidates.filter(candidateValid)){const id=String(row.id);if(event.target.checked)state.selected.add(id);else state.selected.delete(id)}renderCandidates()};
$('candidateRows').onclick=event=>{const row=event.target.closest('[data-candidate-id]');if(!row)return;const candidate=state.candidates.find(item=>same(item.id,row.dataset.candidateId));if(!candidate||!candidateValid(candidate)||!permission('generate'))return;const checkbox=row.querySelector('.candidate-check');if(event.target!==checkbox)checkbox.checked=!checkbox.checked;if(checkbox.checked)state.selected.add(row.dataset.candidateId);else state.selected.delete(row.dataset.candidateId);renderCandidates()};
$('responseFile').onchange=event=>{const file=event.target.files?.[0];$('settlementError').textContent='';if(!file){$('selectedFile').hidden=true;return}try{validateResponseFile(file);$('selectedFile').innerHTML=`<b>${esc(file.name)}</b><span>${esc((file.size/1024).toLocaleString('es-CR',{maximumFractionDigits:1}))} KB</span>`;$('selectedFile').hidden=false}catch(error){event.target.value='';$('selectedFile').hidden=true;$('settlementError').textContent=error.message}};
$('refreshView').onclick=()=>{if(state.activeView==='history')void loadHistory($('refreshView'));else if($('bankAccount').value)void loadCandidates($('refreshView'));else void initialize($('refreshView'))};

document.addEventListener('click',event=>{
  const close=event.target.closest('[data-close]');if(close){closeDialog(close.dataset.close);return}
  const button=event.target.closest('[data-batch-action]');if(!button||state.busy)return;
  const{id:unused}=button.dataset,batchId=button.dataset.batchId,batchNumber=button.dataset.batchNumber||findBatch(batchId).number,action=button.dataset.batchAction;
  if(action==='detail')void openDetail(batchId,button);
  else if(action==='download')void downloadBatch(batchId,batchNumber,button);
  else if(action==='apply')openSettlement(batchId,batchNumber);
  else if(action==='sent'||action==='cancel')openAction(action,batchId,batchNumber);
});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});
window.addEventListener('popstate',()=>switchView(new URL(location.href).searchParams.get('view'),{updateUrl:false}));

function setDates(){
  const current=today(),firstDay=`${current.slice(0,8)}01`;$('dueTo').value=current;$('executionDate').value=current;$('executionDate').min=current;$('historyFrom').value=firstDay;$('historyTo').value=current;
}
async function initialize(button){
  try{await withBusy(button,'Cargando…',async()=>{state.options=await api(`${API}/options`);state.options.accounts=array(state.options.accounts);state.options.formats=array(state.options.formats);state.options.currencies=array(state.options.currencies);state.options.suppliers=array(state.options.suppliers);renderOptions();renderAccountContext()})}catch(error){message(error.message,'error')}
}

setDates();
await initialize();
const initialView=new URL(location.href).searchParams.get('view')==='history'?'history':'generator';
switchView(initialView,{updateUrl:false,load:false});
if(initialView==='history')await loadHistory();
