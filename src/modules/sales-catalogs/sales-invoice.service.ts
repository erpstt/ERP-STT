import{assertSalesInvoiceAccess,salesInvoiceRpc}from'./sales-invoice-security.service.js';
import {invalidateSalesCatalogCache} from './sales-catalogs.module.js';

export async function saveSalesInvoice(
  authorization:string,
  payload:Record<string,unknown>,
  id:number|null=null
){
  const result=await salesInvoiceRpc(
    authorization,
    'save_sales_invoice',
    {payload,target_invoice_id:id},
    id===null?'create':'edit'
  );
  invalidateSalesCatalogCache('invoices');
  return result;
}

export async function setSalesInvoicePdfLineUnification(
  authorization:string,
  invoiceId:number,
  unifyLinesPdf:unknown,
  descriptionValue:unknown
){
  await assertSalesInvoiceAccess(authorization,'edit');
  if(!Number.isSafeInteger(invoiceId)||invoiceId<=0)throw Error('Factura de venta inválida.');
  if(typeof unifyLinesPdf!=='boolean')throw Error('Indique si desea unificar las líneas en el PDF.');
  const description=String(descriptionValue??'').trim();
  if(unifyLinesPdf&&!description)throw Error('Ingrese la descripción que aparecerá en las líneas del PDF unificado.');
  if(description.length>500)throw Error('La descripción del PDF no puede superar 500 caracteres.');
  const result=await salesInvoiceRpc(
    authorization,
    'set_sales_invoice_pdf_presentation',
    {p_invoice_id:invoiceId,p_unify:unifyLinesPdf,p_description:description||'Bienes y servicios según detalle de la factura'},
    'edit'
  );
  invalidateSalesCatalogCache('invoices');
  return result;
}
