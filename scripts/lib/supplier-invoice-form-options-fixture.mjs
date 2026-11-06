// Synthetic test adapter only. No backend, environment, database or HTTP access.
export const supplierInvoiceFormOptionPaths=Object.freeze({accounts:'/api/accounting/chart-accounts',accountGroups:'/api/accounting/account-groups',taxes:'/api/configuration/tax-codes',taxTypes:'/api/configuration/tax-types',departments:'/api/organization/departments',classes:'/api/organization/classes',costs:'/api/organization/cost-centers',creditors:'/api/organization/financial-creditors',related:'/api/organization/related-companies',customers:'/api/entities/customers',suppliers:'/api/entities/suppliers',paymentTerms:'/api/configuration/payment-terms',periods:'/api/organization/accounting-periods',currencies:'/api/core/currencies',rates:'/api/configuration/exchange-rates',countries:'/api/core/countries',subsidiaries:'/api/organization/subsidiaries',locations:'/api/organization/locations',invoices:'/api/purchasing/supplier-invoices',invoiceLines:'/api/purchasing/supplier-invoice-lines'});

export function buildSupplierInvoiceFormOptions(catalogs,{subsidiaryId=1,invoiceId=null}={}){
 const id=value=>{if(!/^[1-9][0-9]*$/.test(String(value))||!Number.isSafeInteger(Number(value)))throw Error('Invalid synthetic fixture ID');return Number(value);};
 const sid=id(subsidiaryId),selected=invoiceId===null?null:id(invoiceId);
 const data=Object.fromEntries(Object.entries(supplierInvoiceFormOptionPaths).map(([key,path])=>[key,structuredClone(catalogs[path]??[])]));
 if(selected===null){data.invoices=[];data.invoiceLines=[];}
 else{
  if(Array.isArray(data.invoices))data.invoices=data.invoices.filter(row=>String(row.invoice_id)===String(selected)).map(row=>row.subsidiary_id===undefined?{...row,subsidiary_id:sid}:row);
  if(Array.isArray(data.invoiceLines))data.invoiceLines=data.invoiceLines.filter(row=>String(row.invoice_id)===String(selected));
 }
 return{...data,context:{subsidiaryId:sid,invoiceId:selected}};
}
