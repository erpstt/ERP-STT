import{supplierInvoiceRpc}from'./supplier-invoice-security.service.js';
import{invalidatePurchasingCatalogCache}from'./purchasing-catalogs.module.js';
export const supplierInvoiceAccess=(a:string)=>supplierInvoiceRpc(a,'supplier_invoice_access',{},'context');
export function supplierInvoiceFormOptions(authorization:string,invoiceId:number|null=null){
 if(invoiceId!==null&&(!Number.isSafeInteger(invoiceId)||invoiceId<=0))throw Object.assign(new Error('El identificador de la factura no es válido.'),{status:400});
 return supplierInvoiceRpc(authorization,'supplier_invoice_form_options',{p_invoice_id:invoiceId},invoiceId===null?'create':'view');
}
export async function saveSupplierInvoice(authorization:string,payload:Record<string,unknown>,invoiceId:number|null=null){const result=await supplierInvoiceRpc(authorization,'save_supplier_invoice',{payload,target_invoice_id:invoiceId},invoiceId===null?'create':'edit');invalidatePurchasingCatalogCache('supplier-invoices');return result;}

export const supplierInvoiceReceiptSource=(a:string,id:number)=>supplierInvoiceRpc(a,'supplier_invoice_receipt_source',{p_receipt_id:id},'create');
