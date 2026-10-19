const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=()=>localStorage.getItem('nexo_device_token')||'';
const state={options:{},report:{header:{},summary:{},rows:[],total:0},page:1,expanded:new Set(),loading:false,generated:false};

if(!token())location.assign('/');

function headers(hasBody=false){return{Authorization:`Bearer ${token()}`,'X-Device-Token':device(),...(hasBody?{'Content-Type':'application/json'}:{})}}
async function api(path,init={}){
  const response=await fetch(path,{...init,headers:{...headers(Boolean(init.body)),...(init.headers||{})}});
  const raw=await response.text();let payload=null;try{payload=raw?JSON.parse(raw):null}catch{payload=raw}
  if(response.status===401){sessionStorage.setItem('nexo_return_to',location.pathname+location.search);location.assign('/');throw Error('La sesión expiró. Inicie sesión nuevamente.')}
  if(!response.ok)throw Error(payload?.error?.message||payload?.message||'No fue posible completar la operación.');
  return payload;
}

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>Number(value||0);
const integer=value=>number(value).toLocaleString('es-CR',{maximumFractionDigits:0});
const array=value=>Array.isArray(value)?value:[];
const first=(...values)=>values.find(value=>value!==undefined&&value!==null&&value!=='');
const optionValue=item=>typeof item==='string'?item:first(item.value,item.id,item.userId,item.subsidiaryId,item.subsidiary_id,item.code,item.key,item.module,item.entityType,'');
const optionLabel=item=>typeof item==='string'?item:first(item.label,item.name,item.subsidiaryName,item.subsidiary_name,item.legalName,item.displayName,[item.firstName,item.lastName].filter(Boolean).join(' '),item.email,item.value,item.code,'');
const actorName=actor=>first(actor?.name,actor?.displayName,[actor?.firstName,actor?.lastName].filter(Boolean).join(' '),actor?.email,'Usuario no identificado');
const currentMonth=()=>{const value=new Date();return`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}`};
const monthLabel=value=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value||'')))return String(value||'—');const parsed=new Date(`${value}-01T12:00:00Z`);return new Intl.DateTimeFormat('es-CR',{month:'long',year:'numeric',timeZone:'UTC'}).format(parsed)};
const dateTime=value=>{if(!value)return'—';const parsed=new Date(value);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleString('es-CR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})};

function unwrap(payload){return payload?.result||payload?.data||payload||{}}
function showMessage(text='',success=false){$('message').textContent=text;$('message').classList.toggle('success',success)}
function setLoading(value){state.loading=value;document.body.classList.toggle('loading',value);for(const id of['generate','resetFilters','downloadPdf','downloadExcel'])$(id).disabled=value||(id.startsWith('download')&&!state.generated)}
function populateSelect(id,items,placeholder){const select=$(id),seen=new Set();select.innerHTML=`<option value="">${esc(placeholder)}</option>`+array(items).map(item=>{const value=String(optionValue(item)),label=optionLabel(item);if(!value||seen.has(value))return'';seen.add(value);const email=typeof item==='object'?first(item.email,item.userEmail):'';return`<option value="${esc(value)}">${esc(label)}${email&&email!==label?` · ${esc(email)}`:''}</option>`}).join('')}

function populateOptions(){
  const subsidiaries=array(state.options.subsidiaries);
  populateSelect('subsidiary',subsidiaries,'Todas las empresas autorizadas');
  const allowedSubsidiaries=subsidiaries.map(optionValue).filter(Boolean),preferredSubsidiary=String(first(state.options.defaultSubsidiaryId,state.options.default_subsidiary_id,allowedSubsidiaries.length===1?allowedSubsidiaries[0]:''));
  if(preferredSubsidiary&&allowedSubsidiaries.includes(preferredSubsidiary))$('subsidiary').value=preferredSubsidiary;
  $('subsidiary').disabled=allowedSubsidiaries.length===1;
  $('subsidiary').title=allowedSubsidiaries.length===1?'Esta es la única subsidiaria autorizada para su usuario.':'';
  populateSelect('user',state.options.users,'Todos los usuarios');
  populateSelect('module',state.options.modules,'Todas las áreas');
  populateSelect('entityType',first(state.options.transactionTypes,state.options.entityTypes,[]),'Todas las transacciones');
  const months=array(state.options.months),values=months.map(optionValue).filter(Boolean);
  $('availableMonths').innerHTML=months.map(item=>`<option value="${esc(optionValue(item))}" label="${esc(optionLabel(item))}"></option>`).join('');
  const preferred=first(state.options.defaultMonth,values.includes(currentMonth())?currentMonth():values[0],currentMonth());
  $('month').value=String(preferred);
}

function filters(paged=true){
  const selectedType=$('entityType').value||null;
  const value={month:$('month').value,subsidiaryId:$('subsidiary').value||null,userId:$('user').value||null,action:$('action').value||null,module:$('module').value||null,entityType:selectedType,transactionType:selectedType,search:$('search').value.trim()||null};
  if(paged)Object.assign(value,{page:state.page,pageSize:Number($('pageSize').value)});
  return value;
}
function validate(){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test($('month').value))throw Error('Seleccione un mes válido para generar el reporte.')}

function summaryNumber(summary,names,fallback=0){return number(first(...names.map(name=>summary?.[name]),fallback))}
function transactionInfo(row){
  return{
    key:String(first(row?.transactionType,row?.transaction_type,row?.entityType,row?.module,'other')),
    label:String(first(row?.transactionTypeLabel,row?.transaction_type_label,row?.entityLabel,row?.moduleLabel,'Otras transacciones')),
    document:String(first(row?.documentNumber,row?.document_number,row?.recordLabel,'Documento sin número'))
  };
}
function documentCreator(row){
  const value=first(row?.documentCreator,row?.document_creator,row?.originalCreator,row?.original_creator);
  if(!value)return null;
  if(typeof value==='object')return{name:actorName(value),email:first(value.email,value.userEmail,'')};
  return{name:String(value),email:String(first(row?.documentCreatorEmail,row?.document_creator_email,row?.originalCreatorEmail,row?.original_creator_email,''))};
}
function companyName(row){
  const multiple=array(first(row?.subsidiaryNames,row?.subsidiary_names)).map(value=>String(value||'').trim()).filter(Boolean);
  if(multiple.length)return multiple.join(' · ');
  const direct=first(row?.subsidiaryName,row?.subsidiary_name,row?.companyName,row?.company_name);
  if(direct)return String(direct);
  const selected=$('subsidiary'),selectedLabel=selected?.value?selected.options[selected.selectedIndex]?.textContent:'';
  return String(first(selectedLabel,state.report.header?.subsidiaryName,state.report.header?.subsidiary_name,'Empresa autorizada'));
}
function transactionSummary(summary,rows){
  const supplied=array(first(summary?.byTransactionType,summary?.by_transaction_type));
  if(supplied.length)return supplied.map(item=>({
    key:String(first(item.transactionType,item.transaction_type,item.type,item.key,item.code,'other')),
    label:String(first(item.transactionTypeLabel,item.transaction_type_label,item.label,item.name,'Otras transacciones')),
    total:number(first(item.total,item.events,item.count,item.documents,0)),
    modified:number(first(item.modified,item.modifiedCount,item.updated,0)),
    deleted:number(first(item.deleted,item.deletedCount,item.removed,0))
  })).sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label,'es'));
  const grouped=new Map();
  for(const row of rows){
    const info=transactionInfo(row),current=grouped.get(info.key)||{...info,total:0,modified:0,deleted:0};
    current.total++;current[actionKind(row.action)]++;grouped.set(info.key,current);
  }
  return[...grouped.values()].sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label,'es'));
}
function renderSummary(){
  const summary=state.report.summary||{},rows=array(state.report.rows),total=summaryNumber(summary,['total','totalEvents','totalRecords'],state.report.total),documents=summaryNumber(summary,['recordCount','documentCount','totalEvents','totalRecords'],total),modified=summaryNumber(summary,['modified','modifiedCount','updated','updates'],rows.filter(row=>actionKind(row.action)==='modified').length),deleted=summaryNumber(summary,['deleted','deletedCount','deletions'],rows.filter(row=>actionKind(row.action)==='deleted').length),users=summaryNumber(summary,['users','userCount','usersCount','uniqueUsers','activeUsers'],new Set(rows.map(row=>first(row.actor?.email,row.actor?.name)).filter(Boolean)).size),types=transactionSummary(summary,rows),topActor=first(summary.topActor?.name,summary.topActorName,typeof summary.mostActiveUser==='string'?summary.mostActiveUser:summary.mostActiveUser?.name,summary.mostActiveUserName);
  $('summary').innerHTML=`
    <div class="summary-metrics">
      <article class="metric"><small>Documentos con cambios</small><b>${integer(documents)}</b><span>${integer(total)} cambio${total===1?'':'s'} registrado${total===1?'':'s'}</span></article>
      <article class="metric modified"><small>Modificaciones</small><b>${integer(modified)}</b><span>Documentos o datos actualizados</span></article>
      <article class="metric deleted"><small>Eliminaciones</small><b>${integer(deleted)}</b><span>Documentos retirados del sistema</span></article>
      <article class="metric users"><small>Usuarios responsables</small><b>${integer(users)}</b><span>${topActor?`Mayor actividad: ${esc(topActor)}`:'Usuarios identificados'}</span></article>
    </div>
    <aside class="transaction-breakdown">
      <div class="breakdown-heading"><div><b>Distribución por tipo de transacción</b><span>Así se organizan los documentos encontrados en el periodo.</span></div><strong>${integer(types.length)} tipo${types.length===1?'':'s'}</strong></div>
      <div class="transaction-chips">${types.length?types.map(item=>`<div class="transaction-chip"><span class="transaction-dot" aria-hidden="true"></span><div><b>${esc(item.label)}</b><small>${integer(item.modified)} modificado${item.modified===1?'':'s'} · ${integer(item.deleted)} eliminado${item.deleted===1?'':'s'}</small></div><strong>${integer(item.total)}</strong></div>`).join(''):'<span class="no-types">No se encontraron transacciones para mostrar.</span>'}</div>
    </aside>
    <aside class="reading-note"><b>Cómo leer este reporte</b><span>Cada bloque corresponde a un tipo de documento. Use “Ver cambios” para comparar la información anterior con la nueva.</span></aside>`;
}

