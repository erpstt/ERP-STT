const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const token = () => localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token') || '';
const deviceToken = () => localStorage.getItem('nexo_device_token') || sessionStorage.getItem('nexo_device_token') || '';
const requestHeaders = () => ({Authorization:`Bearer ${token()}`,'X-Device-Token':deviceToken(),'Content-Type':'application/json'});
const statuses = {
  pending: 'Pendiente',
  in_review: 'En revisión',
  filed: 'Presentada',
  overdue: 'Vencida',
  exempt: 'Exenta'
};
const documentLabels = {none:'Sin respaldo',file_upload:'Archivo',external_url:'Enlace externo'};
const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const monthFormatter = new Intl.DateTimeFormat('es-CR',{month:'long',year:'numeric',timeZone:'UTC'});
const shortDateFormatter = new Intl.DateTimeFormat('es-CR',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
const dateTimeFormatter = new Intl.DateTimeFormat('es-CR',{dateStyle:'medium',timeStyle:'short'});

const state = {
  options: {subsidiaries:[],users:[],taxTypes:[],permissions:{}},
  events: [],
  notifications: [],
  metrics: {},
  view: 'month',
  anchor: new Date(),
  editing: null,
  busy: false
};

function isoDate(date) {
  return new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())).toISOString().slice(0,10);
}
function parseDate(value) {
  const [year,month,day] = String(value).slice(0,10).split('-').map(Number);
  return new Date(year,month-1,day);
}
function addDays(date,days) {
  const result = new Date(date.getFullYear(),date.getMonth(),date.getDate());
  result.setDate(result.getDate()+days);
  return result;
}
function monday(date) {
  const result = new Date(date.getFullYear(),date.getMonth(),date.getDate());
  result.setDate(result.getDate()-((result.getDay()+6)%7));
  return result;
}
function startOfMonth(date) { return new Date(date.getFullYear(),date.getMonth(),1); }
function endOfMonth(date) { return new Date(date.getFullYear(),date.getMonth()+1,0); }
function todayIso() { return isoDate(new Date()); }
function formatDate(value) { return value ? shortDateFormatter.format(new Date(`${String(value).slice(0,10)}T00:00:00Z`)) : '—'; }
function formatDateTime(value) { return value ? dateTimeFormatter.format(new Date(value)) : '—'; }
function formatBytes(value) {
  const size=Number(value||0);
  return size>=1024*1024?`${(size/(1024*1024)).toFixed(1)} MB`:`${Math.max(1,Math.round(size/1024))} KB`;
}

async function api(action,payload={}) {
  const response=await fetch(`/api/tax-calendar/${action}`,{method:'POST',headers:requestHeaders(),body:JSON.stringify(payload)});
  const raw=await response.text();
  let data={};
  try{data=raw?JSON.parse(raw):{};}catch{data={};}
  if(!response.ok)throw Error(data?.error?.message||data?.error||data?.message||'No fue posible procesar el calendario tributario.');
  return data;
}
function setMessage(message='',error=false) {
  $('message').textContent=message;
  $('message').classList.toggle('error',error);
}
function setBusy(value) {
  state.busy=value;
  $('taxCalendarApp').setAttribute('aria-busy',String(value));
  for(const button of document.querySelectorAll('button')){
    if(value){button.dataset.taxWasDisabled=String(button.disabled);button.disabled=true;}
    else{button.disabled=button.dataset.taxWasDisabled==='true';delete button.dataset.taxWasDisabled;}
  }
}
async function perform(task,{success='',dialogError=null}={}) {
  if(state.busy)return;
  setBusy(true);setMessage();
  if(dialogError)$(dialogError).textContent='';
  try{
    const result=await task();
    if(success)setMessage(success);
    return result;
  }catch(cause){
    const message=cause instanceof Error?cause.message:'No fue posible completar la operación.';
    if(dialogError)$(dialogError).textContent=message;else setMessage(message,true);
    throw cause;
  }finally{setBusy(false);}
}

