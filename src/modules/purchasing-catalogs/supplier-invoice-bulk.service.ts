import {supplierInvoiceRpc} from './supplier-invoice-security.service.js';
import {invalidatePurchasingCatalogCache} from './purchasing-catalogs.module.js';
export async function importSupplierInvoices(auth:string,input:Record<string,unknown>){
 if(!input||!['VALIDATE','IMPORT'].includes(String(input.action))||!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>500||!Number.isSafeInteger(input.subsidiaryId)||Number(input.subsidiaryId)<=0||input.action==='IMPORT'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input.requestId)))throw Object.assign(Error('Archivo o lote inválido. Máximo 500 líneas y 100 facturas.'),{status:400});
 const result=await supplierInvoiceRpc<Record<string,unknown>>(auth,'import_supplier_invoices',{p_action:input.action,p_rows:input.rows,p_subsidiary_id:input.subsidiaryId,p_request_id:input.requestId||null},'create');
 if(input.action==='IMPORT'&&result.imported)invalidatePurchasingCatalogCache('supplier-invoices');return result;
}