function actionKind(value){const action=String(value||'').toUpperCase();return/(DELETE|DELETED|ELIMIN)/.test(action)?'deleted':'modified'}
function actionLabel(value){return actionKind(value)==='deleted'?'Eliminado':'Modificado'}
function formatRaw(value){
  if(value===null||value===undefined||value==='')return'';
  if(typeof value==='boolean')return value?'Sí':'No';
  if(typeof value==='object'){try{return JSON.stringify(value,null,2)}catch{return String(value)}}
  return String(value);
}
function valueBox(value,kind='before'){
  const formatted=formatRaw(value);
  return`<div class="value-box ${kind}">${formatted?esc(formatted):'<span class="empty-value">Sin valor</span>'}</div>`;
}
function normalizeSnapshot(value){
  if(!value)return{};
  if(typeof value==='object'&&!Array.isArray(value))return value;
  if(typeof value==='string'){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{valor:value}}catch{return{valor:value}}}
  return{valor:value};
}
function fieldLabel(value){return String(value||'Dato').replaceAll('_',' ').replace(/\b\w/g,letter=>letter.toUpperCase())}
function changeDescription(row){
  if(actionKind(row.action)==='deleted')return'Documento completo eliminado';
  const changes=array(row.changes),labels=changes.map(change=>first(change.fieldLabel,fieldLabel(change.field))).filter(Boolean);
  if(!labels.length)return'Cambio registrado';
  return`${labels.slice(0,3).join(', ')}${labels.length>3?` y ${labels.length-3} más`:''}`;
}
function detailPanel(row){
  const kind=actionKind(row.action),changes=array(row.changes),actor=row.actor||{},creator=documentCreator(row),document=transactionInfo(row).document,fields=changes.map(change=>`<tr><td><strong class="field-name">${esc(first(change.fieldLabel,fieldLabel(change.field),'Dato'))}</strong></td><td>${valueBox(change.oldValue,'before')}</td><td>${valueBox(change.newValue,kind==='deleted'?'deleted-value':'after')}</td></tr>`).join('');
  let body='';
  if(changes.length)body=`<div class="table-wrap"><table class="change-table"><thead><tr><th>Dato modificado</th><th>Antes del cambio</th><th>${kind==='deleted'?'Después de eliminar':'Después del cambio'}</th></tr></thead><tbody>${fields}</tbody></table></div>`;
  else if(kind==='deleted'){
    const snapshot=normalizeSnapshot(row.deletedSnapshot),entries=Object.entries(snapshot);
    body=`<div class="snapshot"><div class="snapshot-title"><b>Información disponible antes de eliminar el documento</b><span>${entries.length} dato${entries.length===1?'':'s'}</span></div><div class="snapshot-grid">${entries.map(([field,value])=>`<article class="snapshot-field"><small>${esc(fieldLabel(field))}</small><strong>${esc(formatRaw(value)||'Sin valor')}</strong></article>`).join('')||'<span class="cell-note">No hay información adicional disponible para este documento.</span>'}</div></div>`;
  }else body='<div class="snapshot"><span class="cell-note">El cambio quedó registrado, pero no contiene valores para comparar.</span></div>';
  return`<div class="detail-panel"><div class="detail-heading"><div><small>${kind==='deleted'?'Documento eliminado':'Detalle de la modificación'}</small><b>${esc(document)}</b></div><span>${esc(dateTime(row.timestamp))}</span></div>${body}<div class="responsible-note"><div><span>${kind==='deleted'?'Eliminado por':'Modificado por'}</span><b>${esc(actorName(actor))}</b>${actor.email?`<small>${esc(actor.email)}</small>`:''}</div>${creator?`<div><span>Registrado por</span><b>${esc(creator.name)}</b>${creator.email?`<small>${esc(creator.email)}</small>`:''}</div>`:''}</div></div>`;
}
function groupRows(rows){
  const groups=new Map();
  for(const row of rows){const info=transactionInfo(row),current=groups.get(info.key)||{key:info.key,label:info.label,rows:[],modified:0,deleted:0};current.rows.push(row);current[actionKind(row.action)]++;groups.set(info.key,current)}
  return[...groups.values()].sort((a,b)=>a.label.localeCompare(b.label,'es'));
}
function renderRows(){
  const rows=array(state.report.rows);
  if(!rows.length){$('reportRows').innerHTML='<div class="empty-state"><span aria-hidden="true">✓</span><b>No se encontraron transacciones con estos filtros</b><small>Pruebe otro mes, usuario, área o tipo de transacción.</small></div>';return}
  $('reportRows').innerHTML=`<div class="transaction-groups">${groupRows(rows).map((group,index)=>`<section class="transaction-group"><header class="transaction-group-heading"><div><span class="group-index">${String(index+1).padStart(2,'0')}</span><div><b>${esc(group.label)}</b><small>${integer(group.modified)} modificado${group.modified===1?'':'s'} · ${integer(group.deleted)} eliminado${group.deleted===1?'':'s'} en esta página</small></div></div><span class="group-total">${integer(group.rows.length)}</span></header><div class="table-wrap"><table class="document-table"><thead><tr><th>Fecha del cambio</th><th>Tipo de cambio</th><th>Documento</th><th>Empresa</th><th>Usuarios involucrados</th><th>Información modificada</th><th aria-label="Consultar detalle"></th></tr></thead><tbody>${group.rows.map(row=>{
    const info=transactionInfo(row),id=String(first(row.auditId,`${row.timestamp}-${info.key}-${info.document}`)),open=state.expanded.has(id),actor=row.actor||{},creator=documentCreator(row),kind=actionKind(row.action),recordLabel=first(row.recordLabel,row.entityLabel),showRecordLabel=recordLabel&&recordLabel!==info.document;
    return`<tr class="document-row"><td class="date-cell"><strong>${esc(dateTime(row.timestamp))}</strong></td><td><span class="action-badge ${kind}">${actionLabel(row.action)}</span></td><td><span class="record-title">${esc(info.document)}</span>${showRecordLabel?`<span class="cell-note">${esc(recordLabel)}</span>`:''}</td><td><span class="company-label">${esc(companyName(row))}</span></td><td><span class="actor-role">${kind==='deleted'?'Eliminado por':'Modificado por'}</span><span class="actor-name">${esc(actorName(actor))}</span>${actor.email?`<span class="cell-note">${esc(actor.email)}</span>`:''}${creator?`<span class="creator-line"><b>Registrado por:</b> ${esc(creator.name)}</span>`:''}</td><td><span class="change-description">${esc(changeDescription(row))}</span></td><td class="detail-action"><button class="view-changes" type="button" data-expand="${esc(id)}" aria-expanded="${open}">${open?'Ocultar':'Ver cambios'}<span aria-hidden="true">${open?'↑':'↓'}</span></button></td></tr><tr class="detail-row" ${open?'':'hidden'}><td colspan="7">${detailPanel(row)}</td></tr>`;
  }).join('')}</tbody></table></div></section>`).join('')}</div>`;
  $('reportRows').querySelectorAll('[data-expand]').forEach(button=>button.onclick=()=>{const id=String(button.dataset.expand);state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);renderRows()});
}
function renderPager(){const total=number(state.report.total),size=Number($('pageSize').value),pages=Math.max(1,Math.ceil(total/size));$('resultCount').textContent=`${integer(total)} transacción${total===1?'':'es'}`;$('pageCaption').textContent=`Página ${state.page} de ${pages}`;$('previousPage').disabled=state.loading||state.page<=1;$('nextPage').disabled=state.loading||state.page>=pages}
function render(){
  const header=state.report.header||{},period=first(header.month,header.periodMonth,$('month').value),scope=first(header.filterDescription,header.scopeLabel,header.subsidiaryName,header.scope);
  $('periodCaption').textContent=`Cambios de ${monthLabel(period)}, organizados por tipo de transacción${scope?` · ${scope}`:''}.`;
  renderSummary();renderRows();renderPager();
}

