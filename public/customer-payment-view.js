const $=id=>document.getElementById(id);
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token');
const money=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const id=new URLSearchParams(location.search).get('id');
const response=await fetch(`/api/sales/customer-payments/${id}`,{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device||''}});
const detail=await response.json();if(!response.ok)throw Error(detail?.error?.message||'No fue posible cargar el cobro.');
const header=detail.header,advanceTotal=(detail.advances||[]).reduce((sum,row)=>sum+Number(row.amount||0),0);
$('number').textContent=header.payment_number;
$('header').innerHTML=[['Subsidiaria',header.subsidiary],['Cliente',header.customer],['Fecha',header.payment_date],['Banco',header.bank],['Cuenta',header.account],['Moneda',header.currency],['Referencia',header.bank_reference],['Total aplicado',money(header.amount_received)],['Anticipos aplicados',advanceTotal?money(advanceTotal):null],['Ingreso bancario neto',money(Number(header.amount_received)-advanceTotal)],['Nota',header.memo]].filter(row=>row[1]!==null).map(row=>`<div><small>${row[0]}</small><b>${row[1]||'—'}</b></div>`).join('');
$('applications').innerHTML=detail.applications.map(row=>`<tr><td>${row.invoiceNumber}</td><td>${money(row.invoiceTotal)}</td><td>${money(row.amount)}</td></tr>`).join('');
if(advanceTotal>0){$('advanceSection').hidden=false;$('advances').innerHTML=detail.advances.map(row=>`<tr><td>${row.number}</td><td>${String(row.date).slice(0,10)}</td><td>${row.account}</td><td>${money(row.amount)}</td></tr>`).join('');}
$('impact').innerHTML=detail.impact.map(row=>`<tr><td>${row.accountNumber}</td><td>${row.accountName}</td><td>${money(row.debit)}</td><td>${money(row.credit)}</td></tr>`).join('');