function selectedSubsidiaryUsers(subsidiaryId) {
  return state.options.users.filter(user=>!subsidiaryId||(user.subsidiaryIds||[]).map(String).includes(String(subsidiaryId)));
}
function selectedTaxTypes(subsidiaryId) {
  return state.options.taxTypes.filter(type=>!subsidiaryId||!(type.subsidiaryIds||[]).length||(type.subsidiaryIds||[]).map(String).includes(String(subsidiaryId)));
}
function optionMarkup(rows,valueKey='id',labelKey='name') {
  return rows.map(row=>`<option value="${escapeHtml(row[valueKey])}">${escapeHtml(row[labelKey])}</option>`).join('');
}
function fillOptions() {
  const subsidiaries=state.options.subsidiaries||[];
  $('filterSubsidiary').innerHTML='<option value="">Todas las autorizadas</option>'+optionMarkup(subsidiaries);
  $('eventSubsidiary').innerHTML='<option value="">Seleccione una subsidiaria</option>'+optionMarkup(subsidiaries);
  const active=state.options.activeSubsidiaryId;
  if(active&&subsidiaries.some(item=>String(item.id)===String(active)))$('filterSubsidiary').value=String(active);
  fillTaxTypes();fillUsers();
}
function fillTaxTypes(keepValue) {
  const subsidiaryId=$('eventSubsidiary').value;
  const options=selectedTaxTypes(subsidiaryId);
  $('eventTaxType').innerHTML=`<option value="">${options.length?'Seleccione un tipo de impuesto':'No hay obligaciones configuradas para este país'}</option>`+optionMarkup(options,'code','name');
  if(keepValue&&!options.some(item=>String(item.code)===String(keepValue))){
    $('eventTaxType').insertAdjacentHTML('beforeend',`<option value="${escapeHtml(keepValue)}">${escapeHtml(keepValue)}</option>`);
  }
  if(keepValue)$('eventTaxType').value=String(keepValue);
  const allTypes=[...new Map((state.options.taxTypes||[]).map(item=>[item.code,item])).values()];
  $('filterTaxType').innerHTML='<option value="">Todos</option>'+optionMarkup(allTypes,'code','name');
}
function fillUsers(assigneeValue) {
  const subsidiaryId=$('eventSubsidiary').value;
  const users=selectedSubsidiaryUsers(subsidiaryId);
  $('eventAssignee').innerHTML='<option value="">Sin asignar</option>'+optionMarkup(users);
  if(assigneeValue)$('eventAssignee').value=String(assigneeValue);
  for(const select of document.querySelectorAll('.follower-user')){
    const value=select.value;
    select.innerHTML='<option value="">Seleccione un usuario</option>'+optionMarkup(users);
    select.value=value;
  }
}

function updateDateRangeForView() {
  if(state.view==='month'){
    $('filterFrom').value=isoDate(startOfMonth(state.anchor));
    $('filterTo').value=isoDate(endOfMonth(state.anchor));
  }else if(state.view==='week'){
    const first=monday(state.anchor);
    $('filterFrom').value=isoDate(first);
    $('filterTo').value=isoDate(addDays(first,6));
  }
}
function periodLabel() {
  if(state.view==='month')return monthFormatter.format(new Date(Date.UTC(state.anchor.getFullYear(),state.anchor.getMonth(),1)));
  if(state.view==='week'){
    const first=monday(state.anchor),last=addDays(first,6);
    return `${formatDate(isoDate(first))} – ${formatDate(isoDate(last))}`;
  }
  const from=$('filterFrom').value,to=$('filterTo').value;
  return from&&to?`${formatDate(from)} – ${formatDate(to)}`:'Todos los períodos';
}
function filtersPayload() {
  return {
    subsidiaryId:$('filterSubsidiary').value||null,
    status:$('filterStatus').value||null,
    dateFrom:$('filterFrom').value||null,
    dateTo:$('filterTo').value||null,
    taxTypeCode:$('filterTaxType').value||null
  };
}

