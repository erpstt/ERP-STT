const $=id=>document.getElementById(id);
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=localStorage.getItem('nexo_device_token');
const invoiceId=new URLSearchParams(window.location.search).get('id');
const escapeHtml=value=>String(value??'—').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const requestHeaders=withBody=>({Authorization:`Bearer ${token}`,'X-Device-Token':device,...(withBody?{'Content-Type':'application/json'}:{})});

async function api(path,init={}){
  const response=await fetch(path,{...init,headers:{...requestHeaders(Boolean(init.body)),...(init.headers||{})}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(payload.error?.message||payload.error||'No fue posible completar la operación.');
  return payload;
}

const find=(rows,key,value)=>rows.find(row=>String(row[key])===String(value));
const formatDate=value=>value?new Intl.DateTimeFormat('es-CR',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${String(value).slice(0,10)}T12:00:00Z`)):'—';
const safeName=value=>String(value||'factura.pdf').replace(/[\\/:*?"<>|\r\n]/g,'-');

function showAction(message,type='success'){
  const box=$('actionMessage');
  box.textContent=message;
  box.className=`action-message ${type}`;
  box.hidden=false;
  clearTimeout(showAction.timer);
  showAction.timer=setTimeout(()=>{box.hidden=true},6500);
}

function filenameFrom(response,fallback){
  const disposition=response.headers.get('content-disposition')||'';
  const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain=/filename="?([^";]+)"?/i.exec(disposition)?.[1];
  try{return safeName(encoded?decodeURIComponent(encoded):plain||fallback)}catch{return safeName(fallback)}
}

function downloadBlob(blob,fileName){
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=fileName;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

async function downloadInvoicePdf(invoiceNumber){
  const button=$('print'),label=button.textContent;
  try{
    button.disabled=true;button.textContent='Generando PDF…';
    const response=await fetch(`/api/sales/invoices/${encodeURIComponent(invoiceId)}/pdf`,{headers:requestHeaders(false)});
    if(!response.ok){const failure=await response.json().catch(()=>({}));throw Error(failure.error?.message||failure.error||'No fue posible generar el PDF de la factura.');}
    const type=response.headers.get('content-type')||'';
    if(type.includes('application/json')){
      const file=await response.json();
      if(!file.base64)throw Error('El servidor no devolvió un PDF válido.');
      const bytes=Uint8Array.from(atob(file.base64),char=>char.charCodeAt(0));
      downloadBlob(new Blob([bytes],{type:file.mimeType||'application/pdf'}),safeName(file.fileName||`factura-${invoiceNumber}.pdf`));
    }else{
      const blob=await response.blob();
      if(!blob.size)throw Error('El PDF generado está vacío.');
      downloadBlob(blob,filenameFrom(response,`factura-${invoiceNumber}.pdf`));
    }
    showAction('El PDF se descargó correctamente.');
  }catch(error){showAction(error.message,'error')}
  finally{button.disabled=false;button.textContent=label}
}

function supportUrl(item){
  const value=item.support_type==='Archivo'?item.file_data:item.support_url;
  if(item.support_type==='Archivo'&&String(value||'').startsWith('data:'))return value;
  try{const url=new URL(String(value||''));return ['http:','https:'].includes(url.protocol)?url.href:''}catch{return''}
}

function renderSupports(items){
  const list=$('viewSupports');
  list.innerHTML='';
  $('viewSupportCount').textContent=String(items.length);
  $('invoiceSupportsCard').hidden=false;
  if(!items.length){const empty=document.createElement('div');empty.className='invoice-support-empty';empty.innerHTML='<strong>Esta factura no tiene respaldos.</strong><span>Puede agregarlos desde la opción Editar.</span>';list.append(empty);return}
  for(const item of items){
    const row=document.createElement('a'),icon=document.createElement('span'),copy=document.createElement('span'),title=document.createElement('strong'),detail=document.createElement('small');
    row.className='invoice-support';row.target='_blank';row.rel='noopener';row.href=supportUrl(item)||'#';
    icon.className='invoice-support-icon';icon.textContent=item.support_type==='Archivo'?'DOC':'URL';
    title.textContent=item.display_name||item.file_name||'Respaldo';
    detail.textContent=item.support_type==='Archivo'?(item.file_name||'Archivo adjunto'):(item.support_url||'Enlace externo');
    copy.append(title,detail);row.append(icon,copy);list.append(row);
  }
}

try{
  if(!token)throw Error('Debe iniciar sesión para consultar la factura.');
  if(!invoiceId)throw Error('No se recibió el identificador de la factura.');
  const paths=['/api/sales/invoices','/api/sales/sales-invoice-lines','/api/sales/sales-invoice-withholdings','/api/entities/customers','/api/inventory/products','/api/configuration/tax-codes','/api/configuration/payment-terms','/api/core/currencies','/api/core/countries','/api/organization/subsidiaries','/api/accounting/journal-supports'];
  const [invoices,invoiceLines,withholdings,customers,products,taxes,terms,currencies,countries,subsidiaries,supports]=await Promise.all(paths.map(path=>api(path)));
  const invoice=find(invoices,'invoice_id',invoiceId);
  if(!invoice)throw Error('No se encontró la factura en la subsidiaria activa.');
  const customer=find(customers,'customer_id',invoice.customer_id)||{};
  const subsidiary=find(subsidiaries,'subsidiary_id',invoice.subsidiary_id)||{};
  const currency=find(currencies,'currency_id',invoice.currency_id)||{};
  const term=find(terms,'term_id',invoice.payment_term_id)||{};
  const lines=invoiceLines.filter(line=>String(line.invoice_id)===String(invoiceId));
  const invoiceSupports=supports.filter(item=>String(item.journal_id)===String(invoice.journal_id));
  const symbol=currency.symbol||currency.currency_code||'';
  const money=value=>`${symbol} ${Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

  $('companyName').textContent=subsidiary.name||'Subsidiaria';
  $('companyAddress').textContent=subsidiary.address||'';
  $('footerCompany').textContent=subsidiary.name||'';
  if(subsidiary.logo_url){$('logo').src=subsidiary.logo_url;$('logo').hidden=false}
  $('invoiceNumber').textContent=invoice.invoice_number;
  $('customerName').textContent=customer.company_name||customer.name||'Cliente';
  $('customerTax').textContent=customer.tax_id?`Identificación fiscal: ${customer.tax_id}`:(customer.tax_identification?`Identificación fiscal: ${customer.tax_identification}`:'');
  $('customerAddress').textContent=customer.address||'';
  $('customerContact').textContent=[customer.email,customer.phone].filter(Boolean).join(' · ');
  $('issueDate').textContent=formatDate(invoice.invoice_date);
  $('dueDate').textContent=formatDate(invoice.due_date);
  $('paymentTerm').textContent=term.term_name||'—';
  $('currency').textContent=`${currency.currency_code||''} - ${currency.name||''}`;
  $('memo').textContent=invoice.memo||'—';

  let subtotal=0,taxTotal=0;
  const taxGroups=new Map();
  $('lines').innerHTML=lines.map(line=>{
    const product=find(products,'product_id',line.product_id)||{},country=find(countries,'country_id',line.service_country_id),tax=find(taxes,'tax_code_id',line.tax_code_id),lineTax=Number(line.tax_amount||0),rate=Number(line.tax_rate||0);
    subtotal+=Number(line.amount||0);taxTotal+=lineTax;
    if(tax&&lineTax){const key=String(rate),group=taxGroups.get(key)||{rate,base:0,tax:0};group.base+=Number(line.amount||0);group.tax+=lineTax;taxGroups.set(key,group)}
    return `<tr><td><strong>${escapeHtml(product.display_name||'Producto')}</strong>${line.note?`<span class="product-code">${escapeHtml(line.note)}</span>`:''}</td><td class="service-country">${escapeHtml(country?.name)}</td><td class="number">${Number(line.quantity||0).toLocaleString('es-CR',{maximumFractionDigits:6})}</td><td class="number">${money(line.unit_price)}</td><td class="number">${money(line.amount)}</td><td class="number">${lineTax?money(lineTax):'—'}</td><td class="number"><strong>${money(line.gross_amount)}</strong></td></tr>`;
  }).join('')||'<tr><td colspan="7">La factura no contiene líneas.</td></tr>';
  $('taxBreakdown').innerHTML=taxGroups.size?[...taxGroups.values()].map(group=>`<div class="tax-row"><span>Base: ${money(group.base)}<br><small>Tasa: ${group.rate.toLocaleString('es-CR')}%</small></span><strong><small>Valor</small><br>${money(group.tax)}</strong></div>`).join(''):'<span class="tax-empty">Factura sin impuestos.</span>';
  const invoiceWithholdings=withholdings.filter(row=>String(row.invoice_id)===String(invoiceId));
  const withholdingTotal=invoiceWithholdings.reduce((sum,row)=>sum+Number(row.withholding_amount||0),0);
  $('withholdingBreakdown').innerHTML=invoiceWithholdings.length?invoiceWithholdings.map(row=>{const tax=find(taxes,'tax_code_id',row.tax_code_id)||{};return `<div class="tax-row"><span><b>${escapeHtml(tax.code_name||'Retención')}</b><br><small>${escapeHtml(row.calculation_base)} · ${Number(row.rate_percentage||0).toLocaleString('es-CR')}% · ${escapeHtml(row.application_moment)}</small></span><strong>${money(row.withholding_amount)}</strong></div>`}).join(''):'<span class="tax-empty">Factura sin retenciones.</span>';
  $('subtotal').textContent=money(subtotal);$('taxTotal').textContent=money(taxTotal);$('withholdingTotal').textContent=money(withholdingTotal);$('total').textContent=money(invoice.total_amount);$('receivableTotal').textContent=money(invoice.receivable_amount||invoice.total_amount);
  document.title=`Factura ${invoice.invoice_number}`;
  $('invoice').hidden=false;
  renderSupports(invoiceSupports);

  $('edit').href=`/sales-invoice-entry.html?id=${encodeURIComponent(invoiceId)}`;
  $('back').onclick=()=>history.length>1?history.back():window.location.assign('/');
  $('print').onclick=()=>downloadInvoicePdf(invoice.invoice_number);

  const validEmail=/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(customer.email||''));
  const fileCount=invoiceSupports.filter(item=>item.support_type==='Archivo').length,linkCount=invoiceSupports.filter(item=>item.support_type==='Enlace').length;
  $('emailCustomer').textContent=customer.company_name||customer.name||'el cliente';
  $('emailRecipient').textContent=validEmail?customer.email:'No hay un correo válido registrado';
  $('emailAttachmentSummary').textContent=`PDF de la factura${fileCount?` + ${fileCount} archivo${fileCount===1?'':'s'} de respaldo`:''}${linkCount?` · ${linkCount} enlace${linkCount===1?'':'s'} en el mensaje`:''}`;
  $('sendEmail').onclick=()=>{
    $('emailDialogError').textContent=validEmail?'':'Registre un correo electrónico válido en el cliente antes de realizar el envío.';
    $('confirmEmail').disabled=!validEmail;
    $('emailDialog').showModal();
  };
  $('confirmEmail').onclick=async()=>{
    const button=$('confirmEmail'),label=button.textContent;
    try{
      button.disabled=true;button.textContent='Enviando…';$('emailDialogError').textContent='';
      const result=await api(`/api/sales/invoices/${encodeURIComponent(invoiceId)}/email`,{method:'POST',body:'{}'});
      $('emailDialog').close();
      showAction(`Factura enviada correctamente a ${result.recipient||customer.email}.`);
    }catch(error){$('emailDialogError').textContent=error.message}
    finally{button.disabled=!validEmail;button.textContent=label}
  };
}catch(error){$('error').textContent=error.message}
