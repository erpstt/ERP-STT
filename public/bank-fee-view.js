import {downloadPagePdf} from './document-pdf-download.js?v=20261111-export-review';
import {escapeHtml} from './html-safety.js?v=20261101-a03-1';
import {readRouteId} from './route-id.js?v=20261103-route-id-guard';
const routeId=readRouteId(location.search);
if(routeId===null){
 document.getElementById('number').textContent="El identificador de la comisión bancaria no es válido. Abra la comisión desde su lista.";
 document.querySelector('#printButton').disabled=true;
}else{
const esc=escapeHtml;
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token')||'';
const query=new URLSearchParams(location.search),id=routeId;
const money=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
document.getElementById('printButton').onclick=()=>downloadPagePdf();
document.getElementById('closeButton').onclick=()=>{
  window.close();
  setTimeout(()=>{if(!window.closed)location.assign('/bank-fees.html')},120);
};
const response=await fetch(`/api/banking/fees/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device}});
const result=await response.json();
if(!response.ok)throw Error(result.error?.message||'No fue posible cargar la comisión.');
const header=result.header;
document.getElementById('number').textContent=header.fee_number;
document.getElementById('details').innerHTML=[['Subsidiaria',header.subsidiaryName],['Fecha',header.fee_date],['Banco',header.bankName],['Cuenta',header.accountNumber],['Moneda',header.currencyCode],['Referencia',header.reference||'—'],['Importe',money(header.amount)],['Cuenta de gasto',`${header.expenseAccountNumber} · ${header.expenseAccountName}`],['Nota',header.memo]].map(([label,value])=>`<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('');
document.getElementById('impact').innerHTML=result.impact.map(line=>`<tr><td>${esc(line.accountNumber)}</td><td>${esc(line.accountName)}</td><td>${esc(line.note||'')}</td><td>${esc(money(line.debit))}</td><td>${esc(money(line.credit))}</td><td>${esc(money(line.debitLocal))}</td><td>${esc(money(line.creditLocal))}</td></tr>`).join('');
if(query.get('print'))setTimeout(()=>downloadPagePdf(),500);
}
