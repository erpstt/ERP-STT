import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {invalidateSalesCatalogCache} from './sales-catalogs.module.js';

async function invoiceRpc(
  authorization:string,
  functionName:string,
  parameters:Record<string,unknown>,
  fallbackMessage:string
){
  const config=getSupabaseConfig();
  if(!config)throw Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${functionName}`,config.url),{
    method:'POST',
    headers:{
      apikey:config.anonKey,
      Authorization:authorization,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(parameters)
  });
  const raw=await response.text();
  const result=raw?JSON.parse(raw):null;
  if(!response.ok)throw Error(result?.message||fallbackMessage);
  return result;
}

export async function saveSalesInvoice(
  authorization:string,
  payload:Record<string,unknown>,
  id:number|null=null
){
  const result=await invoiceRpc(
    authorization,
    'save_sales_invoice',
    {payload,target_invoice_id:id},
    'No fue posible guardar la factura de venta.'
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
  if(!Number.isSafeInteger(invoiceId)||invoiceId<=0)throw Error('Factura de venta inválida.');
  if(typeof unifyLinesPdf!=='boolean')throw Error('Indique si desea unificar las líneas en el PDF.');
  const description=String(descriptionValue??'').trim();
  if(unifyLinesPdf&&!description)throw Error('Ingrese la descripción que aparecerá en las líneas del PDF unificado.');
  if(description.length>500)throw Error('La descripción del PDF no puede superar 500 caracteres.');
  const result=await invoiceRpc(
    authorization,
    'set_sales_invoice_pdf_presentation',
    {p_invoice_id:invoiceId,p_unify:unifyLinesPdf,p_description:description||'Bienes y servicios según detalle de la factura'},
    'No fue posible actualizar la presentación PDF de la factura.'
  );
  invalidateSalesCatalogCache('invoices');
  return result;
}
