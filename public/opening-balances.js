const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=()=>localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'';
const fmt=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=value=>String(value??'—').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let runId=null,posted=false,canCreate=false,canReverse=false,subsidiaryId=null,functionalCurrency='',working=false,lastPreview=null,postSubmitting=false,postDialogReturnFocus=null;

async function api(action,body={}){
 const response=await fetch(`/api/opening-balances/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,'X-Device-Token':device()},body:JSON.stringify(body)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  const failure=Error(data.error?.message||'No fue posible procesar la apertura.');
  failure.code=data.error?.code||'';
  failure.files=Array.isArray(data.error?.files)?data.error.files:[];
  throw failure;
 }
 return data;
}

const uploadNames={gl:'Libro Mayor',ar:'Cuentas por Cobrar',ap:'Cuentas por Pagar',fa:'Auxiliar de Activos Fijos',pending:'Auxiliar de Pendientes de Facturar',banks:'Auxiliar de Bancos'};
const uploadIds=Object.keys(uploadNames);
const selectedFileName=id=>$(id)?.files?.[0]?.name||'';
const uploadFailure=(id,message,code='FILE_READ_ERROR',suggestion='Seleccione nuevamente el archivo y vuelva a validar.')=>{
 const failure=Error(message);
 failure.files=[{key:id,label:uploadNames[id],fileName:selectedFileName(id)||'Archivo no identificado',errors:[{code,message,suggestion}]}];
 return failure;
};
const readUpload=id=>new Promise((resolve,reject)=>{
 const file=$(id).files[0];if(!file)return resolve('');
 if(file.size>5_000_000)return reject(uploadFailure(id,`El archivo supera el límite permitido de 5 MB.`,'FILE_TOO_LARGE','Reduzca el tamaño del archivo o divida la información antes de volver a cargarlo.'));
 if(file.name.toLowerCase().endsWith('.csv')){
  const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(uploadFailure(id,'No fue posible leer el archivo CSV.'));reader.readAsText(file,'utf-8');return;
 }
 if(!file.name.toLowerCase().endsWith('.xlsx'))return reject(uploadFailure(id,'El formato del archivo no es válido.','UNSUPPORTED_FILE_TYPE','Seleccione una plantilla en formato CSV o Excel (.xlsx).'));
 const reader=new FileReader();
 reader.onload=()=>resolve({fileName:file.name,base64:String(reader.result).split(',')[1]||''});
 reader.onerror=()=>reject(uploadFailure(id,'No fue posible leer el archivo Excel.'));
 reader.readAsDataURL(file);
});

async function readSelectedUploads(ids){
 const results=await Promise.allSettled(ids.map(readUpload)),values={},files=[];
 results.forEach((result,index)=>{
  const id=ids[index];
  if(result.status==='fulfilled'){values[id]=result.value;return;}
  const failure=result.reason;
  if(Array.isArray(failure?.files)&&failure.files.length)files.push(...failure.files);
  else files.push({key:id,label:uploadNames[id],fileName:selectedFileName(id)||'Archivo no identificado',errors:[{code:'FILE_READ_ERROR',message:failure?.message||'No fue posible leer el archivo.',suggestion:'Seleccione nuevamente el archivo y vuelva a validar.'}]});
 });
 if(files.length){
  const failure=Error(`${files.length===1?'Un archivo requiere':'Varios archivos requieren'} corrección antes de continuar.`);
  failure.code='OPENING_BALANCE_FILES_INVALID';failure.files=files;throw failure;
 }
 return values;
}

function setMessage(text,type='error'){$('message').className=type;$('message').textContent=text;}

let validationFileErrors=[];

function normalizeValidationFiles(files){
 return(Array.isArray(files)?files:[]).filter(file=>file&&typeof file==='object').map((file,index)=>{
  const rawKey=String(file.key||'').trim().toLowerCase(),key=uploadNames[rawKey]?rawKey:'';
  const label=String(file.label||uploadNames[key]||`Archivo ${index+1}`).trim();
  const fileName=String(file.fileName||selectedFileName(key)||'Archivo no identificado').trim();
  const sourceErrors=Array.isArray(file.errors)&&file.errors.length?file.errors:[{message:file.message||'El archivo no pudo validarse.'}];
  const errors=sourceErrors.map(issue=>typeof issue==='string'?{message:issue}:{...issue,message:String(issue?.message||'El archivo no pudo validarse.')});
  return{key,label,fileName,errors};
 });
}

function issueLocation(issue){
 const parts=[];
 if(issue.row!==undefined&&issue.row!==null&&String(issue.row)!=='')parts.push(`Fila ${issue.row}`);
 const field=String(issue.field??'').trim();if(field)parts.push(`Campo ${field}`);
 if(issue.columnLetter)parts.push(`Columna ${issue.columnLetter}${issue.column!==undefined&&issue.column!==null?` (posición ${issue.column})`:''}`);
 else if(issue.column!==undefined&&issue.column!==null&&String(issue.column)!=='')parts.push(`Columna ${issue.column}`);
 return parts.join(' · ');
}

function renderValidationErrors(focusPanel=false){
 for(const id of uploadIds){
  const invalid=validationFileErrors.some(file=>file.key===id),card=document.querySelector(`[data-upload-card="${id}"]`),input=$(id),badge=card?.querySelector('.file-validation-badge');
  card?.classList.toggle('has-validation-error',invalid);
  if(badge)badge.hidden=!invalid;
  if(input){if(invalid){input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby','validationErrorsSummary');}else{input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}}
 }
 const panel=$('validationErrors'),container=$('validationErrorFiles');
 if(!validationFileErrors.length){panel.hidden=true;container.innerHTML='';return;}
 const totalErrors=validationFileErrors.reduce((sum,file)=>sum+file.errors.length,0),fileCount=validationFileErrors.length;
 $('validationErrorsSummary').textContent=`Se ${totalErrors===1?'encontró 1 error':`encontraron ${totalErrors} errores`} en ${fileCount===1?'1 archivo':`${fileCount} archivos`}. Corrija los elementos indicados y vuelva a validar.`;
 container.innerHTML=validationFileErrors.map((file,index)=>{
  const action=file.key?`<button type="button" class="reselect-file" data-reselect="${esc(file.key)}">Seleccionar otro archivo</button>`:'';
  const issues=file.errors.map(issue=>{
   const location=issueLocation(issue);
   return`<li><div class="validation-error-detail">${location?`<span class="validation-error-location">${esc(location)}</span>`:''}<b>${esc(issue.message)}</b>${issue.suggestion?`<small>${esc(issue.suggestion)}</small>`:''}</div></li>`;
  }).join('');
  return`<article class="validation-error-file"><header><span class="validation-error-number">${index+1}</span><div><b>${esc(file.label)}</b><span title="${esc(file.fileName)}">${esc(file.fileName)}</span></div>${action}</header><ol>${issues}</ol></article>`;
 }).join('');
 panel.hidden=false;
 if(focusPanel){panel.focus({preventScroll:true});panel.scrollIntoView({behavior:'smooth',block:'nearest'});}
}

function showValidationErrors(files){validationFileErrors=normalizeValidationFiles(files);renderValidationErrors(true);}
function clearValidationErrors(id=''){
 validationFileErrors=id?validationFileErrors.filter(file=>file.key!==id):[];
 renderValidationErrors(false);
}

function beginWork(){
 if(working)return null;
 working=true;
 const state=Object.fromEntries(['validate','post','reverse'].map(id=>[id,$(id).disabled]));
 for(const id of Object.keys(state))$(id).disabled=true;
 return state;
}

function endWork(state){
 if(!state)return;
 for(const[id,disabled]of Object.entries(state))$(id).disabled=disabled;
 working=false;
}

function assertActiveCompany(){
 const selected=localStorage.getItem('nexo_company')||sessionStorage.getItem('nexo_company');
 if(subsidiaryId===null||String(selected)!==String(subsidiaryId))throw Error('La empresa activa cambió. Recargue esta pantalla antes de continuar.');
}

function renderAssets(data){
 const summary=data.assetSummary||{},assets=data.assets||[],reconciliation=data.assetReconciliation||[];
 const hasAssets=assets.length>0||Number(summary.count||0)>0||reconciliation.length>0;
 $('assetSummarySection').hidden=!hasAssets;
 if(!hasAssets)return;
 const balanced=summary.balanced!==false&&reconciliation.every(row=>Math.abs(Number(row.difference||0))<=.005);
 $('assetStatus').className=`badge ${balanced?'ok':'bad'}`;
 $('assetStatus').textContent=balanced?'Conciliado con el Mayor':'Requiere corrección';
 $('assetSummary').innerHTML=`<div><small>Activos del archivo</small><b>${Number(summary.count||0).toLocaleString('es-CR')}</b></div><div><small>Costo del archivo</small><b>${fmt(summary.cost)}</b></div><div><small>Depreciación del archivo</small><b>${fmt(summary.accumulated)}</b></div><div><small>Valor neto del archivo</small><b>${fmt(summary.bookValue)}</b></div>`;
 $('assetReconciliation').innerHTML=reconciliation.map(row=>{const difference=Number(row.difference||0),ok=Math.abs(difference)<=.005;return`<tr><td>${esc(row.type)}</td><td><b>${esc(row.accountNumber)}</b><small>${esc(row.accountName)}</small></td><td class="num">${fmt(row.ledger)}</td><td class="num">${fmt(row.existing)}</td><td class="num">${fmt(row.staged)}</td><td class="num"><b>${fmt(row.auxiliary)}</b></td><td class="num ${ok?'':'bad-text'}">${fmt(difference)}</td><td><span class="row-status ${ok?'ok':'bad'}">${ok?'Cuadra':'Diferencia'}</span></td></tr>`}).join('')||'<tr><td colspan="8" class="empty">No hay cuentas de activos para conciliar.</td></tr>';
 $('assetRows').innerHTML=assets.map(asset=>`<tr><td>${asset.row}</td><td><b>${esc(asset.number)}</b><small>${esc(asset.name)}</small>${asset.serial?`<small>Serie: ${esc(asset.serial)}</small>`:''}</td><td>${esc(asset.categoryCode)}<small>${esc(asset.category)}</small></td><td>${esc(asset.location)}<small>${[asset.department,asset.costCenter,asset.className].filter(Boolean).map(esc).join(' · ')||'Sin dimensiones'}</small></td><td>${esc(asset.purchaseDate)}<small>En servicio: ${esc(asset.serviceDate)}</small></td><td class="num">${fmt(asset.cost)}</td><td class="num">${fmt(asset.accumulated)}</td><td class="num">${fmt(asset.bookValue)}</td><td class="num">${Number(asset.depreciatedMonths||0)}</td><td><span class="row-status ${asset.created?'created':'pending'}">${asset.created?'Cargado':'Por cargar'}</span></td></tr>`).join('');
}

const firstValue=(object,...keys)=>{
 for(const key of keys)if(object?.[key]!==undefined&&object[key]!==null)return object[key];
 return undefined;
};

function renderArAp(data){
 const summary=data.arApSummary||data.arAp?.summary||{};
 const unified=Array.isArray(data.arApReconciliation)?data.arApReconciliation:[];
 const arRows=Array.isArray(data.arReconciliation)?data.arReconciliation:[];
 const apRows=Array.isArray(data.apReconciliation)?data.apReconciliation:[];
 const reconciliation=unified.length?unified:[
  ...arRows.map(row=>({...row,sourceType:firstValue(row,'sourceType','source_type')||'AR'})),
  ...apRows.map(row=>({...row,sourceType:firstValue(row,'sourceType','source_type')||'AP'}))
 ];
 const financialRows=Array.isArray(data.rows)?data.rows:[];
 const arDocuments=Number(firstValue(summary,'arDocuments','receivableDocuments','arCount')??financialRows.filter(row=>String(firstValue(row,'sourceType','source_type')).toUpperCase()==='AR').length);
 const apDocuments=Number(firstValue(summary,'apDocuments','payableDocuments','apCount')??financialRows.filter(row=>String(firstValue(row,'sourceType','source_type')).toUpperCase()==='AP').length);
 const hasArAp=arDocuments>0||apDocuments>0||reconciliation.length>0;
 $('arApSummarySection').hidden=!hasArAp;
 if(!hasArAp)return{hasArAp:false,balanced:true};
 const rowBalanced=row=>{
  const originalDifference=Number(firstValue(row,'originalDifference','differenceOriginal','foreignDifference')||0);
  const localDifference=Number(firstValue(row,'localDifference','differenceLocal','difference')||0);
  return firstValue(row,'balanced')===false?false:Math.abs(originalDifference)<=.005&&Math.abs(localDifference)<=.005;
 };
 const balanced=summary.balanced!==false&&reconciliation.length>0&&reconciliation.every(rowBalanced);
 $('arApStatus').className=`badge ${balanced?'ok':'bad'}`;
 $('arApStatus').textContent=balanced?'Conciliado con el Mayor':'Requiere corrección';
 const arLocal=Number(firstValue(summary,'arAuxiliaryLocal','receivableLocal','arLocal')??reconciliation.filter(row=>String(firstValue(row,'sourceType','source_type')).toUpperCase()==='AR').reduce((sum,row)=>sum+Number(firstValue(row,'auxiliaryLocal','localAuxiliary')||0),0));
 const apLocal=Number(firstValue(summary,'apAuxiliaryLocal','payableLocal','apLocal')??reconciliation.filter(row=>String(firstValue(row,'sourceType','source_type')).toUpperCase()==='AP').reduce((sum,row)=>sum+Number(firstValue(row,'auxiliaryLocal','localAuxiliary')||0),0));
 $('arApSummary').innerHTML=`<div><small>Facturas por cobrar</small><b>${arDocuments.toLocaleString('es-CR')}</b></div><div><small>Auxiliar CxC en moneda local</small><b>${fmt(arLocal)}</b></div><div><small>Facturas por pagar</small><b>${apDocuments.toLocaleString('es-CR')}</b></div><div><small>Auxiliar CxP en moneda local</small><b>${fmt(apLocal)}</b></div>`;
 $('arApReconciliation').innerHTML=reconciliation.map(row=>{
  const type=String(firstValue(row,'sourceType','source_type','type')||'').toUpperCase(),isAr=type==='AR';
  const originalDifference=Number(firstValue(row,'originalDifference','differenceOriginal','foreignDifference')||0);
  const localDifference=Number(firstValue(row,'localDifference','differenceLocal','difference')||0),ok=rowBalanced(row);
  return`<tr><td><span class="reconciliation-kind ${isAr?'ar':'ap'}">${isAr?'CxC':'CxP'}</span></td><td><b>${esc(firstValue(row,'accountNumber','account','ledgerAccountNumber'))}</b><small>${esc(firstValue(row,'accountName','ledgerAccountName'))}</small></td><td>${esc(firstValue(row,'currency','currencyCode'))}</td><td class="num">${fmt(firstValue(row,'ledgerOriginal','generalLedgerOriginal'))}<small>Local: ${fmt(firstValue(row,'ledgerLocal','generalLedgerLocal'))}</small></td><td class="num"><b>${fmt(firstValue(row,'auxiliaryOriginal','totalOriginal'))}</b><small>Local: ${fmt(firstValue(row,'auxiliaryLocal','totalLocal'))}</small></td><td class="num ${ok?'':'bad-text'}">${fmt(originalDifference)}<small>Local: ${fmt(localDifference)}</small></td><td><span class="row-status ${ok?'ok':'bad'}">${ok?'Cuadra':'Diferencia'}</span></td></tr>`;
 }).join('')||'<tr><td colspan="7" class="empty">No se recibió el detalle de conciliación. Valide nuevamente antes de contabilizar.</td></tr>';
 return{hasArAp:true,balanced};
}

function renderPending(data){
 const summary=data.pendingSummary||data.pending?.summary||{};
 const items=data.pendingItems||data.pendings||data.pending?.items||[];
 const reconciliation=data.pendingReconciliation||data.pending?.reconciliation||[];
 const count=Number(firstValue(summary,'count','items','references')??items.length);
 const hasPending=count>0||items.length>0||reconciliation.length>0;
 $('pendingSummarySection').hidden=!hasPending;
 if(!hasPending)return{hasPending:false,balanced:true,hasPendingToCreate:false};
 const hasItemErrors=items.some(item=>Array.isArray(item.errors)?item.errors.length:Boolean(item.error||item.validationError));
 const balanced=summary.balanced!==false&&!hasItemErrors&&reconciliation.every(row=>Math.abs(Number(firstValue(row,'difference','variance')||0))<=.005&&Math.abs(Number(firstValue(row,'foreignDifference','differenceForeign')||0))<=.005);
 $('pendingStatus').className=`badge ${balanced?'ok':'bad'}`;
 $('pendingStatus').textContent=balanced?'Conciliado con el Mayor':'Requiere corrección';
 $('pendingSummary').innerHTML=`<div><small>Referencias del archivo</small><b>${count.toLocaleString('es-CR')}</b></div><div><small>Período actual</small><b>${fmt(firstValue(summary,'currentLocal','current','actualLocal'))}</b></div><div><small>Períodos anteriores</small><b>${fmt(firstValue(summary,'previousLocal','previous','anteriorLocal'))}</b></div><div><small>Importe reversado</small><b>${fmt(firstValue(summary,'reversed','reversedAmount','reversedLocal'))}</b></div><div><small>Saldo por reversar</small><b>${fmt(firstValue(summary,'balance','pendingAmount','balanceLocal'))}</b></div>`;
 $('pendingReconciliation').innerHTML=reconciliation.map(row=>{
  const difference=Number(firstValue(row,'difference','variance')||0),foreignDifference=Number(firstValue(row,'foreignDifference','differenceForeign')||0),ok=Math.abs(difference)<=.005&&Math.abs(foreignDifference)<=.005;
  const period=String(firstValue(row,'periodType','period_type')||'ACTUAL').toUpperCase();
  const fallbackAccount=period==='ANTERIOR'?'113004':'113003',fallbackName=period==='ANTERIOR'?'Facturación Pendiente de Emitir Períodos Anteriores':'Facturación Pendiente de Emitir Período Actual';
  return`<tr><td><b>${esc(firstValue(row,'accountNumber','account','number')||fallbackAccount)}</b><small>${esc(firstValue(row,'accountName','name')||fallbackName)} · ${esc(firstValue(row,'currency','currencyCode'))}</small><small>${period==='ANTERIOR'?'Períodos anteriores':'Período actual'}</small></td><td class="num">${fmt(firstValue(row,'ledger','generalLedger','gl'))}<small>Original: ${fmt(firstValue(row,'ledgerForeign','generalLedgerForeign'))}</small></td><td class="num">${fmt(firstValue(row,'existing','registered'))}</td><td class="num">${fmt(firstValue(row,'staged','file','uploaded'))}</td><td class="num"><b>${fmt(firstValue(row,'auxiliary','total'))}</b><small>Original: ${fmt(firstValue(row,'auxiliaryForeign','totalForeign'))}</small></td><td class="num ${ok?'':'bad-text'}">${fmt(difference)}<small>Original: ${fmt(foreignDifference)}</small></td><td><span class="row-status ${ok?'ok':'bad'}">${ok?'Cuadra':'Diferencia'}</span></td></tr>`;
 }).join('')||'<tr><td colspan="7" class="empty">No hay cuentas de pendientes para conciliar.</td></tr>';
 $('pendingItems').innerHTML=items.map(item=>{
  const errors=Array.isArray(item.errors)?item.errors.filter(Boolean):[item.error||item.validationError].filter(Boolean);
  const created=Boolean(firstValue(item,'created','createdPendingId','pendingId'));
  const statusClass=errors.length?'bad':created?'created':'pending';
  const statusText=errors.length?errors.join(' · '):created?'Cargado':'Por cargar';
  const customer=firstValue(item,'customerName','customer','thirdParty')||'Cliente no identificado';
  const customerId=firstValue(item,'customerIdentification','customerTaxId','identification');
  const service=[firstValue(item,'serviceMonth','month'),firstValue(item,'serviceCountry','country')].filter(Boolean).map(esc).join(' · ');
  const period=String(firstValue(item,'periodType','period_type')||'ACTUAL').toUpperCase(),periodPrevious=period==='ANTERIOR';
  const line=Array.isArray(item.lines)?item.lines.find(row=>row.role==='CONTROL')||item.lines[0]||{}:{};
  const dimensions=[firstValue(item,'department')??line.department,firstValue(item,'costCenter')??line.costCenter].filter(Boolean).map(esc).join(' · ');
  const supportUrl=firstValue(item,'supportUrl')||(Array.isArray(item.supports)?item.supports.find(support=>support?.url)?.url:'');
  const support=/^https?:\/\//i.test(String(supportUrl||''))?`<small><a href="${esc(supportUrl)}" target="_blank" rel="noopener noreferrer">Abrir respaldo</a></small>`:'';
  return`<tr><td><b>${esc(firstValue(item,'reference','pendingReference','number'))}</b><small>${esc(firstValue(item,'note','description')||'Saldo inicial')}</small>${support}</td><td>${esc(customer)}${customerId?`<small>${esc(customerId)}</small>`:''}</td><td>${esc(firstValue(item,'originDate','date'))}</td><td><span class="period-badge ${periodPrevious?'previous':'current'}">${periodPrevious?'Anterior':'Actual'}</span></td><td>${service||'—'}<small>${dimensions||'Sin dimensiones'}</small></td><td><b>${esc(firstValue(item,'currency','currencyCode'))}</b><small>Tasa histórica: ${esc(firstValue(item,'rate','historicalRate','exchangeRate')??'—')}</small></td><td class="num">${fmt(firstValue(item,'initial','initialAmount','initialLocal'))}</td><td class="num">${fmt(firstValue(item,'reversed','reversedAmount','reversedLocal'))}</td><td class="num"><b>${fmt(firstValue(item,'balance','pendingAmount','balanceLocal'))}</b></td><td><span class="row-status ${statusClass}">${esc(statusText)}</span></td></tr>`;
 }).join('')||'<tr><td colspan="10" class="empty">El archivo no contiene referencias pendientes para mostrar.</td></tr>';
 const hasPendingToCreate=items.some(item=>!Boolean(firstValue(item,'created','active','isActive')));
 return{hasPending:true,balanced,hasPendingToCreate};
}

const bankTypeLabel=value=>({SALDO_CONCILIADO:'Saldo conciliado',DEPOSITO_EN_TRANSITO:'Depósito en tránsito',CHEQUE_EN_TRANSITO:'Cheque en tránsito'}[String(value||'').toUpperCase()]||String(value||'Registro bancario'));

function renderBanks(data){
 const summary=data.bankSummary||data.banks?.summary||{};
 const items=data.bankItems||data.banks?.items||[];
 const reconciliation=data.bankReconciliation||data.banks?.reconciliation||[];
 const count=Number(firstValue(summary,'count','records','items')??items.length);
 const accounts=Number(firstValue(summary,'accounts','accountCount','bankAccounts')??new Set(items.map(item=>`${firstValue(item,'bankCode','bank_code')}|${firstValue(item,'accountNumber','account_number')}`)).size);
 const hasBanks=count>0||items.length>0||reconciliation.length>0;
 $('bankSummarySection').hidden=!hasBanks;
 if(!hasBanks)return{hasBanks:false,balanced:true,hasBankToCreate:false};
 const hasItemErrors=items.some(item=>Array.isArray(item.errors)?item.errors.length:Boolean(item.error||item.validationError));
 const balanced=summary.balanced!==false&&!hasItemErrors&&reconciliation.every(row=>Math.abs(Number(firstValue(row,'difference','variance')||0))<=.005&&Math.abs(Number(firstValue(row,'localDifference','differenceLocal')||0))<=.005);
 $('bankStatus').className=`badge ${balanced?'ok':'bad'}`;
 $('bankStatus').textContent=balanced?'Conciliado con el Mayor':'Requiere corrección';
 const openingLocal=firstValue(summary,'openingLocal','openingBalanceLocal','localEquivalent','balanceLocal');
 const depositsLocal=firstValue(summary,'transitDepositsLocal','depositsLocal','depositLocal');
 const checksLocal=Math.abs(Number(firstValue(summary,'transitChecksLocal','checksLocal','checkLocal')||0));
 $('bankSummary').innerHTML=`<div><small>Cuentas bancarias</small><b>${accounts.toLocaleString('es-CR')}</b></div><div><small>Registros del archivo</small><b>${count.toLocaleString('es-CR')}</b></div><div><small>Saldo conciliado local</small><b>${fmt(openingLocal)}</b></div><div><small>Partidas en tránsito</small><b>${fmt(depositsLocal)} / ${fmt(checksLocal)}</b><small>Depósitos / cheques en moneda local</small></div>`;
 $('bankReconciliation').innerHTML=reconciliation.map(row=>{
  const difference=Number(firstValue(row,'difference','variance')||0),localDifference=Number(firstValue(row,'localDifference','differenceLocal')||0),ok=Math.abs(difference)<=.005&&Math.abs(localDifference)<=.005;
  const bank=[firstValue(row,'bankCode','bank_code'),firstValue(row,'bankName','bank_name')].filter(Boolean).map(esc).join(' · ');
  const account=firstValue(row,'accountNumber','account_number','bankAccountNumber');
  const ledgerNumber=firstValue(row,'ledgerAccountNumber','account','accountNumberGl','glAccountNumber');
  const ledgerName=firstValue(row,'ledgerAccountName','accountName','glAccountName');
  return`<tr><td><b>${bank||'Banco'}</b><small>${esc(account)}</small></td><td><b>${esc(ledgerNumber)}</b><small>${esc(ledgerName)}</small></td><td>${esc(firstValue(row,'currency','currencyCode'))}</td><td class="num">${fmt(firstValue(row,'ledger','generalLedger'))}<small>Local: ${fmt(firstValue(row,'ledgerLocal','generalLedgerLocal'))}</small></td><td class="num"><b>${fmt(firstValue(row,'auxiliary','bankAuxiliary'))}</b><small>Local: ${fmt(firstValue(row,'auxiliaryLocal','bankAuxiliaryLocal'))}</small></td><td class="num ${ok?'':'bad-text'}">${fmt(difference)}<small>Local: ${fmt(localDifference)}</small></td><td><span class="row-status ${ok?'ok':'bad'}">${ok?'Cuadra':'Diferencia'}</span></td></tr>`;
 }).join('')||'<tr><td colspan="7" class="empty">No hay cuentas bancarias para conciliar.</td></tr>';
 $('bankItems').innerHTML=items.map(item=>{
  const errors=Array.isArray(item.errors)?item.errors.filter(Boolean):[item.error||item.validationError].filter(Boolean);
  const created=Boolean(firstValue(item,'created','createdBankTransactionId','bankTransactionId','active'));
  const statusClass=errors.length?'bad':created?'created':'pending',statusText=errors.length?errors.join(' · '):created?'Cargado':'Por cargar';
  const bank=[firstValue(item,'bankCode','bank_code'),firstValue(item,'bankName','bank_name')].filter(Boolean).map(esc).join(' · ');
  const detail=[firstValue(item,'beneficiary'),firstValue(item,'description')].filter(Boolean).map(esc).join(' · ');
  const date=firstValue(item,'transactionDate','transaction_date','date'),valueDate=firstValue(item,'valueDate','value_date');
  return`<tr><td>${esc(firstValue(item,'row','sourceRow','source_row'))}</td><td><b>${bank||'Banco'}</b><small>${esc(firstValue(item,'accountNumber','account_number'))}</small></td><td><span class="source">${esc(bankTypeLabel(firstValue(item,'recordType','record_type','type')))}</span></td><td>${esc(date)}${valueDate?`<small>Fecha valor: ${esc(valueDate)}</small>`:''}</td><td><b>${esc(firstValue(item,'reference')||'—')}</b><small>${detail||'Sin detalle adicional'}</small></td><td>${esc(firstValue(item,'currency','currencyCode'))}</td><td class="num">${fmt(firstValue(item,'originalAmount','original_amount','amount'))}</td><td class="num">${fmt(firstValue(item,'localEquivalent','local_equivalent','localAmount'))}</td><td><span class="row-status ${statusClass}">${esc(statusText)}</span></td></tr>`;
 }).join('')||'<tr><td colspan="9" class="empty">El archivo no contiene registros bancarios para mostrar.</td></tr>';
 const pendingCount=Number(firstValue(summary,'pending','pendingCount','recordsPending')||0);
 const hasBankToCreate=pendingCount>0||items.some(item=>item.created===false||['PENDING','STAGED','POR_CARGAR'].includes(String(firstValue(item,'status','state')||'').toUpperCase()));
 return{hasBanks:true,balanced,hasBankToCreate};
}

function renderDimensions(row){
 const dimensions=[
  ['Departamento',row.department],['Centro de costos',row.costCenter],['Clase',row.className],
  ['Acreedor financiero',row.financialCreditor],['Compañía relacionada',row.relatedCompany],['Sucursal',row.location]
 ].filter(([,value])=>value!==null&&value!==undefined&&String(value).trim()!=='');
 return dimensions.length?`<span class="dimension-list">${dimensions.map(([label,value])=>`<small><b>${label}:</b> ${esc(value)}</small>`).join('')}</span>`:'—';
}

function bankPreviewHasDifferences(data){
 const summary=data.bankSummary||data.banks?.summary||{};
 const reconciliation=data.bankReconciliation||data.banks?.reconciliation||[];
 return summary.balanced===false||reconciliation.some(row=>
  Math.abs(Number(firstValue(row,'difference','variance')||0))>.005
  ||Math.abs(Number(firstValue(row,'localDifference','differenceLocal')||0))>.005
 );
}

function renderBalanceDifference(summary){
 const difference=Number(summary.difference||0),panel=$('balanceDifference');
 if(Math.abs(difference)<=.005){panel.hidden=true;panel.innerHTML='';return;}
 const missing=difference>0?'crédito':'débito';
 const symbols={JMD:'J$',USD:'US$',CRC:'₡',EUR:'€',COP:'COL$',PEN:'S/',PAB:'B/.'};
 const currency=String(functionalCurrency||firstValue(summary,'currency','localCurrency')||'').toUpperCase();
 const amount=`${symbols[currency]||currency||''}${symbols[currency]?' ':currency?' ':''}${fmt(Math.abs(difference))}`;
 panel.innerHTML=`<b>La apertura todavía no cuadra.</b><span>Después de excluir las cuentas de control duplicadas, falta un <strong>${missing}</strong> por <strong>${esc(amount)}</strong>. Revise las líneas del Libro Mayor y las diferencias de conciliación mostradas abajo.</span>`;
 panel.hidden=false;
}

function originalAmount(row,side){
 const explicit=row[side==='debit'?'debitFx':'creditFx'];
 if(explicit!==null&&explicit!==undefined&&explicit!=='')return explicit;
 return Number(row[side]||0)>0?row.foreignAmount||0:0;
}

function historicalRateSource(row){
 const source=String(firstValue(row,'rateSource','historicalRateSource')||'').toUpperCase();
 const label=firstValue(row,'rateSourceLabel','historicalRateSourceLabel')||({
  LOCAL_CURRENCY:'Moneda local',
  EXPLICIT_LOCAL_AND_RATE:'Tasa informada',
  EXPLICIT_LOCAL:'Tasa informada',
  EXPLICIT_RATE:'Tasa informada',
  GL_RESIDUAL:'Inferida del Mayor'
 }[source]||'');
 return{source,label};
}

function show(data){
 const summary=data.summary||{},run=data.run||{};
 lastPreview=data;
 runId=run.id||data.runId||runId;posted=run.status==='POSTED';
 if(runId&&window.NexoRecordAudit?.show)window.NexoRecordAudit.show('opening_balance_runs',runId,'main');
 $('summary').hidden=false;
 $('summary').innerHTML=`<div><small>Líneas contables</small><b>${summary.count||0}</b></div><div><small>Débitos</small><b>${fmt(summary.debit)}</b></div><div><small>Créditos</small><b>${fmt(summary.credit)}</b></div><div><small>Diferencia real del Libro Mayor</small><b class="${Math.abs(Number(summary.difference||0))>.005?'bad-text':''}">${fmt(summary.difference)}</b></div>`;
 renderBalanceDifference(summary);
 $('rows').innerHTML=(data.rows||[]).map(row=>{
  const rateSource=historicalRateSource(row);
  const rateSourceBadge=['AR','AP'].includes(String(row.sourceType).toUpperCase())&&rateSource.label
   ?`<small class="rate-source ${rateSource.source==='GL_RESIDUAL'?'inferred':'declared'}">${esc(rateSource.label)}</small>`:'';
  return`<tr><td><span class="source">${esc(row.sourceType)}</span></td><td>${row.row}</td><td>${esc(row.account)}</td><td>${esc(row.document||'—')}</td><td><b>${esc(row.currency)}</b><small>Tasa: ${esc(row.rate)}</small>${rateSourceBadge}</td><td>${renderDimensions(row)}</td><td class="num">${fmt(row.debit)}</td><td class="num">${fmt(row.credit)}</td><td class="num">${fmt(originalAmount(row,'debit'))}</td><td class="num">${fmt(originalAmount(row,'credit'))}</td></tr>`;
 }).join('')||'<tr><td colspan="10" class="empty">El lote no contiene líneas contables para mostrar.</td></tr>';
 const arApState=renderArAp(data);
 renderAssets(data);
 const pendingState=renderPending(data);
 const bankState=renderBanks(data);
 const assetSummary=data.assetSummary||{},hasPendingAssets=Number(assetSummary.pending||0)>0,assetsBalanced=assetSummary.balanced!==false;
 $('post').textContent=posted?'Cargar auxiliares validados':'Contabilizar saldos iniciales';
 $('post').disabled=!canCreate||Math.abs(Number(summary.difference||0))>.005||!arApState.balanced||!assetsBalanced||!pendingState.balanced||!bankState.balanced||(posted&&!hasPendingAssets&&!pendingState.hasPendingToCreate&&!bankState.hasBankToCreate)||(!posted&&run.status!=='VALIDATED');
 $('reverse').hidden=!canReverse||!posted;
 for(const id of ['date','type','transition'])$(id).disabled=!canCreate||posted;
 for(const id of ['gl','ar','ap']){
  $(id).disabled=!canCreate||posted;
  if(posted){$(id).value='';$(`${id}Name`).textContent='No aplica después de contabilizar';}
 }
}

async function init(){
 try{
  const data=await api('options');
  subsidiaryId=data.subsidiary.id;functionalCurrency=String(data.subsidiary.currency||'').toUpperCase();canCreate=data.canCreate===true;canReverse=data.canReverse===true;$('validate').disabled=!canCreate;
  for(const id of ['date','type','transition','gl','ar','ap','fa','pending','banks'])$(id).disabled=!canCreate;
  $('company').textContent=data.subsidiary.name;$('currency').textContent=`Moneda funcional: ${data.subsidiary.currency}`;
  const categories=data.assetCategories||[];
  $('faCatalogHint').textContent=categories.length?`Categorías válidas: ${categories.map(item=>item.code).join(', ')}`:'Configure primero una categoría activa de Activos Fijos.';
  const bankAccounts=data.bankAccounts||[];
  $('bankCatalogHint').textContent=bankAccounts.length
   ?`Cuentas válidas: ${bankAccounts.map(item=>`${item.bankCode} · ${item.accountNumber} (${item.currency})`).join(', ')}`
   :'Configure primero una cuenta bancaria activa para la subsidiaria.';
  const transitionAccounts=data.accounts.filter(account=>account.number==='319999'),existingRun=data.run;
  if(!transitionAccounts.length&&existingRun?.status!=='POSTED')throw Error('La cuenta transitoria 319999 no está asignada a esta subsidiaria.');
  const transitionOptions=transitionAccounts.map(account=>`<option value="${account.id}">${esc(account.number)} · ${esc(account.name)}</option>`);
  if(existingRun?.status==='POSTED'&&!transitionAccounts.some(account=>String(account.id)===String(existingRun.transition_account_id)))transitionOptions.push(`<option value="${existingRun.transition_account_id}">Cuenta usada en la apertura contabilizada</option>`);
  $('transition').innerHTML=transitionOptions.join('');
  $('transition').value=String(existingRun?.transition_account_id||transitionAccounts[0].id);
  if(existingRun){runId=existingRun.id;$('date').value=existingRun.opening_date;$('type').value=existingRun.load_type;show(await api('preview',{runId}));}
  if(!canCreate)setMessage(canReverse?'Su rol puede consultar y reversar una apertura contabilizada, pero no validar ni contabilizar cargas.':'Modo de consulta: su rol puede revisar la apertura, pero no validarla, contabilizarla ni reversarla.','working');
 }catch(error){setMessage(error.message);}
}

function invalidateValidation(){
 $('post').disabled=true;
 if(runId)setMessage('Los datos cambiaron. Valide nuevamente antes de contabilizar.','working');
}

for(const id of uploadIds)$(id).addEventListener('change',()=>{
 const name=selectedFileName(id),nameElement=$(`${id}Name`);
 nameElement.textContent=name||'Ningún archivo';nameElement.title=name;
 clearValidationErrors(id);invalidateValidation();
});
for(const id of ['date','type','transition'])$(id).addEventListener('change',invalidateValidation);

$('validationErrorFiles').addEventListener('click',event=>{
 const button=event.target.closest('[data-reselect]');if(!button)return;
 const id=button.dataset.reselect,input=$(id);if(!input)return;
 input.value='';$(`${id}Name`).textContent='Ningún archivo';$(`${id}Name`).removeAttribute('title');
 clearValidationErrors(id);invalidateValidation();input.click();
});

$('validate').onclick=async()=>{
 const controls=beginWork();if(!controls)return;
 let data=null;
 try{
  assertActiveCompany();
  clearValidationErrors();
  setMessage('Validando archivos, catálogos y conciliación…','working');
  const ids=posted?['fa','pending','banks']:uploadIds,uploads=await readSelectedUploads(ids);
  const files=Object.fromEntries(uploadIds.map(id=>[id,uploads[id]??'']));
  const fileNames=Object.fromEntries(uploadIds.map(id=>[`${id}FileName`,selectedFileName(id)]));
  data=await api('validate',{expectedSubsidiaryId:subsidiaryId,openingDate:$('date').value,loadType:$('type').value,transitionAccountId:$('transition').value,...files,...fileNames});
 }catch(error){
  if(Array.isArray(error.files)&&error.files.length){showValidationErrors(error.files);setMessage('La validación encontró archivos que requieren corrección.','error');}
  else setMessage(error.message);
 }
 finally{endWork(controls);}
  if(data){
   clearValidationErrors();show(data);
   if(bankPreviewHasDifferences(data))setMessage('Validación completada con diferencias bancarias. Revise la conciliación del Auxiliar de Bancos por cuenta y moneda antes de contabilizar.','error');
   else setMessage(data.run?.status==='POSTED'?'Auxiliares validados. Revise las conciliaciones antes de completar la carga.':'Validación correcta. Revise la balanza y las conciliaciones antes de contabilizar.','success');
  }else $('post').disabled=true;
};

function localizedOpeningDate(value){
 const parts=String(value||'').split('-').map(Number);
 if(parts.length!==3||parts.some(part=>!Number.isFinite(part)))return value||'—';
 return new Date(parts[0],parts[1]-1,parts[2]).toLocaleDateString('es-CR',{day:'2-digit',month:'long',year:'numeric'});
}

function countPreviewItems(summary,items,totalKeys,pendingKeys=[]){
 const list=Array.isArray(items)?items:[];
 const keys=posted?pendingKeys:totalKeys;
 const explicit=firstValue(summary,...keys);
 if(explicit!==undefined)return Math.max(0,Number(explicit)||0);
 if(!posted)return list.length;
 return list.filter(item=>!Boolean(firstValue(item,'created','active','isActive','createdPendingId','pendingId','createdBankTransactionId','bankTransactionId'))).length;
}

function postAuxiliaryCounts(data){
 const financialRows=Array.isArray(data.rows)?data.rows:[];
 const arAp=data.arApSummary||data.arAp?.summary||{};
 const assets=Array.isArray(data.assets)?data.assets:[];
 const pendingItems=data.pendingItems||data.pendings||data.pending?.items||[];
 const bankItems=data.bankItems||data.banks?.items||[];
 const assetSummary=data.assetSummary||{};
 const pendingSummary=data.pendingSummary||data.pending?.summary||{};
 const bankSummary=data.bankSummary||data.banks?.summary||{};
 const arCount=posted?0:Number(firstValue(arAp,'arDocuments','receivableDocuments','arCount')??financialRows.filter(row=>String(firstValue(row,'sourceType','source_type')).toUpperCase()==='AR').length);
 const apCount=posted?0:Number(firstValue(arAp,'apDocuments','payableDocuments','apCount')??financialRows.filter(row=>String(firstValue(row,'sourceType','source_type')).toUpperCase()==='AP').length);
 return[
  {label:'Facturas por cobrar',value:arCount},
  {label:'Facturas por pagar',value:apCount},
  {label:'Activos fijos',value:countPreviewItems(assetSummary,assets,['count','records','items'],['pending','pendingCount'])},
  {label:'Pendientes de facturar',value:countPreviewItems(pendingSummary,pendingItems,['count','items','references'],['pending','pendingCount','recordsPending'])},
  {label:'Registros bancarios',value:countPreviewItems(bankSummary,bankItems,['count','records','items'],['pending','pendingCount','recordsPending'])}
 ].filter(item=>item.value>0);
}

function populatePostConfirmation(){
 const data=lastPreview||{},summary=data.summary||{},dialog=$('postConfirmationDialog');
 const auxiliaryMode=posted===true;
 dialog.classList.toggle('auxiliary-mode',auxiliaryMode);
 $('postConfirmTitle').textContent=auxiliaryMode?'Cargar auxiliares validados':'Contabilizar saldos iniciales';
 $('postConfirmDescription').textContent=auxiliaryMode?'Confirme la carga complementaria sobre la apertura ya contabilizada.':'Revise el lote validado antes de generar el asiento de apertura.';
 $('postConfirmOperation').textContent=auxiliaryMode?'CARGA COMPLEMENTARIA':'APERTURA CONTABLE';
 $('postConfirmOperationText').textContent=auxiliaryMode?'Solo se crearán los auxiliares nuevos incluidos en esta validación.':'El lote está cuadrado, conciliado y listo para contabilizar.';
 $('postConfirmCompany').textContent=$('company').textContent||'—';
 $('postConfirmDate').textContent=localizedOpeningDate($('date').value);
 $('postConfirmLoadType').textContent=$('type').selectedOptions?.[0]?.textContent||'—';
 $('postConfirmLines').textContent=Number(summary.count||0).toLocaleString('es-CR');
 $('postConfirmCurrency').textContent=functionalCurrency||'—';
 const currency=functionalCurrency?`${functionalCurrency} `:'';
 $('postConfirmDebit').textContent=`${currency}${fmt(summary.debit)}`;
 $('postConfirmCredit').textContent=`${currency}${fmt(summary.credit)}`;
 const auxiliaries=postAuxiliaryCounts(data);
 $('postConfirmAuxTitle').textContent=auxiliaryMode?'Auxiliares nuevos que se cargarán':'Auxiliares que se crearán';
 $('postConfirmAuxiliaries').innerHTML=auxiliaries.length
  ?auxiliaries.map(item=>`<div class="post-confirmation-auxiliary"><b>${item.value.toLocaleString('es-CR')}</b><small>${esc(item.label)}</small></div>`).join('')
  :'<div class="post-confirmation-auxiliary empty"><b>0</b><small>No hay auxiliares nuevos en este lote.</small></div>';
 $('postConfirmNotice').innerHTML=auxiliaryMode
  ?'<span aria-hidden="true">i</span><p><b>El Libro Mayor no se contabilizará nuevamente</b><small>Esta operación conserva el asiento de apertura existente y crea únicamente el detalle auxiliar pendiente.</small></p>'
  :'<span aria-hidden="true">i</span><p><b>Operación definitiva</b><small>Se generará el asiento de apertura y se crearán los auxiliares mostrados. Revise los totales antes de continuar.</small></p>';
 $('postConfirmSubmit').textContent=auxiliaryMode?'Cargar auxiliares':'Contabilizar definitivamente';
}

function setPostConfirmationBusy(busy,error=''){
 postSubmitting=busy;
 const dialog=$('postConfirmationDialog'),progress=$('postConfirmProgress');
 dialog.setAttribute('aria-busy',busy?'true':'false');
 $('postConfirmSubmit').disabled=busy;
 $('postConfirmCancel').disabled=busy;
 $('postConfirmClose').disabled=busy;
 if(error){
  progress.className='post-confirmation-progress error';
  progress.textContent=error;
  progress.hidden=false;
 }else if(busy){
  progress.className='post-confirmation-progress';
  progress.innerHTML=`<span aria-hidden="true"></span>${posted?'Cargando auxiliares sin repostear el Libro Mayor…':'Contabilizando la apertura y creando auxiliares…'}`;
  progress.hidden=false;
 }else{
  progress.className='post-confirmation-progress';progress.hidden=true;progress.textContent='';
 }
}

function finishPostConfirmation(){
 const dialog=$('postConfirmationDialog');
 setPostConfirmationBusy(false);
 if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');
 document.body.classList.remove('dialog-open');
 postDialogReturnFocus?.focus?.();postDialogReturnFocus=null;
}

function dismissPostConfirmation(){
 if(postSubmitting)return;
 finishPostConfirmation();
}

function openPostConfirmation(){
 if(working||postSubmitting)return;
 populatePostConfirmation();setPostConfirmationBusy(false);
 const dialog=$('postConfirmationDialog');postDialogReturnFocus=document.activeElement;
 document.body.classList.add('dialog-open');
 if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
 requestAnimationFrame(()=>$('postConfirmCancel').focus());
}

async function submitValidatedOpening(){
 if(postSubmitting||working)return;
 let controls=null,result=null,preview=null,failure=null;
 try{
  assertActiveCompany();
  if(!runId)throw Error('Valide nuevamente la carga antes de contabilizar.');
  controls=beginWork();if(!controls)return;
  setPostConfirmationBusy(true);
  result=await api('post',{runId});
  preview=await api('preview',{runId}).catch(()=>null);
 }catch(error){failure=error;setMessage(error.message);}
 finally{if(controls)endWork(controls);}
 if(!result){
  setPostConfirmationBusy(false,failure?.message||'No fue posible completar la contabilización.');
  return;
 }
 const pendingCreated=Number(result.pendingCreated||result.pendingItemsCreated||result.pendingActivated||0);
 const banksCreated=Number(result.banksCreated||result.bankItemsCreated||result.bankTransactionsCreated||0);
 const completion=result.auxiliariesOnly||result.assetsOnly||result.pendingOnly||result.bankOnly||result.banksOnly?`Auxiliares cargados: ${result.assetsCreated||0} activo(s), ${pendingCreated} pendiente(s) de facturar y ${banksCreated} registro(s) bancario(s).`:`Apertura contabilizada: ${result.journalNumber}. Activos creados: ${result.assetsCreated||0}. Pendientes creados: ${pendingCreated}. Registros bancarios: ${banksCreated}.`;
 setMessage(completion,'success');
 for(const id of ['fa','pending','banks']){$(id).value='';$(`${id}Name`).textContent='Ningún archivo';}
 if(preview)show(preview);else $('post').disabled=true;
 finishPostConfirmation();
}

$('postConfirmationDialog').addEventListener('cancel',event=>{event.preventDefault();dismissPostConfirmation();});
$('postConfirmationDialog').addEventListener('click',event=>{if(event.target===$('postConfirmationDialog'))dismissPostConfirmation();});
$('postConfirmationDialog').addEventListener('keydown',event=>{
 if(event.key!=='Tab')return;
 const controls=[...$('postConfirmationDialog').querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(element=>element.offsetParent!==null);
 if(!controls.length){event.preventDefault();$('postConfirmationDialog').focus();return;}
 const first=controls[0],last=controls.at(-1);
 if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
 else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
$('postConfirmClose').onclick=dismissPostConfirmation;
$('postConfirmCancel').onclick=dismissPostConfirmation;
$('postConfirmSubmit').onclick=submitValidatedOpening;

$('post').onclick=()=>{
 try{assertActiveCompany();openPostConfirmation();}catch(error){setMessage(error.message);}
};

$('reverse').onclick=async()=>{
 try{assertActiveCompany();}catch(error){setMessage(error.message);return;}
 if(!confirm('Esta acción generará un asiento reverso, eliminará los documentos iniciales y marcará como inactivos los activos de apertura que no tengan movimientos posteriores. ¿Continuar?'))return;
 const controls=beginWork();if(!controls)return;
 let result=null;
 try{
  result=await api('reverse',{runId});
 }
 catch(error){setMessage(error.message);}
 finally{endWork(controls);}
 if(result){posted=false;runId=null;lastPreview=null;
  for(const id of ['date','type','transition','gl','ar','ap'])$(id).disabled=!canCreate;
  for(const id of ['gl','ar','ap','fa','pending','banks']){$(id).value='';$(`${id}Name`).textContent='Ningún archivo';}
  $('summary').hidden=true;$('balanceDifference').hidden=true;$('balanceDifference').innerHTML='';$('arApSummarySection').hidden=true;$('assetSummarySection').hidden=true;$('pendingSummarySection').hidden=true;$('bankSummarySection').hidden=true;$('rows').innerHTML='';$('reverse').hidden=true;$('post').disabled=true;
  setMessage(`Apertura reversada: ${result.number}. Ya puede preparar una nueva carga.`,'success');
 }
};

await init();
