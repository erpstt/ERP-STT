const params=new URLSearchParams(location.search),receiptId=params.get('receiptId')||sessionStorage.getItem('nexo_supplier_invoice_receipt_id');
if(receiptId&&!params.get('id')){
 const $=id=>document.getElementById(id),token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token'),device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token');
 const request=async path=>{const response=await fetch(path,{headers:{Authorization:`Bearer ${token}`,'X-Device-Token':device||''}}),payload=await response.json();if(!response.ok)throw Error(payload?.error?.message||payload?.message||'No fue posible cargar la recepción.');return payload};
 try{
  const cached=sessionStorage.getItem('nexo_supplier_invoice_receipt');
  const [receipt,accounts]=await Promise.all([cached?Promise.resolve(JSON.parse(cached)):request(`/api/purchasing/workflow/${receiptId}`),request('/api/accounting/chart-accounts')]);
  const header=receipt.header;
  if(!header||header.document_type!=='RECEIPT')throw Error('La recepción indicada no es válida.');
  $('invoiceNumber').value='';
  const reference=document.querySelector('.receipt-reference');if(reference)reference.hidden=false;
  if($('receiptReference'))$('receiptReference').value=header.document_number||'';
  if($('receiptDocumentId'))$('receiptDocumentId').value=String(header.document_id||receiptId);
  $('supplier').value=String(header.supplier_id||'');$('supplier').dispatchEvent(new Event('change'));
  if(header.payment_term_id)$('paymentTerm').value=String(header.payment_term_id);
  $('invoiceDate').value=String(header.document_date||'').slice(0,10);$('invoiceDate').dispatchEvent(new Event('change'));
  $('period').value=String(header.fiscal_period_id||'');
  $('currency').value=String(header.currency_id||'');$('currency').dispatchEvent(new Event('change'));
  $('rate').value=header.exchange_rate||1;
  $('memo').value=`Factura derivada de ${header.document_number}${header.memo?` · ${header.memo}`:''}`;$('memo').dispatchEvent(new Event('input'));
  $('lines').innerHTML='';
  for(const item of receipt.lines||[]){
   $('addLine').click();const row=$('lines').lastElementChild;if(!row)throw Error('No se pudo crear la línea de factura.');
   const account=accounts.find(value=>String(value.account_id)===String(item.account_id)),search=row.querySelector('.account-search');
   if(account&&search){search.value=`${account.account_number} - ${account.account_name}`;search.dispatchEvent(new Event('input'));search.dispatchEvent(new Event('change'))}
   const amount=row.querySelector('[data-key=amount]');amount.value=String(Number(item.quantity)*Number(item.unit_cost));amount.dispatchEvent(new Event('input'));amount.dispatchEvent(new Event('blur'));
   const tax=row.querySelector('[data-key=tax_code_id]');tax.value=item.tax_code_id??'';tax.dispatchEvent(new Event('change'));
   const note=row.querySelector('[data-key=note]');note.value=item.description||header.memo||'';note.dispatchEvent(new Event('input'));
   const department=row.querySelector('[data-key=department_id]');department.value=item.department_id??'';department.dispatchEvent(new Event('change'));
   const cost=row.querySelector('[data-key=cost_center_id]');cost.value=item.cost_center_id??'';cost.dispatchEvent(new Event('change'));
   for(const key of['financial_creditor_id','related_company_id']){const field=row.querySelector(`[data-key=${key}]`);if(field)field.value=item[key]??''}
  }
  document.querySelector('h1').textContent=`Nueva factura desde ${header.document_number}`;
  const returnTo=()=>location.assign('/purchase-documents.html?type=RECEIPT');document.querySelector('main>header a').onclick=event=>{event.preventDefault();returnTo()};$('cancel').onclick=event=>{event.preventDefault();returnTo()};setTimeout(()=>{if($('invoiceNumber').value===header.document_number)$('invoiceNumber').value='';$('invoiceNumber').focus();if(reference)reference.hidden=false},800);
  sessionStorage.removeItem('nexo_supplier_invoice_receipt');sessionStorage.removeItem('nexo_supplier_invoice_receipt_id');
 }catch(error){const target=$('error');if(target)target.textContent=`No fue posible completar la factura desde la recepción: ${error.message}`;console.error(error)}
}
