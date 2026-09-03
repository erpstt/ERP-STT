const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token')||'';
const query=new URLSearchParams(location.search),id=query.get('id');
const money=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
document.getElementById('printButton').onclick=()=>window.print();
document.getElementById('closeButton').onclick=()=>{
  window.close();
  setTimeout(()=>{if(!window.closed)location.assign('/bank-fees.html')},120);
};
const response=await fetch(`/api/banking/fees/${id}`,{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device}});
const result=await response.json();
if(!response.ok)throw Error(result.error?.message||'No fue posible cargar la comisión.');
const header=result.header;
document.getElementById('number').textContent=header.fee_number;
document.getElementById('details').innerHTML=[['Subsidiaria',header.subsidiaryName],['Fecha',header.fee_date],['Banco',header.bankName],['Cuenta',header.accountNumber],['Moneda',header.currencyCode],['Referencia',header.reference||'—'],['Importe',money(header.amount)],['Cuenta de gasto',`${header.expenseAccountNumber} · ${header.expenseAccountName}`],['Nota',header.memo]].map(([label,value])=>`<div><small>${label}</small><b>${value}</b></div>`).join('');
document.getElementById('impact').innerHTML=result.impact.map(line=>`<tr><td>${line.accountNumber}</td><td>${line.accountName}</td><td>${line.note||''}</td><td>${money(line.debit)}</td><td>${money(line.credit)}</td><td>${money(line.debitLocal)}</td><td>${money(line.creditLocal)}</td></tr>`).join('');
if(query.get('print'))setTimeout(()=>window.print(),500);