async function loadEvents() {
  $('loading').hidden=false;
  for(const id of ['monthView','weekView','tableView','emptyState'])$(id).hidden=true;
  try{
    const data=await api('list',filtersPayload());
    state.events=Array.isArray(data.events)?data.events:[];
    state.notifications=Array.isArray(data.notifications)?data.notifications:[];
    state.metrics=data.metrics||{};
    render();
  }finally{$('loading').hidden=true;}
}
function renderMetrics() {
  $('metricPending').textContent=state.metrics.pending||0;
  $('metricReview').textContent=state.metrics.inReview||0;
  $('metricUpcoming').textContent=state.metrics.upcoming||0;
  $('metricOverdue').textContent=state.metrics.overdue||0;
  $('metricFiled').textContent=state.metrics.filed||0;
}
function eventButton(event,includeDate=false) {
  return `<button type="button" class="event-card status-${escapeHtml(event.status)}" data-event="${escapeHtml(event.id)}" title="Abrir ${escapeHtml(event.taxTypeCode)}">
    <strong>${escapeHtml(event.taxTypeCode)}</strong><span>${escapeHtml(event.subsidiaryName)}</span>
    <small>${includeDate?`${escapeHtml(formatDate(event.dueDate))} · `:''}${escapeHtml(statuses[event.status]||event.status)}</small>
  </button>`;
}
function renderMonth() {
  const monthStart=startOfMonth(state.anchor),gridStart=monday(monthStart),today=todayIso();
  const byDate=Object.groupBy?Object.groupBy(state.events,event=>event.dueDate):state.events.reduce((map,event)=>((map[event.dueDate]??=[]).push(event),map),{});
  $('monthGrid').innerHTML=Array.from({length:42},(_,index)=>{
    const date=addDays(gridStart,index),iso=isoDate(date),events=byDate[iso]||[],outside=date.getMonth()!==monthStart.getMonth();
    return `<article class="month-day${outside?' outside':''}${iso===today?' today':''}" role="gridcell" aria-label="${escapeHtml(formatDate(iso))}">
      <div class="day-heading"><span class="day-number">${date.getDate()}</span>${events.length?`<span class="day-count">${events.length}</span>`:''}</div>
      <div class="day-events">${events.slice(0,3).map(event=>eventButton(event)).join('')}${events.length>3?`<span class="more-events">+ ${events.length-3} más</span>`:''}</div>
    </article>`;
  }).join('');
}
function renderWeek() {
  const first=monday(state.anchor),today=todayIso();
  $('weekGrid').innerHTML=Array.from({length:7},(_,index)=>{
    const date=addDays(first,index),iso=isoDate(date),events=state.events.filter(event=>event.dueDate===iso);
    return `<article class="week-day${iso===today?' today':''}" role="gridcell"><header class="week-heading"><span>${escapeHtml(dayNames[date.getDay()])}</span><strong>${date.getDate()}</strong></header><div class="week-events">${events.map(event=>eventButton(event)).join('')||'<p class="week-empty">Sin vencimientos</p>'}</div></article>`;
  }).join('');
}
function documentCell(event) {
  if(event.documentType==='file_upload')return `<button class="button ghost" type="button" data-document="${escapeHtml(event.id)}">Descargar archivo</button>`;
  if(event.documentType==='external_url'&&/^https:\/\//i.test(event.externalLink||''))return `<a class="document-pill" href="${escapeHtml(event.externalLink)}" target="_blank" rel="noopener noreferrer">Abrir enlace</a>`;
  return '<span class="document-pill">Sin respaldo</span>';
}
function renderTable() {
  $('eventRows').innerHTML=state.events.map(event=>`<tr>
    <td class="date-cell${event.status==='overdue'?' overdue':''}"><strong>${escapeHtml(formatDate(event.dueDate))}</strong><small>${event.status==='overdue'?'Vencida':escapeHtml(event.period)}</small></td>
    <td><strong>${escapeHtml(event.subsidiaryName)}</strong></td>
    <td><strong>${escapeHtml(event.taxTypeCode)}</strong><small>${escapeHtml(event.notes||'Sin notas')}</small></td>
    <td>${escapeHtml(event.period)}</td>
    <td>${escapeHtml(event.assignedUserName||'Sin asignar')}</td>
    <td><span class="status-pill status-${escapeHtml(event.status)}">${escapeHtml(statuses[event.status]||event.status)}</span></td>
    <td>${documentCell(event)}</td>
    <td><div class="row-actions"><button class="button secondary" type="button" data-event="${escapeHtml(event.id)}">${state.options.permissions.manage||state.options.permissions.file?'Gestionar':'Ver'}</button></div></td>
  </tr>`).join('');
}
function renderNotifications() {
  const unread=state.notifications.filter(item=>!item.readAt).length;
  $('notificationBadge').hidden=!unread;
  $('notificationBadge').textContent=unread>99?'99+':String(unread);
  $('notificationsSummary').textContent=unread?`${unread} ${unread===1?'alerta pendiente':'alertas pendientes'}.`:'No hay alertas pendientes.';
  $('markAllRead').hidden=!unread;
  $('notificationList').innerHTML=state.notifications.map(item=>`<article class="notification-item${item.readAt?'':' unread'}${item.priority==='high'?' high':''}">
    <span class="notification-dot" aria-hidden="true"></span><div class="notification-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(item.subsidiaryName||'')} · ${escapeHtml(formatDateTime(item.createdAt))}</small></div>
    <div class="notification-actions">${item.priority==='high'?'<span class="priority-pill status-overdue">PRIORIDAD ALTA</span>':''}<button class="button ghost" type="button" data-notification-event="${escapeHtml(item.eventId)}">Abrir</button>${item.readAt?'':`<button class="button ghost" type="button" data-read="${escapeHtml(item.id)}">Marcar leída</button>`}</div>
  </article>`).join('')||'<div class="notifications-empty">No tiene notificaciones tributarias.</div>';
}
function render() {
  renderMetrics();renderMonth();renderWeek();renderTable();renderNotifications();
  $('periodLabel').textContent=periodLabel();
  $('resultCount').textContent=`${state.events.length} ${state.events.length===1?'obligación':'obligaciones'}`;
  const viewId={month:'monthView',week:'weekView',table:'tableView'}[state.view];
  $(viewId).hidden=!state.events.length;
  $('emptyState').hidden=!!state.events.length;
  for(const tab of document.querySelectorAll('[data-view]')){
    const active=tab.dataset.view===state.view;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));
  }
  $('dateNavigator').hidden=state.view==='table';
}

