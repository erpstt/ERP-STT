import{supplierInvoiceRpc}from'./supplier-invoice-security.service.js';
import{invalidatePurchasingCatalogCache}from'./purchasing-catalogs.module.js';
export const supplierInvoiceAccess=(a:string)=>supplierInvoiceRpc(a,'supplier_invoice_access',{},'context');
export async function saveSupplierInvoice(authorization:string,payload:Record<string,unknown>,invoiceId:number|null=null){const result=await supplierInvoiceRpc(authorization,'save_supplier_invoice',{payload,target_invoice_id:invoiceId},invoiceId===null?'create':'edit');invalidatePurchasingCatalogCache('supplier-invoices');return result;}
