import {supplierInvoiceRpc} from './supplier-invoice-security.service.js';
export function supplierInvoiceView(authorization:string,invoiceId:number){
 if(!Number.isSafeInteger(invoiceId)||invoiceId<=0)throw Object.assign(new Error('El identificador de la factura no es válido.'),{status:400});
 return supplierInvoiceRpc(authorization,'supplier_invoice_view_detail',{p_invoice_id:invoiceId},'view');
}
