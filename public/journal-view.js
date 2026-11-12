import {downloadPagePdf} from './document-pdf-download.js?v=20261111-export-review';
import {escapeHtml,safeAttachmentUrl,configureAttachmentLink} from './html-safety.js?v=20261101-a03-1';
import {readRouteId} from './route-id.js?v=20261103-route-id-guard';
const routeId=readRouteId(location.search);
if(routeId===null){
 document.getElementById('error').textContent='El identificador del asiento no es válido. Abra el asiento desde la lista de asientos.';
 document.getElementById('document').hidden=true;
 document.getElementById('edit').disabled=true;
 document.getElementById('pdf').disabled=true;
}else{
const esc=escapeHtml;
﻿const $=id=>document.getElementById(id),token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token'),device=localStorage.getItem('nexo_device_token'),id=routeId;
async function api(path){const r=await fetch(path,{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device}}),x=await r.json();if(!r.ok)throw Error(x.error?.message||'No fue posible cargar el comprobante.');return x}
let data={};
$('document').hidden=true;$('edit').disabled=true;$('pdf').disabled=true;
try{data=await api(`/api/accounting/journal-view/${encodeURIComponent(id)}`);const journal=data.journals?.find(x=>String(x.journal_id)===String(id));if(!journal)throw Error('No se encontr\u00f3 el asiento.');const lines=(data.lines||[]).sort((a,b)=>a.journal_line_id-b.journal_line_id);
const find=(rows,key,value)=>rows.find(x=>String(x[key])===String(value)),name=x=>x?.name||x?.company_name||[x?.first_name,x?.last_name].filter(Boolean).join(' ')||'',money=v=>Number(v||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2}),account=line=>find(data.accounts,'account_id',line.account_id),entity=line=>line.other_name_id!=null?find(data.otherNames,'other_name_id',line.other_name_id)||{name:`Otro Nombre #${line.other_name_id}`}:line.customer_id?find(data.customers,'customer_id',line.customer_id):line.supplier_id?find(data.suppliers,'supplier_id',line.supplier_id):find(data.employees,'employee_id',line.employee_id);
$('journalTitle').textContent=journal.journal_type||'Asiento contable';$('number').textContent=journal.journal_number;const fields=[['Tipo de asiento',journal.journal_type],['Fecha',journal.journal_date],['Período',name(find(data.periods,'fiscal_period_id',journal.fiscal_period_id))||find(data.periods,'fiscal_period_id',journal.fiscal_period_id)?.period_name],['Subsidiaria',name(find(data.subsidiaries,'subsidiary_id',journal.subsidiary_id))],['Moneda',name(find(data.currencies,'currency_id',journal.currency_id))],['Tipo de cambio',journal.exchange_rate],['Ubicación',name(find(data.locations,'location_id',journal.location_id))],['Nota',journal.memo||'—']];
$('summary').innerHTML=fields.map(([label,value])=>`<div><span>${esc(label)}</span><strong>${esc(value??'—')}</strong></div>`).join('');
const number=String(journal.journal_number||''),pendingServiceDimensions=journal.journal_type==='Asientos Pendientes de Facturar'||journal.journal_type==='Reversión de Pendiente de Facturar'||/^ASI_(?:REV_)?PEN-/.test(number),showServiceMonth=pendingServiceDimensions||lines.some(line=>Boolean(line.service_month)),showServiceCountry=pendingServiceDimensions;$('lines').innerHTML=lines.map(line=>{const a=account(line),e=entity(line);return `<tr><td>${esc(a?.account_number||'')}</td><td>${esc(a?.account_name||'')}</td><td class="numeric">${esc(money(line.debit))}</td><td class="numeric">${esc(money(line.credit))}</td><td>${esc(find(data.taxes,'tax_code_id',line.tax_code_id)?.code_name||'—')}</td><td class="numeric">${esc(line.tax_rate??0)}%</td><td class="numeric">${esc(money(line.gross_amount))}</td><td class="service-month-dimension-column" hidden>${esc(line.service_month||'—')}</td><td class="service-country-dimension-column" hidden>${esc(name(find(data.countries,'country_id',line.service_country_id))||'—')}</td><td>${esc(line.note||'')}</td><td>${esc(line.entity_type||'—')}</td><td>${esc(name(e)||'—')}</td><td>${esc(name(find(data.departments,'department_id',line.department_id))||'—')}</td><td>${esc(name(find(data.costs,'cost_center_id',line.cost_center_id))||'—')}</td><td>${esc(name(find(data.classes,'class_id',line.class_id))||'—')}</td></tr>`}).join('');document.querySelectorAll('.service-month-dimension-column').forEach(cell=>cell.hidden=!showServiceMonth);document.querySelectorAll('.service-country-dimension-column').forEach(cell=>cell.hidden=!showServiceCountry);$('lineFooterRemainder').colSpan=9+Number(showServiceMonth)+Number(showServiceCountry);
$('debit').textContent=money(journal.total_debit);
$('credit').textContent=money(journal.total_credit);
$('impacts').innerHTML=data.impacts.filter(x=>String(x.transaction_id)===String(journal.transaction_id)).map(impact=>{const a=find(data.accounts,'account_id',impact.account_id);return `<tr><td>${esc(a?.account_number||'')}</td><td>${esc(a?.account_name||'')}</td><td class="numeric">${esc(money(impact.debit_amount))}</td><td class="numeric">${esc(money(impact.credit_amount))}</td><td>${esc(impact.posting_date)}</td></tr>`}).join('')||'<tr><td colspan="5">No existe impacto contabilizado porque la subsidiaria no tiene un libro contable activo.</td></tr>';
if(journal.reversed_from_journal_id&&journal.journal_type==='Reversión de Pendiente de Facturar'){
 const supports=data.supports||[];
 if(supports.length){const section=document.createElement('section'),heading=document.createElement('h2');heading.textContent='Archivos de respaldo';section.append(heading);for(const item of supports){const isLink=item.support_type==='Enlace';if(!safeAttachmentUrl(isLink?item.support_url:item.file_data))continue;const row=document.createElement('p'),link=document.createElement('a');link.textContent=item.display_name||item.file_name;configureAttachmentLink(link,item);row.append(link);section.append(row)}$('document').append(section)}
}
$('generated').textContent=new Date().toLocaleString('es-CR');
$('footerSubsidiary').textContent=name(find(data.subsidiaries,'subsidiary_id',journal.subsidiary_id))||'Subsidiaria no identificada';
$('edit').onclick=()=>location.href=`/journal-entry.html?id=${encodeURIComponent(id)}`;
$('document').hidden=false;$('pdf').disabled=false;$('edit').hidden=!data.access?.canEdit;$('edit').disabled=!data.access?.canEdit;$('pdf').onclick=()=>downloadPagePdf();if(new URLSearchParams(location.search).get('print')==='1')setTimeout(()=>downloadPagePdf(),350)}catch(error){$('error').textContent=error.message;
$('document').hidden=true}
}
