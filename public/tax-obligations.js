const $=id=>document.getElementById(id);
const state={options:{permissions:{},countries:[],placeholders:[]},obligations:[],templates:[],editing:null,busy:false,placeholderTarget:null};
const frequencyLabels={monthly:'Mensual',quarterly:'Trimestral',annual:'Anual',other:'Otra'};
const kindLabels={reminder:'Recordatorio previo al vencimiento',overdue:'Obligación vencida'};

function token(){return localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token')||'';}
function deviceToken(){return localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'';}
function headers(){return{Authorization:`Bearer ${token()}`,'X-Device-Token':deviceToken(),'Content-Type':'application/json'};}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));}
function placeholderToken(value){const text=String(value??'').trim();return text.startsWith('{{')?text:`{{${text}}}`;}

async function api(action,payload={}){
  const response=await fetch(`/api/tax-obligations/${action}`,{method:'POST',headers:headers(),body:JSON.stringify(payload)});
  const raw=await response.text();
  let data={};
  try{data=raw?JSON.parse(raw):{};}catch{data={};}
  if(!response.ok)throw Error(data?.error?.message||data?.error||data?.message||'No fue posible procesar la configuración tributaria.');
  return data;
}
function setMessage(message='',error=false){$('message').textContent=message;$('message').classList.toggle('error',error);}
function setBusy(value){
  state.busy=value;$('taxObligationsApp').setAttribute('aria-busy',String(value));
  for(const element of document.querySelectorAll('button, select, input, textarea')){
    if(value){element.dataset.taxWasDisabled=String(element.disabled);element.disabled=true;}
    else{element.disabled=element.dataset.taxWasDisabled==='true';delete element.dataset.taxWasDisabled;}
  }
}
async function perform(task,{success='',errorTarget=''}={}){
  if(state.busy)return;
  setBusy(true);setMessage();if(errorTarget)$(errorTarget).textContent='';
  try{const result=await task();if(success)setMessage(success);return result;}
  catch(cause){const message=cause instanceof Error?cause.message:'No fue posible completar la operación.';if(errorTarget)$(errorTarget).textContent=message;else setMessage(message,true);throw cause;}
  finally{setBusy(false);}
}

function countryOptions(){return state.options.countries.map(country=>`<option value="${escapeHtml(country.id)}">${escapeHtml(country.name)}</option>`).join('');}
function selectedCountryId(){const value=$('countryFilter').value;return value?Number(value):null;}
function selectedCountryName(){return state.options.countries.find(country=>String(country.id)===String(selectedCountryId()))?.name||'el país seleccionado';}
function fillCountries(){
  const markup=countryOptions();$('countryFilter').innerHTML=markup;$('obligationCountry').innerHTML=markup;
  const remembered=sessionStorage.getItem('nexo_tax_country');
  const selected=state.options.countries.some(country=>String(country.id)===String(remembered))?remembered:String(state.options.countries[0]?.id??'');
  $('countryFilter').value=selected;$('obligationCountry').value=selected;
  $('newObligation').disabled=!selected||!state.options.permissions.manage;
}

async function loadConfiguration(){
  const countryId=selectedCountryId();
  $('catalogLoading').hidden=false;$('catalogTable').hidden=true;$('catalogEmpty').hidden=true;
  try{
    const data=await api('list',countryId?{countryId}:{});
    state.obligations=Array.isArray(data.obligations)?data.obligations:[];
    state.templates=Array.isArray(data.templates)?data.templates:[];
    renderCatalog();renderTemplate();
  }finally{$('catalogLoading').hidden=true;}
}
function renderCatalog(){
  const rows=state.obligations;
  $('obligationCount').textContent=`${rows.length} ${rows.length===1?'obligación':'obligaciones'}`;
  $('catalogTable').hidden=!rows.length;$('catalogEmpty').hidden=Boolean(rows.length);
  $('obligationRows').innerHTML=rows.map(item=>`<tr>
    <td><strong>${escapeHtml(item.code)}</strong><small>${escapeHtml(item.countryName||selectedCountryName())}</small></td>
    <td><strong>${escapeHtml(item.name)}</strong></td>
    <td>${escapeHtml(frequencyLabels[item.frequency]||item.frequency)}</td>
    <td class="description-cell" title="${escapeHtml(item.description||'')}">${escapeHtml(item.description||'Sin descripción')}</td>
    <td><span class="status-chip ${item.isActive?'active':'inactive'}">${item.isActive?'Activa':'Inactiva'}</span></td>
    <td><div class="row-actions"><button class="button secondary" type="button" data-edit-obligation="${escapeHtml(item.id)}">${state.options.permissions.manage?'Editar':'Ver'}</button></div></td>
  </tr>`).join('');
}