function resetFollowers(rows=[]) {
  $('followers').innerHTML='';
  for(const row of rows)addFollower(row);
  if(!rows.length)renderFollowersEmpty();
}
function renderFollowersEmpty() {
  if(!$('followers').children.length)$('followers').innerHTML='<p class="followers-empty">No hay seguidores adicionales. El responsable principal recibe correo y notificación interna.</p>';
}
function addFollower(row={}) {
  $('followers').querySelector('.followers-empty')?.remove();
  const wrapper=document.createElement('div');wrapper.className='follower-row';
  const users=selectedSubsidiaryUsers($('eventSubsidiary').value);
  wrapper.innerHTML=`<label>Seguidor<select class="follower-user manage-field"><option value="">Seleccione un usuario</option>${optionMarkup(users)}</select></label>
    <label>Canal<select class="follower-channel manage-field"><option value="both">Correo y en la aplicación</option><option value="email">Solo correo</option><option value="in_app">Solo en la aplicación</option></select></label>
    <button class="follower-remove manage-field" type="button" aria-label="Quitar seguidor">×</button>`;
  wrapper.querySelector('.follower-user').value=String(row.userId||'');
  wrapper.querySelector('.follower-channel').value=row.notificationChannel||'both';
  wrapper.querySelector('.follower-remove').onclick=()=>{wrapper.remove();renderFollowersEmpty();};
  $('followers').append(wrapper);
  applyPermissionsToEditor();
}
function eventStatusOptions(current='pending') {
  const manage=!!state.options.permissions.manage,file=!!state.options.permissions.file;
  const allowed=manage?['pending','in_review','overdue','exempt',...(file?['filed']:[]),current]:[current,...(file&&current!=='filed'?['filed']:[])];
  return [...new Set(allowed)].map(value=>`<option value="${value}">${escapeHtml(statuses[value])}</option>`).join('');
}
function applyPermissionsToEditor() {
  const manage=!!state.options.permissions.manage,file=!!state.options.permissions.file;
  document.querySelectorAll('.manage-field').forEach(element=>element.disabled=!manage);
  document.querySelectorAll('.file-field').forEach(element=>element.disabled=!file);
  $('requestDelete').hidden=!state.editing||!manage;
  $('saveEvent').hidden=!(manage||file);
}
function updateDocumentFields() {
  const type=$('documentType').value;
  $('fileField').hidden=type!=='file_upload';
  $('externalLinkField').hidden=type!=='external_url';
  $('externalLink').required=type==='external_url';
  $('filingFields').hidden=$('eventStatus').value!=='filed';
  $('filingDate').required=$('eventStatus').value==='filed';
}
function localDateTimeInput(value) {
  if(!value)return '';
  const date=new Date(value),offset=date.getTimezoneOffset()*60000;
  return new Date(date-offset).toISOString().slice(0,16);
}
function showExistingDocument(detail) {
  const container=$('existingDocument'),event=detail.event||{},document=detail.document;
  if(event.documentType==='file_upload'&&document){
    container.innerHTML=`<div><strong>${escapeHtml(document.fileName)}</strong><small>${escapeHtml(document.mimeType)} · ${escapeHtml(formatBytes(document.fileSize))}</small></div><button class="button secondary" id="downloadExisting" type="button">Descargar</button>`;
    container.hidden=false;$('downloadExisting').onclick=()=>void downloadDocument(event.id,document.fileName);
  }else if(event.documentType==='external_url'&&event.externalLink){
    container.innerHTML=`<div><strong>Enlace externo registrado</strong><small>${escapeHtml(event.externalLink)}</small></div><a class="button secondary" href="${escapeHtml(event.externalLink)}" target="_blank" rel="noopener noreferrer">Abrir enlace</a>`;
    container.hidden=false;
  }else{container.hidden=true;container.innerHTML='';}
}
async function openEditor(id=null) {
  if(state.busy)return;
  let detail={event:null,followers:[],reminders:[],document:null};
  if(id){
    const found=state.events.find(event=>String(event.id)===String(id));
    if(found)state.editing=found;
    detail=await perform(()=>api('get',{id}),{dialogError:'editorError'});
    state.editing=detail.event;
  }else state.editing=null;
  const event=detail.event||{};
  $('eventForm').reset();$('editorError').textContent='';$('selectedFile').hidden=true;$('selectedFile').textContent='';
  $('editorTitle').textContent=id?'Gestionar obligación':'Nueva obligación';
  $('editorSubtitle').textContent=id?'Revise el seguimiento, respaldo y datos de presentación.':'Complete los datos de la declaración y su seguimiento.';
  $('eventSubsidiary').value=String(event.subsidiaryId||state.options.activeSubsidiaryId||state.options.subsidiaries[0]?.id||'');
  fillTaxTypes(event.taxTypeCode);fillUsers(event.assignedUserId);
  $('eventPeriod').value=event.period||`${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`;
  $('eventDueDate').value=event.dueDate||todayIso();
  $('eventStatus').innerHTML=eventStatusOptions(event.status||'pending');$('eventStatus').value=event.status||'pending';
  $('eventNotes').value=event.notes||'';
  $('documentType').value=event.documentType||'none';
  $('externalLink').value=event.externalLink||'';
  $('filingDate').value=localDateTimeInput(event.filingDate);
  $('filingReference').value=event.filingReferenceNumber||'';
  resetFollowers(detail.followers||[]);
  const reminderSet=new Set((detail.reminders||[]).map(item=>String(item.daysBeforeDue)));
  for(const checkbox of document.querySelectorAll('#reminderOptions input'))checkbox.checked=id?reminderSet.has(checkbox.value):true;
  showExistingDocument(detail);updateDocumentFields();applyPermissionsToEditor();
  $('editorDialog').showModal();
}
function followerPayload() {
  const rows=[...document.querySelectorAll('.follower-row')].map(row=>({userId:row.querySelector('.follower-user').value,notificationChannel:row.querySelector('.follower-channel').value}));
  if(rows.some(row=>!row.userId))throw Error('Seleccione el usuario de cada seguidor o quite la fila vacía.');
  if(new Set(rows.map(row=>row.userId)).size!==rows.length)throw Error('Cada seguidor solo puede aparecer una vez.');
  return rows.map(row=>({...row,userId:Number(row.userId)}));
}
async function filePayload() {
  const file=$('documentFile').files[0];
  if(!file)return null;
  const allowed=['application/pdf','image/jpeg','image/png'];
  if(!allowed.includes(file.type))throw Error('Solo se permiten archivos PDF, JPG o PNG.');
  if(!file.size||file.size>5*1024*1024)throw Error('El archivo debe pesar como máximo 5 MB.');
  const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('No fue posible leer el archivo.'));reader.readAsDataURL(file);});
  return{name:file.name,mimeType:file.type,size:file.size,dataUrl};
}
async function saveEditor() {
  const documentType=$('documentType').value,status=$('eventStatus').value,file=await filePayload();
  if(!/^\d{4}-(0[1-9]|1[0-2]|Q[1-4]|FY)$/.test($('eventPeriod').value.trim()))throw Error('El período debe usar AAAA-MM, AAAA-Q1…Q4 o AAAA-FY.');
  if(documentType==='file_upload'&&!file&&!(state.editing?.documentType==='file_upload'))throw Error('Seleccione el archivo de respaldo.');
  if(documentType==='external_url'&&!/^https:\/\/[^\s]+$/i.test($('externalLink').value.trim()))throw Error('Ingrese un enlace HTTPS válido.');
  if(status==='filed'&&!$('filingDate').value)throw Error('Indique la fecha real de presentación.');
  const payload={
    id:state.editing?.id||undefined,
    subsidiaryId:Number($('eventSubsidiary').value),taxTypeCode:$('eventTaxType').value,period:$('eventPeriod').value.trim(),dueDate:$('eventDueDate').value,
    assignedUserId:$('eventAssignee').value?Number($('eventAssignee').value):null,status,notes:$('eventNotes').value.trim()||null,
    documentType,externalLink:documentType==='external_url'?$('externalLink').value.trim():null,
    filingDate:status==='filed'?new Date($('filingDate').value).toISOString():null,filingReferenceNumber:status==='filed'?$('filingReference').value.trim()||null:null,
    followers:followerPayload(),reminders:[...document.querySelectorAll('#reminderOptions input:checked')].map(input=>({daysBeforeDue:Number(input.value)})),
    ...(file?{file}:{})
  };
  if(!payload.subsidiaryId||!payload.taxTypeCode||!payload.dueDate)throw Error('Complete la subsidiaria, el tipo de impuesto y la fecha de vencimiento.');
  await api('save',payload);
  $('editorDialog').close();state.editing=null;await loadEvents();
}
async function downloadDocument(id,fileName='respaldo') {
  try{
    setMessage('Preparando el respaldo…');
    const response=await fetch(`/api/tax-calendar/events/${encodeURIComponent(id)}/document`,{headers:{Authorization:`Bearer ${token()}`,'X-Device-Token':deviceToken()}});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data?.error?.message||data?.error||'No fue posible descargar el respaldo.');}
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
    const disposition=response.headers.get('content-disposition')||'',encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    link.href=url;link.download=encoded?decodeURIComponent(encoded):fileName;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);setMessage('Respaldo descargado.');
  }catch(cause){setMessage(cause instanceof Error?cause.message:'No fue posible descargar el respaldo.',true);}
}

