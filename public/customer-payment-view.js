const $=id=>document.getElementById(id);
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token');
const paymentId=new URLSearchParams(location.search).get('id');
const esc=value=>String(value??'—').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numeric=value=>{const parsed=Number(value??0);return Number.isFinite(parsed)?parsed:0;};
const safeName=value=>String(value||'comprobante-cobro.pdf').replace(/[\\/:*?"<>|\r\n]/g,'-');
const requestHeaders=()=>({Authorization:`Bearer ${token}`,'X-Device-Token':device||''});

function formatDate(value){
  const iso=String(value??'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return'—';
  return new Intl.DateTimeFormat('es-CR',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${iso}T12:00:00Z`));
}
function formatRate(value){return numeric(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:10});}
function filenameFrom(response,fallback){
  const disposition=response.headers.get('content-disposition')||'',encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1],plain=/filename="?([^";]+)"?/i.exec(disposition)?.[1];
  try{return safeName(encoded?decodeURIComponent(encoded):plain||fallback)}catch{return safeName(fallback)}
}
function downloadBlob(blob,fileName){
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=fileName;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function showAction(message,type='success'){
  const box=$('actionMessage');box.textContent=message;box.className=`action-message ${type}`;box.hidden=false;
  clearTimeout(showAction.timer);showAction.timer=setTimeout(()=>{box.hidden=true},6500);
}

async function api(path){
  const response=await fetch(path,{headers:requestHeaders()}),payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(payload?.error?.message||payload?.message||'No fue posible cargar el comprobante.');
  return payload;
}

async function downloadPdf(paymentNumber){
  const button=$('downloadPdf'),label=button.innerHTML;
  try{
    button.disabled=true;button.textContent='Generando PDF…';showAction('Preparando el archivo para descarga…');
    const response=await fetch(`/api/sales/customer-payments/${encodeURIComponent(paymentId)}/pdf`,{headers:requestHeaders()});
    if(!response.ok){const failure=await response.json().catch(()=>({}));throw Error(failure?.error?.message||failure?.message||'No fue posible generar el PDF del cobro.');}
    const fallback=`comprobante-cobro-${safeName(paymentNumber)}.pdf`,type=response.headers.get('content-type')||'';
    if(type.includes('application/json')){
      const file=await response.json();if(!file.base64)throw Error('El servidor no devolvió un PDF válido.');
      const bytes=Uint8Array.from(atob(file.base64),char=>char.charCodeAt(0));
      downloadBlob(new Blob([bytes],{type:file.mimeType||'application/pdf'}),safeName(file.fileName||fallback));
    }else{
      const blob=await response.blob();if(!blob.size)throw Error('El PDF generado está vacío.');
      downloadBlob(blob,filenameFrom(response,fallback));
    }
    showAction('PDF descargado correctamente.');
  }catch(error){showAction(error.message,'error')}
  finally{button.disabled=false;button.innerHTML=label}
}

try{
  if(!token)throw Error('Debe iniciar sesión para consultar el cobro.');
  if(!/^\d+$/.test(String(paymentId||''))||Number(paymentId)<=0)throw Error('No se recibió un cobro válido.');
  const detail=await api(`/api/sales/customer-payments/${paymentId}`),header=detail.header||{},applications=Array.isArray(detail.applications)?detail.applications:[],advances=Array.isArray(detail.advances)?detail.advances:[],impact=Array.isArray(detail.impact)?detail.impact:[],bankFee=detail.bankFee||{};
  const currency=String(header.currency||'').trim(),money=value=>`${currency?`${currency} `:''}${numeric(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const applicationTotal=applications.reduce((sum,row)=>sum+numeric(row.amount),0),advanceTotal=advances.reduce((sum,row)=>sum+numeric(row.amount),0),bankFeeTotal=numeric(bankFee.amount??bankFee.bank_fee_amount),withholdingTotal=Math.max(applicationTotal-numeric(header.amount_received),0),bankNet=Math.max(numeric(header.amount_received)-advanceTotal-bankFeeTotal,0);
  let totalDebit=0,totalCredit=0;

  $('toolbarNumber').textContent=header.payment_number||'Comprobante de cobro';
  $('companyName').textContent=header.subsidiary||'Subsidiaria activa';
  $('locationName').textContent=header.location?`Ubicación: ${header.location}`:'Documento de la subsidiaria activa';
  $('number').textContent=header.payment_number||'—';
  $('status').textContent=String(header.status||'CONTABILIZADO').replaceAll('_',' ').toUpperCase();
  $('customerName').textContent=header.customer||'—';
  $('paymentDate').textContent=formatDate(header.payment_date);
  $('bankReference').textContent=header.bank_reference||'—';
  $('bankAccount').textContent=[header.bank,header.account].filter(Boolean).join(' · ')||'—';
  $('currencyRate').textContent=`${currency||'—'} · Tasa ${formatRate(header.exchange_rate)}`;
  $('applicationTotal').textContent=money(applicationTotal);$('applicationTableTotal').textContent=money(applicationTotal);
  $('withholdingTotal').textContent=money(withholdingTotal);$('withholdingCard').hidden=withholdingTotal<=0;
  $('advanceTotal').textContent=money(advanceTotal);$('advanceCard').hidden=advanceTotal<=0;
  $('bankFeeTotal').textContent=money(bankFeeTotal);$('feeCard').hidden=bankFeeTotal<=0;
  $('bankFeeAccount').textContent=bankFeeTotal>0?[bankFee.expenseAccountNumber??bankFee.expense_account_number,bankFee.expenseAccountName??bankFee.expense_account_name].filter(Boolean).join(' · ')||'Cuenta de gasto bancaria':'';
  $('bankNet').textContent=money(bankNet);

  $('applicationCount').textContent=`${applications.length} factura${applications.length===1?'':'s'}`;
  $('applications').innerHTML=applications.map(row=>`<tr><td><b>${esc(row.invoiceNumber??row.invoice_number)}</b></td><td class="num">${esc(money(row.invoiceTotal??row.invoice_total))}</td><td class="num"><b>${esc(money(row.amount))}</b></td></tr>`).join('')||'<tr><td colspan="3">No existen facturas aplicadas.</td></tr>';
  if(advances.length){$('advanceSection').hidden=false;$('advanceCount').textContent=`${advances.length} registro${advances.length===1?'':'s'}`;$('advances').innerHTML=advances.map(row=>`<tr><td><b>${esc(row.number??row.journal_number)}</b></td><td>${esc(formatDate(row.date??row.journal_date))}</td><td>${esc(row.account??row.account_number)}</td><td class="num"><b>${esc(money(row.amount))}</b></td></tr>`).join('');}
  $('impact').innerHTML=impact.map(row=>{const debit=numeric(row.debit),credit=numeric(row.credit);totalDebit+=debit;totalCredit+=credit;return`<tr><td><b>${esc(row.accountNumber??row.account_number)}</b></td><td>${esc(row.accountName??row.account_name)}</td><td class="num">${esc(money(debit))}</td><td class="num">${esc(money(credit))}</td></tr>`}).join('')||'<tr><td colspan="4">No existe impacto contable registrado.</td></tr>';
  $('impactDebit').textContent=money(totalDebit);$('impactCredit').textContent=money(totalCredit);
  const balanced=Math.abs(totalDebit-totalCredit)<.005;$('balanceStatus').textContent=balanced?'ASIENTO CUADRADO':`DIFERENCIA ${money(totalDebit-totalCredit)}`;$('balanceStatus').classList.add(balanced?'balanced':'unbalanced');
  $('memo').textContent=header.memo||'Sin notas adicionales.';$('footerCompany').textContent=`${header.subsidiary||'Subsidiaria activa'} · ${header.payment_number||''}`;$('generatedAt').textContent=`Consultado el ${new Intl.DateTimeFormat('es-CR',{dateStyle:'medium',timeStyle:'short'}).format(new Date())}`;
  document.title=`Cobro ${header.payment_number||paymentId} · GENTIA`;
  $('downloadPdf').onclick=()=>downloadPdf(header.payment_number||paymentId);
  $('close').onclick=()=>history.length>1?history.back():location.assign('/customer-payments.html');
  $('loading').hidden=true;$('document').hidden=false;
}catch(error){$('loading').hidden=true;$('downloadPdf').disabled=true;$('error').textContent=error.message;$('close').onclick=()=>history.length>1?history.back():location.assign('/customer-payments.html')}
