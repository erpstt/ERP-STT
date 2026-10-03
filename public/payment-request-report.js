const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=()=>localStorage.getItem('nexo_device_token')||'';
const state={options:{},report:{rows:[],summary:{},total:0,page:1,pageSize:50},page:1,expanded:new Set(),loading:false};

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
const array=value=>Array.isArray(value)?value:[];
const first=(...values)=>values.find(value=>value!==undefined&&value!==null&&value!=='');
const fmt=value=>number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const integer=value=>number(value).toLocaleString('es-CR',{maximumFractionDigits:0});
const money=(value,symbol='',currency='')=>`${symbol||currency||''} ${fmt(value)}`.trim();
const date=value=>{if(!value)return'—';const parsed=new Date(`${String(value).slice(0,10)}T12:00:00`);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleDateString('es-CR',{day:'2-digit',month:'short',year:'numeric'})};
const dateTime=value=>{if(!value)return'—';const parsed=new Date(value);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleString('es-CR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})};
const displayName=value=>{if(!value)return'';if(typeof value==='string')return value;return first(value.name,value.displayName,[value.firstName,value.lastName].filter(Boolean).join(' '),value.email,'')};
const rowId=row=>String(first(row.id,row.requestId,row.request_id,''));
const rowNumber=row=>first(row.number,row.requestNumber,row.numero,'—');
const rowType=row=>first(row.type,row.requestType,row.tipo_solicitud,'OTROS');
const rowStatus=row=>first(row.status,row.estado,'BORRADOR');
const rowCurrency=row=>{const item=row.currency&&typeof row.currency==='object'?row.currency:{};return{id:first(item.id,row.currencyId,row.id_moneda),code:first(item.code,item.currencyCode,row.currencyCode,row.moneda,''),symbol:first(item.symbol,row.currencySymbol,'')}};
const rowRequester=row=>row.requester&&typeof row.requester==='object'?row.requester:{id:row.requesterId,name:first(row.requesterName,row.solicitante,''),email:row.requesterEmail};
const rowLines=row=>array(first(row.lines,row.detailLines));
const rowDepartments=row=>array(row.departments);
const rowCostCenters=row=>array(first(row.costCenters,row.cost_centers));
const rowThirdParties=row=>array(first(row.thirdParties,row.third_parties));
const rowAccounts=row=>array(row.accounts);

function setLoading(value){
  state.loading=value;document.body.classList.toggle('loading',value);
  for(const id of['generate','downloadPdf','downloadExcel','resetFilters','previousPage','nextPage'])$(id).disabled=value;
  $('generate').textContent=value?'Generando…':'Generar reporte';
}
function showMessage(text='',success=false){$('message').textContent=text;$('message').classList.toggle('success',success)}
function optionList(...keys){for(const key of keys){if(Array.isArray(state.options?.[key]))return state.options[key]}return[]}
function fill(id,items,value,label,placeholder){
  const element=$(id);element.replaceChildren();if(placeholder!==undefined)element.append(new Option(placeholder,''));
  for(const item of items){const itemValue=value(item);if(itemValue===undefined||itemValue===null||itemValue==='')continue;element.append(new Option(label(item),String(itemValue)))}
}
function unique(items,key){return[...new Map(items.map(item=>[String(key(item)),item])).values()]}
function subsidiary(){return state.options.subsidiary||state.options.activeSubsidiary||array(state.options.subsidiaries)[0]||{}}

const defaultTypes=[{id:'CXP',name:'Pago de CxP'},{id:'OTROS',name:'Otros pagos'}];
const defaultStatuses=[
  {id:'BORRADOR',name:'Borrador'},{id:'PENDIENTE_APROBACION',name:'Pendiente de aprobación'},
  {id:'APROBADO',name:'Aprobado'},{id:'APLICADO',name:'Aplicado'},
  {id:'RECHAZADO',name:'Rechazado'},{id:'ANULADO',name:'Anulado'}
];
function populateOptions(){
  const company=subsidiary();$('subsidiary').value=first(company.name,company.subsidiaryName,'Empresa activa');
  const types=optionList('requestTypes','types');fill('requestType',types.length?types:defaultTypes,item=>first(item.id,item.value),item=>first(item.name,item.label,item.id),'Todos los tipos');
  const statuses=optionList('statuses','requestStatuses');fill('status',statuses.length?statuses:defaultStatuses,item=>first(item.id,item.value),item=>first(item.name,item.label,String(item.id).replaceAll('_',' ')),'Todos los estados');
  fill('currency',optionList('currencies'),item=>first(item.id,item.currencyId),item=>[first(item.code,item.currencyCode),item.name].filter(Boolean).join(' · '),'Todas las monedas');
  fill('requester',optionList('requesters','users'),item=>item.id,item=>displayName(item)||item.email||`Usuario ${item.id}`,'Todos los solicitantes');
  fill('approver',optionList('approvers'),item=>item.id,item=>displayName(item)||item.email||`Usuario ${item.id}`,'Todos los aprobadores');
  fill('method',optionList('methods','paymentMethods'),item=>typeof item==='string'?item:first(item.id,item.value,item.code),item=>typeof item==='string'?item:first(item.name,item.label,item.id),'Todos los métodos');
  fill('department',optionList('departments'),item=>item.id,item=>[item.name,item.type].filter(Boolean).join(' · '),'Todos los departamentos');
  fill('costCenter',optionList('costCenters','cost_centers'),item=>item.id,item=>[item.code,item.name].filter(Boolean).join(' · '),'Todos los centros de costo');
  fill('account',optionList('accounts'),item=>item.id,item=>[first(item.number,item.code),item.name].filter(Boolean).join(' · '),'Todas las cuentas');
  const parties=unique(optionList('thirdParties','parties'),item=>first(item.key,`${item.type}:${item.id}`));
  fill('thirdParty',parties,item=>first(item.key,`${item.type}:${item.id}`),item=>`${first(item.type,'Tercero')} · ${first(item.name,item.displayName,item.id)}`,'Todos los terceros');
}

function setDefaultDates(){
  const now=new Date(),local=new Date(now.getTime()-now.getTimezoneOffset()*60000),today=local.toISOString().slice(0,10);
  $('dateFrom').value=`${today.slice(0,4)}-01-01`;$('dateTo').value=today;
}
function thirdPartyFilter(){const value=$('thirdParty').value;if(!value)return{thirdPartyType:null,thirdPartyId:null};const separator=value.indexOf(':');return separator<1?{thirdPartyType:null,thirdPartyId:value}:{thirdPartyType:value.slice(0,separator),thirdPartyId:value.slice(separator+1)}}
function filters(includePagination=true){
  const company=subsidiary(),type=$('requestType').value,status=$('status').value,party=thirdPartyFilter();
  const payload={subsidiaryId:first(company.id,company.subsidiaryId),dateFrom:$('dateFrom').value,dateTo:$('dateTo').value,dateField:$('dateField').value,types:type?[type]:[],statuses:status?[status]:[],requesterId:$('requester').value||null,approverId:$('approver').value||null,method:$('method').value||null,currencyId:$('currency').value||null,thirdPartyKey:$('thirdParty').value||null,...party,departmentId:$('department').value||null,costCenterId:$('costCenter').value||null,accountId:$('account').value||null,groupBy:$('groupBy').value,search:$('search').value.trim()||null};
  if(includePagination){payload.page=state.page;payload.pageSize=Number($('pageSize').value)}
  return payload;
}
function validateFilters(){if(!$('dateFrom').value||!$('dateTo').value)throw Error('Indique el rango de fechas del reporte.');if($('dateFrom').value>$('dateTo').value)throw Error('La fecha inicial no puede ser posterior a la fecha final.')}

function currencyTotals(summary){
  const source=first(summary.totalsByCurrency,summary.byCurrency,summary.currencyTotals,[]);
  if(Array.isArray(source))return source.map(item=>({currencyId:first(item.currencyId,item.id),currencyCode:first(item.currencyCode,item.code,item.currency,''),symbol:first(item.symbol,''),amount:number(first(item.amount,item.total,item.requestAmount,item.requestedAmount))}));
  if(source&&typeof source==='object')return Object.entries(source).map(([code,item])=>typeof item==='object'?{currencyId:item.currencyId,currencyCode:first(item.currencyCode,item.code,code),symbol:first(item.symbol,''),amount:number(first(item.amount,item.total,item.requestAmount,item.requestedAmount))}:{currencyCode:code,symbol:'',amount:number(item)});
  return[];
}
function distributionItems(summary){
  const normalize=(source,prefix)=>Array.isArray(source)?source.map(item=>({key:`${prefix}-${first(item.type,item.status,item.id,item.label)}`,label:first(item.label,item.name,String(first(item.type,item.status,item.id,'')).replaceAll('_',' ')),count:number(item.count)})):[];
  return[...normalize(summary.byType,'type'),...normalize(summary.byStatus,'status')];
}
function renderSummary(){
  const summary=state.report.summary||{},totals=currencyTotals(summary),distributions=distributionItems(summary);
  $('summary').innerHTML=`<div class="summary-kpis">
    <article class="metric"><small>Solicitudes encontradas</small><b>${esc(integer(first(summary.requestCount,state.report.total,0)))}</b></article>
    <article class="metric lines"><small>Partidas incluidas</small><b>${esc(integer(first(summary.lineCount,0)))}</b></article>
    <article class="metric supports"><small>Archivos y enlaces de respaldo</small><b>${esc(integer(first(summary.supportCount,0)))}</b></article>
  </div>
  <article class="currency-summary"><header><b>Monto solicitado por moneda</b><small>Las monedas se presentan separadas para conservar su valor original.</small></header><div class="currency-list">${totals.length?totals.map(item=>`<div class="currency-total"><small>${esc(item.currencyCode||'Moneda')}</small><b>${esc(money(item.amount,item.symbol,item.currencyCode))}</b></div>`).join(''):'<div class="currency-total"><small>Sin movimientos</small><b>0,00</b></div>'}</div></article>
  ${distributions.length?`<article class="distribution"><header><b>Composición de las solicitudes</b><small>Conteo por tipo y estado.</small></header><div class="distribution-body">${distributions.map(item=>`<span class="distribution-pill"><span>${esc(item.label)}</span><b>${esc(integer(item.count))}</b></span>`).join('')}</div></article>`:''}`;
}

function tags(items,label){const values=items.map(item=>typeof item==='string'?item:label(item)).filter(Boolean);return values.length?`<div class="tag-list">${values.slice(0,4).map(value=>`<span class="tag">${esc(value)}</span>`).join('')}${values.length>4?`<span class="tag">+${values.length-4}</span>`:''}</div>`:'<span class="cell-note">Sin asignar</span>'}
function safeUrl(value){try{const url=new URL(value);return['http:','https:'].includes(url.protocol)?url.href:''}catch{return''}}
function approvalOf(row){return row.approval&&typeof row.approval==='object'?row.approval:{approvedAt:row.approvedAt,approvedBy:row.approvedBy,workflowStatus:row.workflowStatus,currentLevel:row.currentLevel}}
function paymentOf(row){return row.payment&&typeof row.payment==='object'?row.payment:{method:row.paymentMethod,reference:row.bankReference,appliedAt:row.appliedAt,appliedBy:row.appliedBy,journalId:row.journalId,paymentId:row.paymentId,checkId:row.checkId}}
function lineDepartments(line){return array(first(line.departments,line.department?[line.department]:[]))}
function lineCenters(line){return array(first(line.costCenters,line.cost_centers,line.costCenter?[line.costCenter]:[]))}
function lineParty(line){return first(line.partyName,line.party?.name,line.thirdPartyName,'—')}
function lineOrigin(line,row){const invoice=first(line.invoiceNumber,line.sourceDocumentNumber);if(invoice)return`Factura ${invoice}`;const account=[line.accountNumber,line.accountName].filter(Boolean).join(' · ');if(account)return account;return rowType(row)==='CXP'?'Factura de proveedor':'Imputación directa'}
function supportMarkup(row){
  const supports=array(row.supports);if(!supports.length)return'<p>Sin archivos ni enlaces registrados.</p>';
  return`<div class="support-list">${supports.map(item=>{const name=first(item.name,item.displayName,item.fileName,'Respaldo'),url=safeUrl(first(item.url,item.downloadUrl,''));return url?`<a class="support-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(name)} ↗</a>`:`<span class="support-file">${esc(name)}</span>`}).join('')}</div>`;
}
function detailPanel(row){
  const lines=rowLines(row),currency=rowCurrency(row),approval=approvalOf(row),payment=paymentOf(row),approvalName=displayName(approval.approvedBy)||first(approval.approvedByName,'Pendiente'),appliedName=displayName(payment.appliedBy)||first(payment.appliedByName,'—');
  const body=lines.map(line=>`<tr><td><b>${esc(lineOrigin(line,row))}</b>${line.invoiceDate?`<span class="cell-note">${esc(date(line.invoiceDate))} · vence ${esc(date(line.invoiceDueDate))}</span>`:''}</td><td>${esc(first(line.partyType,'—'))}<span class="cell-note">${esc(lineParty(line))}</span></td><td>${esc([line.accountNumber,line.accountName].filter(Boolean).join(' · ')||'—')}</td><td>${tags(lineDepartments(line),item=>first(item.name,item.departmentName))}</td><td>${tags(lineCenters(line),item=>[item.code,item.name].filter(Boolean).join(' · '))}</td><td>${esc(first(line.concept,line.note,'—'))}</td><td class="number"><b>${esc(money(line.amount,currency.symbol,currency.code))}</b></td></tr>`).join('')||'<tr><td colspan="7">La solicitud no tiene partidas disponibles para mostrar.</td></tr>';
  return`<div class="detail-panel"><div class="detail-header"><b>Partidas y documentos de origen</b><span>${lines.length} partida${lines.length===1?'':'s'}</span></div><div class="table-wrap"><table><thead><tr><th>Origen</th><th>Tercero</th><th>Cuenta contable</th><th>Departamento</th><th>Centro de costo</th><th>Concepto</th><th class="number">Monto solicitado</th></tr></thead><tbody>${body}</tbody></table></div><div class="detail-footer">
    <article class="trace-card"><small>APROBACIÓN</small><b>${esc(String(first(approval.workflowStatus,rowStatus(row))).replaceAll('_',' '))}</b><p>${esc(approvalName)}${approval.approvedAt?` · ${esc(dateTime(approval.approvedAt))}`:''}${approval.currentLevel?` · Nivel ${esc(approval.currentLevel)}`:''}</p></article>
    <article class="trace-card"><small>APLICACIÓN / PAGO</small><b>${esc(first(payment.method,'Sin ejecutar'))}</b><p>${payment.appliedAt?`${esc(dateTime(payment.appliedAt))} · ${esc(appliedName)}`:'La solicitud todavía no ha generado el pago.'}${payment.reference?`<br>Referencia: ${esc(payment.reference)}`:''}${payment.journalId?`<br><a class="request-link" href="/journal-view.html?id=${encodeURIComponent(payment.journalId)}">Ver asiento contable</a>`:''}</p></article>
    <article class="trace-card"><small>RESPALDOS</small><b>${array(row.supports).length} documento${array(row.supports).length===1?'':'s'}</b>${supportMarkup(row)}</article>
  </div></div>`;
}

function requestRows(rows){return rows.map(row=>{
  const id=rowId(row),open=state.expanded.has(id),currency=rowCurrency(row),requester=rowRequester(row),approval=approvalOf(row),payment=paymentOf(row),type=rowType(row),status=rowStatus(row),parties=rowThirdParties(row),departments=rowDepartments(row),centers=rowCostCenters(row),accounts=rowAccounts(row),requestDate=first(row.requestDate,row.fecha_solicitud),plannedDate=first(row.plannedDate,row.fecha_pago_programada),requestTotal=first(row.total,row.requestTotal,0);
  const approved=displayName(approval.approvedBy)||first(approval.approvedByName,'—');
  return`<tr class="request-record"><td><button class="expand-button" type="button" data-expand="${esc(id)}" aria-expanded="${open}" title="${open?'Ocultar':'Ver'} detalle">${open?'−':'+'}</button></td><td><span class="request-number">${esc(rowNumber(row))}</span><span class="cell-note">${esc(first(row.concept,row.concepto,'Sin concepto'))}</span><a class="request-link" href="/payment-requests.html?id=${encodeURIComponent(id)}">Abrir solicitud</a></td><td><span class="cell-title">${esc(date(requestDate))}</span><span class="cell-note">Programada: ${esc(date(plannedDate))}</span></td><td><span class="badge type-${esc(type)}">${esc(first(row.typeLabel,type==='CXP'?'Pago de CxP':'Otros pagos'))}</span><span class="cell-note"><span class="badge status-${esc(status)}">${esc(first(row.statusLabel,String(status).replaceAll('_',' ')))}</span></span></td><td><span class="cell-title">${esc(displayName(requester)||requester.email||'—')}</span>${requester.email&&requester.email!==displayName(requester)?`<span class="cell-note">${esc(requester.email)}</span>`:''}</td><td>${tags(parties,item=>`${first(item.type,'Tercero')} · ${first(item.name,item.partyName,item.id)}`)}</td><td>${tags(departments,item=>first(item.name,item.departmentName))}<span class="cell-note">${centers.length?'Centros de costo:':''}</span>${centers.length?tags(centers,item=>[item.code,item.name].filter(Boolean).join(' · ')):''}${!departments.length&&!centers.length&&accounts.length?`<span class="cell-note">${esc(accounts.map(item=>first(item.number,item.code)).filter(Boolean).join(', '))}</span>`:''}</td><td class="number amount"><strong>${esc(money(requestTotal,currency.symbol,currency.code))}</strong><span class="cell-note">${esc(currency.code||'Moneda no indicada')}</span></td><td><span class="cell-title">${esc(String(first(approval.workflowStatus,status)).replaceAll('_',' '))}</span><span class="cell-note">${esc(approved)}${approval.approvedAt?` · ${esc(date(approval.approvedAt))}`:''}</span></td><td><span class="cell-title">${esc(first(payment.method,status==='APLICADO'?'Aplicado':'Pendiente'))}</span><span class="cell-note">${esc(first(payment.reference,'Sin referencia'))}${payment.appliedAt?` · ${esc(date(payment.appliedAt))}`:''}</span></td></tr><tr class="detail-row" ${open?'':'hidden'}><td colspan="10">${detailPanel(row)}</td></tr>`;
}).join('')}
function table(rows){return`<div class="table-wrap"><table><thead><tr><th aria-label="Detalle"></th><th>Solicitud / concepto</th><th>Solicitud / programación</th><th>Tipo / estado</th><th>Solicitante</th><th>Terceros</th><th>Dimensiones</th><th class="number">Monto</th><th>Aprobación</th><th>Pago / referencia</th></tr></thead><tbody>${requestRows(rows)}</tbody></table></div>`}
function groupDescriptor(row,mode){
  if(mode==='TYPE')return{key:rowType(row),label:first(row.typeLabel,rowType(row)==='CXP'?'Pago de CxP':'Otros pagos')};
  if(mode==='STATUS')return{key:rowStatus(row),label:first(row.statusLabel,String(rowStatus(row)).replaceAll('_',' '))};
  if(mode==='THIRD_PARTY'){const items=rowThirdParties(row),label=items.length===1?first(items[0].name,items[0].partyName):items.length?`${items.length} terceros`:'Sin tercero';return{key:label,label}}
  if(mode==='DEPARTMENT'){const items=rowDepartments(row),label=items.length===1?first(items[0].name,items[0].departmentName):items.length?`${items.length} departamentos`:'Sin departamento';return{key:label,label}}
  if(mode==='COST_CENTER'){const items=rowCostCenters(row),label=items.length===1?[items[0].code,items[0].name].filter(Boolean).join(' · '):items.length?`${items.length} centros de costo`:'Sin centro de costo';return{key:label,label}}
  if(mode==='CURRENCY'){const currency=rowCurrency(row),label=currency.code||'Sin moneda';return{key:label,label}}
  if(mode==='REQUESTER'){const requester=rowRequester(row),label=displayName(requester)||requester.email||'Sin solicitante';return{key:String(first(requester.id,label)),label}}
  return{key:'ALL',label:'Todas las solicitudes'};
}
function groupTotals(rows){const totals=new Map();for(const row of rows){const currency=rowCurrency(row),key=currency.code||'Moneda',value=totals.get(key)||{amount:0,symbol:currency.symbol};value.amount+=number(first(row.total,row.requestTotal));totals.set(key,value)}return[...totals].map(([code,value])=>money(value.amount,value.symbol,code)).join(' · ')}
function renderRows(){
  const rows=array(state.report.rows),mode=$('groupBy').value;
  if(!rows.length){$('reportGroups').innerHTML='<div class="empty-state"><span aria-hidden="true">✓</span><b>No hay solicitudes con estos filtros</b><small>Pruebe otro período, estado, tercero o dimensión contable.</small></div>';return}
  if(mode==='NONE')$('reportGroups').innerHTML=table(rows);
  else{
    const grouped=new Map();for(const row of rows){const descriptor=groupDescriptor(row,mode),group=grouped.get(descriptor.key)||{label:descriptor.label,rows:[]};group.rows.push(row);grouped.set(descriptor.key,group)}
    $('reportGroups').innerHTML=[...grouped.values()].map(group=>`<section class="group-section"><div class="group-heading"><div><span class="group-dot"></span><b>${esc(group.label)}</b></div><span>${group.rows.length} solicitud${group.rows.length===1?'':'es'} · ${esc(groupTotals(group.rows))}</span></div>${table(group.rows)}</section>`).join('');
  }
  $('reportGroups').querySelectorAll('[data-expand]').forEach(button=>button.onclick=()=>{const id=String(button.dataset.expand);state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);renderRows()});
}
function renderPager(){const total=number(state.report.total),size=Number($('pageSize').value),pages=Math.max(1,Math.ceil(total/size));$('resultCount').textContent=`${integer(total)} solicitud${total===1?'':'es'}`;$('pageCaption').textContent=`Página ${state.page} de ${pages}`;$('previousPage').disabled=state.loading||state.page<=1;$('nextPage').disabled=state.loading||state.page>=pages}
const dateFieldLabels={REQUEST:'fecha de solicitud',PLANNED:'fecha programada de pago',APPLIED:'fecha de aplicación'};
function render(){const header=state.report.header||{},from=first(header.dateFrom,$('dateFrom').value),to=first(header.dateTo,$('dateTo').value);$('periodCaption').textContent=`Según ${dateFieldLabels[$('dateField').value]||'fecha seleccionada'}, del ${date(from)} al ${date(to)}.`;renderSummary();renderRows();renderPager()}

async function run(){
  try{validateFilters()}catch(error){showMessage(error.message);return}
  setLoading(true);showMessage('');
  try{const payload=await api('/api/v1/reports/treasury/payment-requests',{method:'POST',body:JSON.stringify(filters())});state.report=payload?.result||payload?.data||payload||{rows:[],summary:{},total:0};state.report.rows=array(state.report.rows);state.expanded.clear();render()}
  catch(error){showMessage(error.message);$('summary').replaceChildren();$('reportGroups').innerHTML=`<div class="empty-state"><span aria-hidden="true">!</span><b>No fue posible generar el reporte</b><small>${esc(error.message)}</small></div>`}finally{setLoading(false);renderPager()}
}

function filename(response,fallback){const disposition=response.headers.get('Content-Disposition')||'',encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i),plain=disposition.match(/filename="?([^";]+)"?/i);try{return encoded?decodeURIComponent(encoded[1]):plain?.[1]||fallback}catch{return fallback}}
function save(blob,name){const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
async function exportReport(format){
  try{validateFilters()}catch(error){showMessage(error.message);return}
  const button=format==='pdf'?$('downloadPdf'):$('downloadExcel'),label=button.innerHTML;setLoading(true);button.innerHTML='Preparando descarga…';showMessage('');
  try{const response=await fetch(`/api/v1/reports/treasury/payment-requests/${format}`,{method:'POST',headers:headers(true),body:JSON.stringify(filters(false))});if(!response.ok){const text=await response.text();let payload={};try{payload=JSON.parse(text)}catch{}throw Error(payload?.error?.message||payload?.message||'No fue posible preparar la descarga.')}const blob=await response.blob(),extension=format==='pdf'?'pdf':'xlsx';save(blob,filename(response,`solicitudes-de-pago-${$('dateTo').value}.${extension}`));showMessage('La descarga se generó correctamente.',true)}catch(error){showMessage(error.message)}finally{setLoading(false);button.innerHTML=label;renderPager()}
}

$('filters').onsubmit=event=>{event.preventDefault();state.page=1;run()};
$('groupBy').onchange=()=>renderRows();
$('dateField').onchange=()=>{$('dateHelp').textContent=$('dateField').value==='REQUEST'?'El período se aplica a la fecha en que se creó cada solicitud.':$('dateField').value==='PLANNED'?'El período se aplica a la fecha programada para efectuar el pago.':'El período incluye únicamente solicitudes aplicadas cuya fecha de ejecución esté dentro del rango.'};
$('pageSize').onchange=()=>{state.page=1;run()};
$('previousPage').onclick=()=>{if(state.page>1){state.page--;run()}};
$('nextPage').onclick=()=>{const pages=Math.ceil(number(state.report.total)/Number($('pageSize').value));if(state.page<pages){state.page++;run()}};
$('downloadPdf').onclick=()=>exportReport('pdf');
$('downloadExcel').onclick=()=>exportReport('excel');
$('resetFilters').onclick=()=>{setDefaultDates();for(const id of['requestType','status','currency','thirdParty','department','costCenter','requester','approver','method','account'])$(id).value='';$('dateField').value='REQUEST';$('groupBy').value='NONE';$('search').value='';$('dateField').dispatchEvent(new Event('change'));state.page=1;run()};

async function init(){
  setDefaultDates();setLoading(true);
  try{const payload=await api('/api/v1/reports/treasury/payment-requests/options');state.options=payload?.result||payload?.data||payload||{};if(!first(subsidiary().id,subsidiary().subsidiaryId))throw Error('No se encontró una empresa activa autorizada.');populateOptions();await run()}
  catch(error){showMessage(error.message);$('reportGroups').innerHTML=`<div class="empty-state"><span aria-hidden="true">!</span><b>No fue posible cargar el reporte</b><small>${esc(error.message)}</small></div>`}finally{setLoading(false);renderPager()}
}

init();
