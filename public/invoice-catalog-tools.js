export const emptyInvoiceFilters=()=>({from:'',to:'',entity:'',number:''});
export function invoiceFilterError(filters){return filters.from&&filters.to&&filters.from>filters.to?'La fecha desde debe ser anterior o igual a la fecha hasta.':'';}
export function filterInvoiceRows(rows,filters,supplier=false){
 if(invoiceFilterError(filters))return[];
 const term=String(filters.number||'').trim().toLocaleLowerCase('es');
 return rows.filter(row=>{const date=String(row.invoice_date||'').slice(0,10);return(!filters.from||date&&date>=filters.from)&&(!filters.to||date&&date<=filters.to)&&(!filters.entity||String(row[supplier?'supplier_id':'customer_id'])===String(filters.entity))&&(!term||String(row.invoice_number||'').toLocaleLowerCase('es').includes(term));});
}
export function invoiceEntityOptions(rows,supplier,label){
 const key=supplier?'supplier_id':'customer_id';
 return [...new Set(rows.map(r=>r[key]).filter(v=>v!=null).map(String))].map(id=>({id,label:label(id)})).sort((a,b)=>a.label.localeCompare(b.label,'es',{numeric:true,sensitivity:'base'}));
}
export function invoiceExportRows(rows,fields,display){
 return rows.map(row=>fields.map(field=>{const value=row[field.key];if(!field.reference&&field.type==='number'&&value!=null&&value!==''&&Number.isFinite(Number(value)))return Number(value);return String(display(field,value)??'');}));
}