async function initialize() {
  try{
    const options=await api('options');state.options=options;
    if(!options.permissions?.view)throw Error('No tiene permiso para consultar el calendario tributario.');
    fillOptions();$('newEvent').hidden=!options.permissions.manage;
    state.anchor=new Date();updateDateRangeForView();
    $('workspace').hidden=false;$('accessDenied').hidden=true;
    await loadEvents();
    const requestedParams=new URLSearchParams(location.search),requested=requestedParams.get('event');
    if(requested)await openEditor(requested);
    else if(requestedParams.get('notifications')==='1')$('notificationsDialog').showModal();
  }catch(cause){
    $('workspace').hidden=true;$('accessDenied').hidden=false;
    $('accessDenied').querySelector('p').textContent=cause instanceof Error?cause.message:'No fue posible abrir el calendario tributario.';
  }finally{$('taxCalendarApp').setAttribute('aria-busy','false');}
}

$('filters').onsubmit=event=>{event.preventDefault();void perform(loadEvents);};
$('resetFilters').onclick=()=>{const active=state.options.activeSubsidiaryId;$('filters').reset();$('filterSubsidiary').value=active?String(active):'';state.anchor=new Date();updateDateRangeForView();void perform(loadEvents);};
$('newEvent').onclick=()=>void openEditor().catch(cause=>setMessage(cause instanceof Error?cause.message:'No fue posible abrir el formulario de la obligación.',true));
$('eventSubsidiary').onchange=()=>{const tax=$('eventTaxType').value,assignee=$('eventAssignee').value;fillTaxTypes(tax);fillUsers(assignee);resetFollowers();};
$('eventStatus').onchange=updateDocumentFields;$('documentType').onchange=updateDocumentFields;
$('documentFile').onchange=()=>{const file=$('documentFile').files[0];$('selectedFile').hidden=!file;$('selectedFile').textContent=file?`${file.name} · ${formatBytes(file.size)}`:'';};
$('addFollower').onclick=()=>addFollower();
$('eventForm').onsubmit=event=>{event.preventDefault();void perform(saveEditor,{success:'Obligación tributaria guardada.',dialogError:'editorError'}).catch(()=>{});};
for(const id of ['closeEditor','cancelEditor'])$(id).onclick=()=>{if(!state.busy)$('editorDialog').close();};
$('requestDelete').onclick=()=>{$('deleteText').textContent=`Se eliminará ${state.editing?.taxTypeCode||'la obligación'} del período ${state.editing?.period||''}.`;$('deleteError').textContent='';$('deleteDialog').showModal();};
$('cancelDelete').onclick=()=>{if(!state.busy)$('deleteDialog').close();};
$('confirmDelete').onclick=()=>void perform(async()=>{await api('delete',{id:state.editing.id});$('deleteDialog').close();$('editorDialog').close();state.editing=null;await loadEvents();},{success:'Obligación eliminada.',dialogError:'deleteError'}).catch(()=>{});