async function run(){
  try{validate()}catch(error){showMessage(error.message);return}
  setLoading(true);showMessage('');
  try{
    const payload=await api('/api/v1/reports/audit/changes',{method:'POST',body:JSON.stringify(filters())});
    state.report=unwrap(payload)||{};state.report.header=state.report.header||{};state.report.summary=state.report.summary||{};state.report.rows=array(state.report.rows);state.report.total=number(first(state.report.total,state.report.summary.total,state.report.rows.length));state.expanded.clear();state.generated=true;render();
  }catch(error){state.generated=false;showMessage(error.message);$('summary').innerHTML='<div class="initial-summary">No fue posible calcular los indicadores.</div>';$('reportRows').innerHTML=`<div class="empty-state"><span aria-hidden="true">!</span><b>No fue posible generar el reporte</b><small>${esc(error.message)}</small></div>`}finally{setLoading(false);renderPager()}
}

function filename(response,fallback){const disposition=response.headers.get('Content-Disposition')||'',encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i),plain=disposition.match(/filename="?([^";]+)"?/i);try{return encoded?decodeURIComponent(encoded[1]):plain?.[1]||fallback}catch{return fallback}}
function save(blob,name){const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
async function exportReport(format){
  try{validate()}catch(error){showMessage(error.message);return}
  const button=format==='pdf'?$('downloadPdf'):$('downloadExcel'),label=button.innerHTML;setLoading(true);button.innerHTML='Preparando descarga…';showMessage('');
  try{
    const response=await fetch(`/api/v1/reports/audit/changes/${format}`,{method:'POST',headers:headers(true),body:JSON.stringify(filters(false))});
    if(!response.ok){const raw=await response.text();let payload={};try{payload=JSON.parse(raw)}catch{}throw Error(payload?.error?.message||payload?.message||'No fue posible preparar la descarga.')}
    const extension=format==='pdf'?'pdf':'xlsx';save(await response.blob(),filename(response,`auditoria-transacciones-${$('month').value}.${extension}`));showMessage('La descarga se generó correctamente.',true);
  }catch(error){showMessage(error.message)}finally{setLoading(false);button.innerHTML=label;renderPager()}
}

$('filters').onsubmit=event=>{event.preventDefault();state.page=1;run()};
$('pageSize').onchange=()=>{state.page=1;if(state.generated)run()};
$('previousPage').onclick=()=>{if(state.page>1){state.page--;run()}};
$('nextPage').onclick=()=>{const pages=Math.ceil(number(state.report.total)/Number($('pageSize').value));if(state.page<pages){state.page++;run()}};
$('downloadPdf').onclick=()=>exportReport('pdf');
$('downloadExcel').onclick=()=>exportReport('excel');
$('resetFilters').onclick=()=>{for(const id of['user','action','module','entityType'])$(id).value='';const subsidiaries=array(state.options.subsidiaries).map(optionValue).filter(Boolean);$('subsidiary').value=String(first(state.options.defaultSubsidiaryId,state.options.default_subsidiary_id,subsidiaries.length===1?subsidiaries[0]:''));$('search').value='';const months=array(state.options.months).map(optionValue).filter(Boolean);$('month').value=first(state.options.defaultMonth,months.includes(currentMonth())?currentMonth():months[0],currentMonth());state.page=1;run()};

async function init(){
  $('month').value=currentMonth();setLoading(true);
  try{state.options=unwrap(await api('/api/v1/reports/audit/changes/options'));populateOptions();await run()}
  catch(error){showMessage(error.message);$('reportRows').innerHTML=`<div class="empty-state"><span aria-hidden="true">!</span><b>No fue posible cargar el reporte</b><small>${esc(error.message)}</small></div>`}finally{setLoading(false);renderPager()}
}

init();