function openObligation(id=null){
  const item=id?state.obligations.find(row=>String(row.id)===String(id)):null;
  state.editing=item||null;$('obligationForm').reset();$('obligationError').textContent='';
  $('obligationDialogTitle').textContent=item?'Editar obligación':'Nueva obligación';
  $('obligationCountry').value=String(item?.countryId??selectedCountryId()??'');
  $('obligationCode').value=item?.code||'';$('obligationName').value=item?.name||'';
  $('obligationFrequency').value=item?.frequency||'monthly';$('obligationDescription').value=item?.description||'';
  $('obligationActive').checked=item?Boolean(item.isActive):true;$('requestObligationDelete').hidden=!item||!state.options.permissions.manage;
  for(const field of $('obligationForm').elements)field.disabled=!state.options.permissions.manage&&field.tagName!=='BUTTON';
  $('obligationForm').querySelector('[type="submit"]').hidden=!state.options.permissions.manage;
  $('cancelObligation').textContent=state.options.permissions.manage?'Cancelar':'Cerrar';
  $('obligationDialog').showModal();
}
async function saveObligation(){
  const payload={id:state.editing?.id||undefined,countryId:Number($('obligationCountry').value),code:$('obligationCode').value.trim().toUpperCase(),name:$('obligationName').value.trim(),frequency:$('obligationFrequency').value,description:$('obligationDescription').value.trim()||null,isActive:$('obligationActive').checked};
  if(!payload.countryId||!payload.code||!payload.name)throw Error('Complete el país, el código y el nombre de la obligación.');
  await api('save',payload);$('obligationDialog').close();state.editing=null;
  if(String(payload.countryId)!==String(selectedCountryId())){$('countryFilter').value=String(payload.countryId);sessionStorage.setItem('nexo_tax_country',String(payload.countryId));}
  await loadConfiguration();
}

function currentTemplate(){const countryId=selectedCountryId(),kind=$('templateKind').value;return state.templates.find(template=>String(template.countryId)===String(countryId)&&template.kind===kind)||null;}
function renderPlaceholders(){
  const placeholders=state.options.placeholders||[];
  $('placeholderList').innerHTML=placeholders.length?placeholders.map(item=>`<button type="button" data-placeholder="${escapeHtml(placeholderToken(item.token))}" title="${escapeHtml(item.label||item.token)}">${escapeHtml(placeholderToken(item.token))}</button>`).join(''):'<span class="placeholder-empty">No hay variables configuradas.</span>';
}
function renderTemplate(){
  const template=currentTemplate(),kind=$('templateKind').value;
  $('templateSubject').value=template?.subjectTemplate||'';$('templateBody').value=template?.bodyTemplate||'';
  $('templateActive').checked=template?Boolean(template.isActive):true;
  $('templateStatus').textContent=template?`Plantilla guardada para ${template.countryName||selectedCountryName()}.`:`Aún no existe una plantilla de ${kindLabels[kind].toLocaleLowerCase('es')} para ${selectedCountryName()}.`;
  updatePreview();
}
function sampleValue(item){
  const key=placeholderToken(item.token).replace(/[{}]/g,'').toLocaleLowerCase('es');
  const examples={empresa:'Empresa de ejemplo',obligacion:'Declaración mensual de IVA',codigo:'IVA_MENSUAL',periodo:'2026-09',fecha_vencimiento:'30/09/2026',responsable:'Ana Contadora',estado:'Pendiente',mensaje_vencimiento:'Vence en 3 días',enlace:'https://erp.example/calendario'};
  return examples[key]||item.label||'Ejemplo';
}
function withSamples(value){return(state.options.placeholders||[]).reduce((text,item)=>text.split(placeholderToken(item.token)).join(sampleValue(item)),String(value||''));}
function updatePreview(){
  $('previewSubject').textContent=withSamples($('templateSubject').value)||'Sin asunto';
  const body=withSamples($('templateBody').value);
  const content=body?escapeHtml(body).replace(/\r?\n/g,'<br>'):'<span style="color:#64748b">Escriba el mensaje para ver una muestra.</span>';
  $('templatePreview').srcdoc=`<!doctype html><html lang="es"><head><meta charset="utf-8"><style>body{margin:0;background:#f3f6f8;color:#243b53;font:14px/1.65 Arial,sans-serif;padding:28px}.mail{max-width:680px;margin:auto;border:1px solid #dce4ea;border-radius:10px;background:#fff;padding:28px;box-shadow:0 8px 24px #17324d0d}.brand{margin:0 0 18px;color:#078464;font-size:11px;font-weight:700;letter-spacing:.13em}a{color:#06745b}img{max-width:100%}</style></head><body><div class="mail"><p class="brand">NEXO · FISCAL</p>${content}</div></body></html>`;
}
function insertPlaceholder(value){
  const input=state.placeholderTarget===$('templateSubject')?$('templateSubject'):$('templateBody');
  const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;input.setRangeText(value,start,end,'end');input.focus();
  updatePreview();
}
async function saveTemplate(){
  const payload={countryId:selectedCountryId(),kind:$('templateKind').value,subjectTemplate:$('templateSubject').value.trim(),bodyTemplate:$('templateBody').value.trim(),isActive:$('templateActive').checked};
  if(!payload.countryId)throw Error('Seleccione un país.');
  if(payload.subjectTemplate.length<3||payload.bodyTemplate.length<10)throw Error('Complete el asunto y el mensaje de la plantilla.');
  await api('save-template',payload);await loadConfiguration();
}

