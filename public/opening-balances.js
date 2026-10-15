const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=()=>localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'';
const fmt=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=value=>String(value??'—').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let runId=null,posted=false,canCreate=false,canReverse=false,subsidiaryId=null,working=false;

async function api(action,body={}){
 const response=await fetch(`/api/opening-balances/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,'X-Device-Token':device()},body:JSON.stringify(body)});
 const data=await response.json();
 if(!response.ok)throw Error(data.error?.message||'No fue posible procesar la apertura.');
 return data;
}

const uploadNames={gl:'Libro Mayor',ar:'Cuentas por Cobrar',ap:'Cuentas por Pagar',fa:'Activos Fijos',pending:'Pendientes de Facturar'};
const readUpload=id=>new Promise((resolve,reject)=>{
 const file=$(id).files[0];if(!file)return resolve('');
 if(file.size>5_000_000)return reject(Error(`El archivo de ${uploadNames[id]} supera 5 MB.`));
 if(file.name.toLowerCase().endsWith('.csv')){
  const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(file,'utf-8');return;
 }
 if(!file.name.toLowerCase().endsWith('.xlsx'))return reject(Error(`Seleccione un archivo CSV o Excel (.xlsx) para ${uploadNames[id]}.`));
 const reader=new FileReader();
 reader.onload=()=>resolve({fileName:file.name,base64:String(reader.result).split(',')[1]||''});
 reader.onerror=reject;
 reader.readAsDataURL(file);
});

function setMessage(text,type='error'){$('message').className=type;$('message').textContent=text;}

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
 $('pendingSummary').innerHTML=`<div><small>Referencias del archivo</small><b>${count.toLocaleString('es-CR')}</b></div><div><small>Importe inicial</small><b>${fmt(firstValue(summary,'initial','initialAmount','initialLocal'))}</b></div><div><small>Importe reversado</small><b>${fmt(firstValue(summary,'reversed','reversedAmount','reversedLocal'))}</b></div><div><small>Saldo por reversar</small><b>${fmt(firstValue(summary,'balance','pendingAmount','balanceLocal'))}</b></div>`;
 $('pendingReconciliation').innerHTML=reconciliation.map(row=>{
  const difference=Number(firstValue(row,'difference','variance')||0),foreignDifference=Number(firstValue(row,'foreignDifference','differenceForeign')||0),ok=Math.abs(difference)<=.005&&Math.abs(foreignDifference)<=.005;
  return`<tr><td><b>${esc(firstValue(row,'accountNumber','account','number')||'113003')}</b><small>${esc(firstValue(row,'accountName','name')||'Facturación Pendiente de Emitir')} · ${esc(firstValue(row,'currency','currencyCode'))}</small></td><td class="num">${fmt(firstValue(row,'ledger','generalLedger','gl'))}<small>Original: ${fmt(firstValue(row,'ledgerForeign','generalLedgerForeign'))}</small></td><td class="num">${fmt(firstValue(row,'existing','registered'))}</td><td class="num">${fmt(firstValue(row,'staged','file','uploaded'))}</td><td class="num"><b>${fmt(firstValue(row,'auxiliary','total'))}</b><small>Original: ${fmt(firstValue(row,'auxiliaryForeign','totalForeign'))}</small></td><td class="num ${ok?'':'bad-text'}">${fmt(difference)}<small>Original: ${fmt(foreignDifference)}</small></td><td><span class="row-status ${ok?'ok':'bad'}">${ok?'Cuadra':'Diferencia'}</span></td></tr>`;
 }).join('')||'<tr><td colspan="7" class="empty">No hay cuentas de pendientes para conciliar.</td></tr>';
 $('pendingItems').innerHTML=items.map(item=>{
  const errors=Array.isArray(item.errors)?item.errors.filter(Boolean):[item.error||item.validationError].filter(Boolean);
  const created=Boolean(firstValue(item,'created','createdPendingId','pendingId'));
  const statusClass=errors.length?'bad':created?'created':'pending';
  const statusText=errors.length?errors.join(' · '):created?'Cargado':'Por cargar';
  const customer=firstValue(item,'customerName','customer','thirdParty')||'Cliente no identificado';
  const customerId=firstValue(item,'customerIdentification','customerTaxId','identification');
  const service=[firstValue(item,'serviceMonth','month'),firstValue(item,'serviceCountry','country')].filter(Boolean).map(esc).join(' · ');
  const line=Array.isArray(item.lines)?item.lines.find(row=>row.role==='CONTROL')||item.lines[0]||{}:{};
  const dimensions=[firstValue(item,'department')??line.department,firstValue(item,'costCenter')??line.costCenter].filter(Boolean).map(esc).join(' · ');
  const supportUrl=firstValue(item,'supportUrl')||(Array.isArray(item.supports)?item.supports.find(support=>support?.url)?.url:'');
  const support=/^https:\/\//i.test(String(supportUrl||''))?`<small><a href="${esc(supportUrl)}" target="_blank" rel="noopener noreferrer">Abrir respaldo</a></small>`:'';
  return`<tr><td><b>${esc(firstValue(item,'reference','pendingReference','number'))}</b><small>${esc(firstValue(item,'note','description')||'Saldo inicial')}</small>${support}</td><td>${esc(customer)}${customerId?`<small>${esc(customerId)}</small>`:''}</td><td>${esc(firstValue(item,'originDate','date'))}</td><td>${service||'—'}<small>${dimensions||'Sin dimensiones'}</small></td><td><b>${esc(firstValue(item,'currency','currencyCode'))}</b><small>Tasa histórica: ${esc(firstValue(item,'rate','historicalRate','exchangeRate')??'—')}</small></td><td class="num">${fmt(firstValue(item,'initial','initialAmount','initialLocal'))}</td><td class="num">${fmt(firstValue(item,'reversed','reversedAmount','reversedLocal'))}</td><td class="num"><b>${fmt(firstValue(item,'balance','pendingAmount','balanceLocal'))}</b></td><td><span class="row-status ${statusClass}">${esc(statusText)}</span></td></tr>`;
 }).join('')||'<tr><td colspan="9" class="empty">El archivo no contiene referencias pendientes para mostrar.</td></tr>';
 const hasPendingToCreate=items.some(item=>!Boolean(firstValue(item,'created','active','isActive')));
 return{hasPending:true,balanced,hasPendingToCreate};
}

function renderDimensions(row){
 const dimensions=[
  ['Departamento',row.department],['Centro de costos',row.costCenter],['Clase',row.className],
  ['Acreedor financiero',row.financialCreditor],['Compañía relacionada',row.relatedCompany],['Sucursal',row.location]
 ].filter(([,value])=>value!==null&&value!==undefined&&String(value).trim()!=='');
 return dimensions.length?`<span class="dimension-list">${dimensions.map(([label,value])=>`<small><b>${label}:</b> ${esc(value)}</small>`).join('')}</span>`:'—';
}

function originalAmount(row,side){
 const explicit=row[side==='debit'?'debitFx':'creditFx'];
 if(explicit!==null&&explicit!==undefined&&explicit!=='')return explicit;
 return Number(row[side]||0)>0?row.foreignAmount||0:0;
}

function show(data){
 const summary=data.summary||{},run=data.run||{};
 runId=run.id||data.runId||runId;posted=run.status==='POSTED';
 if(runId&&window.NexoRecordAudit?.show)window.NexoRecordAudit.show('opening_balance_runs',runId,'main');
 $('summary').hidden=false;
 $('summary').innerHTML=`<div><small>Líneas contables</small><b>${summary.count||0}</b></div><div><small>Débitos</small><b>${fmt(summary.debit)}</b></div><div><small>Créditos</small><b>${fmt(summary.credit)}</b></div><div><small>Diferencia</small><b class="${Math.abs(Number(summary.difference||0))>.005?'bad-text':''}">${fmt(summary.difference)}</b></div>`;
 $('rows').innerHTML=(data.rows||[]).map(row=>`<tr><td><span class="source">${esc(row.sourceType)}</span></td><td>${row.row}</td><td>${esc(row.account)}</td><td>${esc(row.document||'—')}</td><td><b>${esc(row.currency)}</b><small>Tasa: ${esc(row.rate)}</small></td><td>${renderDimensions(row)}</td><td class="num">${fmt(row.debit)}</td><td class="num">${fmt(row.credit)}</td><td class="num">${fmt(originalAmount(row,'debit'))}</td><td class="num">${fmt(originalAmount(row,'credit'))}</td></tr>`).join('')||'<tr><td colspan="10" class="empty">El lote no contiene líneas contables para mostrar.</td></tr>';
 renderAssets(data);
 const pendingState=renderPending(data);
 const assetSummary=data.assetSummary||{},hasPendingAssets=Number(assetSummary.pending||0)>0,assetsBalanced=assetSummary.balanced!==false;
 $('post').textContent=posted?'Cargar auxiliares validados':'Contabilizar saldos iniciales';
 $('post').disabled=!canCreate||Math.abs(Number(summary.difference||0))>.005||!assetsBalanced||!pendingState.balanced||(posted&&!hasPendingAssets&&!pendingState.hasPendingToCreate)||(!posted&&run.status!=='VALIDATED');
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
  subsidiaryId=data.subsidiary.id;canCreate=data.canCreate===true;canReverse=data.canReverse===true;$('validate').disabled=!canCreate;
  for(const id of ['date','type','transition','gl','ar','ap','fa','pending'])$(id).disabled=!canCreate;
  $('company').textContent=data.subsidiary.name;$('currency').textContent=`Moneda funcional: ${data.subsidiary.currency}`;
  const categories=data.assetCategories||[];
  $('faCatalogHint').textContent=categories.length?`Categorías válidas: ${categories.map(item=>item.code).join(', ')}`:'Configure primero una categoría activa de Activos Fijos.';
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

for(const id of ['gl','ar','ap','fa','pending'])$(id).addEventListener('change',()=>{$(`${id}Name`).textContent=$(id).files[0]?.name||'Ningún archivo';invalidateValidation();});
for(const id of ['date','type','transition'])$(id).addEventListener('change',invalidateValidation);

$('validate').onclick=async()=>{
 const controls=beginWork();if(!controls)return;
 let data=null;
 try{
  assertActiveCompany();
  setMessage('Validando archivos, catálogos y conciliación…','working');
  let gl='',ar='',ap='',fa='',pending='';
  if(posted)[fa,pending]=await Promise.all(['fa','pending'].map(readUpload));else[gl,ar,ap,fa,pending]=await Promise.all(['gl','ar','ap','fa','pending'].map(readUpload));
  data=await api('validate',{expectedSubsidiaryId:subsidiaryId,openingDate:$('date').value,loadType:$('type').value,transitionAccountId:$('transition').value,gl,ar,ap,fa,pending});
 }catch(error){setMessage(error.message);}
 finally{endWork(controls);}
  if(data){show(data);setMessage(data.run?.status==='POSTED'?'Auxiliares validados. Revise las conciliaciones antes de completar la carga.':'Validación correcta. Revise la balanza y las conciliaciones antes de contabilizar.','success');}else $('post').disabled=true;
};

$('post').onclick=async()=>{
 try{assertActiveCompany();}catch(error){setMessage(error.message);return;}
 const question=posted?'¿Cargar los auxiliares validados? Los importes no se contabilizarán nuevamente.':'¿Contabilizar definitivamente los saldos iniciales y crear sus auxiliares?';
 if(!confirm(question))return;
 const controls=beginWork();if(!controls)return;
 let result=null,preview=null;
 try{
  result=await api('post',{runId});preview=await api('preview',{runId}).catch(()=>null);
 }catch(error){setMessage(error.message);}
 finally{endWork(controls);}
 if(result){
  const pendingCreated=Number(result.pendingCreated||result.pendingItemsCreated||result.pendingActivated||0);
  const completion=result.auxiliariesOnly||result.assetsOnly||result.pendingOnly?`Auxiliares cargados: ${result.assetsCreated||0} activo(s) y ${pendingCreated} pendiente(s) de facturar.`:`Apertura contabilizada: ${result.journalNumber}. Activos creados: ${result.assetsCreated||0}. Pendientes creados: ${pendingCreated}.`;
  setMessage(completion,'success');
  for(const id of ['fa','pending']){$(id).value='';$(`${id}Name`).textContent='Ningún archivo';}
  if(preview)show(preview);else $('post').disabled=true;
 }
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
 if(result){posted=false;runId=null;
  for(const id of ['date','type','transition','gl','ar','ap'])$(id).disabled=!canCreate;
  for(const id of ['gl','ar','ap','fa','pending']){$(id).value='';$(`${id}Name`).textContent='Ningún archivo';}
  $('summary').hidden=true;$('assetSummarySection').hidden=true;$('pendingSummarySection').hidden=true;$('rows').innerHTML='';$('reverse').hidden=true;$('post').disabled=true;
  setMessage(`Apertura reversada: ${result.number}. Ya puede preparar una nueva carga.`,'success');
 }
};

await init();