document.querySelector('.view-tabs').onclick=event=>{const button=event.target.closest('[data-view]');if(!button||state.busy)return;state.view=button.dataset.view;if(state.view!=='table')updateDateRangeForView();void perform(loadEvents).catch(()=>{});};
$('previousPeriod').onclick=()=>{state.anchor=state.view==='month'?new Date(state.anchor.getFullYear(),state.anchor.getMonth()-1,1):addDays(state.anchor,-7);updateDateRangeForView();void perform(loadEvents).catch(()=>{});};
$('nextPeriod').onclick=()=>{state.anchor=state.view==='month'?new Date(state.anchor.getFullYear(),state.anchor.getMonth()+1,1):addDays(state.anchor,7);updateDateRangeForView();void perform(loadEvents).catch(()=>{});};
$('today').onclick=()=>{state.anchor=new Date();updateDateRangeForView();void perform(loadEvents).catch(()=>{});};
for(const id of ['monthGrid','weekGrid','eventRows'])$(id).onclick=event=>{const doc=event.target.closest('[data-document]');if(doc){void downloadDocument(doc.dataset.document);return;}const button=event.target.closest('[data-event]');if(button)void openEditor(button.dataset.event);};

$('openNotifications').onclick=()=>{$('notificationsDialog').showModal();};
$('closeNotifications').onclick=()=>{if(!state.busy)$('notificationsDialog').close();};
$('markAllRead').onclick=()=>void perform(async()=>{const ids=state.notifications.filter(item=>!item.readAt).map(item=>item.id);if(ids.length)await api('mark-read',{ids});await loadEvents();},{success:'Notificaciones marcadas como leídas.'}).catch(()=>{});
$('notificationList').onclick=event=>{const read=event.target.closest('[data-read]'),open=event.target.closest('[data-notification-event]');if(read)void perform(async()=>{await api('mark-read',{ids:[read.dataset.read]});await loadEvents();}).catch(()=>{});else if(open){$('notificationsDialog').close();void openEditor(open.dataset.notificationEvent);}};
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('cancel',event=>{if(state.busy)event.preventDefault();}));

void initialize();