function showPanel(panelId){
  for(const button of document.querySelectorAll('.config-tabs [data-panel]')){const active=button.dataset.panel===panelId;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));$(button.dataset.panel).hidden=!active;}
}

$('countryFilter').onchange=()=>{sessionStorage.setItem('nexo_tax_country',$('countryFilter').value);void perform(loadConfiguration).catch(()=>{});};
$('newObligation').onclick=()=>openObligation();
$('obligationRows').onclick=event=>{const button=event.target.closest('[data-edit-obligation]');if(button)openObligation(button.dataset.editObligation);};
$('obligationForm').onsubmit=event=>{event.preventDefault();void perform(saveObligation,{success:'Obligación tributaria guardada.',errorTarget:'obligationError'}).catch(()=>{});};
for(const id of ['closeObligation','cancelObligation'])$(id).onclick=()=>{if(!state.busy)$('obligationDialog').close();};
$('requestObligationDelete').onclick=()=>{$('deleteObligationText').textContent=`Se eliminará “${state.editing?.name||'esta obligación'}” del catálogo de ${state.editing?.countryName||selectedCountryName()}.`;$('deleteObligationError').textContent='';$('deleteObligationDialog').showModal();};
$('cancelObligationDelete').onclick=()=>{if(!state.busy)$('deleteObligationDialog').close();};
$('confirmObligationDelete').onclick=()=>void perform(async()=>{await api('delete',{id:state.editing.id});$('deleteObligationDialog').close();$('obligationDialog').close();state.editing=null;await loadConfiguration();},{success:'Obligación eliminada.',errorTarget:'deleteObligationError'}).catch(()=>{});

document.querySelector('.config-tabs').onclick=event=>{const button=event.target.closest('[data-panel]');if(button)showPanel(button.dataset.panel);};
$('templateKind').onchange=renderTemplate;
$('templateSubject').addEventListener('focus',()=>state.placeholderTarget=$('templateSubject'));
$('templateBody').addEventListener('focus',()=>state.placeholderTarget=$('templateBody'));
$('templateSubject').addEventListener('input',updatePreview);$('templateBody').addEventListener('input',updatePreview);
$('placeholderList').onclick=event=>{const button=event.target.closest('[data-placeholder]');if(button)insertPlaceholder(button.dataset.placeholder);};
$('templateForm').onsubmit=event=>{event.preventDefault();void perform(saveTemplate,{success:'Plantilla de correo guardada.'}).catch(()=>{});};
$('obligationCode').addEventListener('input',()=>{$('obligationCode').value=$('obligationCode').value.toUpperCase();});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('cancel',event=>{if(state.busy)event.preventDefault();}));

async function initialize(){
  try{
    state.options=await api('options');
    if(!state.options.permissions?.view)throw Error('No tiene permiso para consultar la configuración tributaria.');
    fillCountries();renderPlaceholders();
    if(!state.options.countries?.length)throw Error('No hay países disponibles para configurar obligaciones tributarias.');
    $('workspace').hidden=false;$('accessDenied').hidden=true;$('newObligation').hidden=!state.options.permissions.manage;
    if(!state.options.permissions.manage){$('saveTemplate').hidden=true;$('templateActive').disabled=true;$('templateSubject').readOnly=true;$('templateBody').readOnly=true;$('placeholderList').hidden=true;}
    await loadConfiguration();
  }catch(cause){$('workspace').hidden=true;$('accessDenied').hidden=false;$('accessDenied').querySelector('p').textContent=cause instanceof Error?cause.message:'No fue posible abrir la configuración tributaria.';}
  finally{$('taxObligationsApp').setAttribute('aria-busy','false');}
}

void initialize();
