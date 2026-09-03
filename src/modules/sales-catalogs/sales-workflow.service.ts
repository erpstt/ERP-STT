import{getSupabaseConfig}from'../../core/database/supabase.client.js';
async function rpc(a:string,n:string,i:Record<string,unknown>={}){const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');const r=await fetch(new URL(`/rest/v1/rpc/${n}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(i)}),t=await r.text(),x=t?JSON.parse(t):null;if(!r.ok)throw Error(x?.message||'No fue posible procesar el documento de venta.');return x}
export const salesWorkflowOptions=(a:string)=>rpc(a,'sales_workflow_options');
export const salesDocuments=(a:string,p:Record<string,unknown>)=>rpc(a,'sales_document_report',{p_filters:p});
export const salesDocumentDetail=(a:string,id:number)=>rpc(a,'sales_document_detail',{p_document_id:id});
export const saveSalesDocument=(a:string,p:Record<string,unknown>,id?:number)=>rpc(a,'save_sales_document',{p_payload:p,p_document_id:id||null});
export const deleteSalesDocument=(a:string,id:number)=>rpc(a,'delete_sales_document',{p_document_id:id});
