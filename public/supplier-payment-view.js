import {escapeHtml} from './html-safety.js?v=20261101-a03-1';
import {readRouteId} from './route-id.js?v=20261103-route-id-guard';
const routeId=readRouteId(location.search);
if(routeId===null){
 document.getElementById('number').textContent="El identificador del pago no es válido. Abra el pago desde la lista de pagos a proveedores.";
 document.querySelector('.print').disabled=true;
}else{
const esc=escapeHtml;
const $=id=>document.getElementById(id),token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token'),device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token'),money=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2}),id=routeId;
const accessResponse=await fetch('/api/purchasing/supplier-payments/access',{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device||''}}),access=await accessResponse.json();if(!accessResponse.ok||!access.canView){$('number').textContent='El rol activo no puede consultar este pago.';document.querySelector('.print').disabled=true;throw Error('Acceso denegado.')}
const response=await fetch(`/api/purchasing/supplier-payments/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device||''}}),data=await response.json();
if(!response.ok)throw Error(data?.error?.message||'No fue posible cargar el pago.');
const header=data.header,advanceTotal=(data.advances||[]).reduce((sum,row)=>sum+Number(row.amount),0);
$('number').textContent=header.payment_number;
$('header').innerHTML=[['Subsidiaria',header.subsidiary],['Proveedor',header.supplier],['Fecha',header.payment_date],['Banco',header.bank],['Cuenta',header.account],['Moneda',header.currency],['Referencia',header.bank_reference],['Total aplicado',money(data.applications.reduce((sum,row)=>sum+Number(row.amount),0))],['Anticipos utilizados',money(advanceTotal)],['Desembolso bancario',money(header.amount_paid)],['Nota',header.memo]].map(row=>`<div><small>${esc(row[0])}</small><b>${esc(row[1]||'—')}</b></div>`).join('');
$('applications').innerHTML=data.applications.map(row=>`<tr><td>${esc(row.invoiceNumber)}</td><td>${esc(money(row.invoiceTotal))}</td><td>${esc(money(row.amount))}</td></tr>`).join('');
if(data.advances?.length){$('advanceSection').hidden=false;$('advances').innerHTML=data.advances.map(row=>`<tr><td>${esc(row.number)}</td><td>${esc(String(row.date).slice(0,10))}</td><td>${esc(row.account)}</td><td>${esc(money(row.amount))}</td></tr>`).join('');}
$('impact').innerHTML=data.impact.map(row=>`<tr><td>${esc(row.accountNumber)}</td><td>${esc(row.accountName)}</td><td>${esc(money(row.debit))}</td><td>${esc(money(row.credit))}</td></tr>`).join('');
}
