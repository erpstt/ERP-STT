import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
type Action='view'|'create'|'edit'|'delete'|'context';
const resources:Record<string,string>={ORDER:'purchasing:orders',QUOTE:'purchasing:quotes',REQUISITION:'purchasing:requisitions',RECEIPT:'purchasing:goods-receipts'};
export async function assertPurchaseDocumentAccess(auth:string,action:Action,kind?:string){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesi\u00f3n.'),{status:401});
 if(kind!==undefined&&!resources[kind])throw Object.assign(new Error('Tipo de compra inv\u00e1lido.'),{status:400});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 for(const resource of kind?[resources[kind]]:Object.values(resources))for(const a of action==='context'?['view','create','edit'] as const:[action] as const){try{await assertRoleAccess(auth,resource,a);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}
 throw Object.assign(new Error('El rol activo no puede realizar esta acci\u00f3n en Compras.'),{status:403});
}
async function rpc(a:string,n:string,i:Record<string,unknown>,action:Action,kind?:string){
 await assertPurchaseDocumentAccess(a,action,kind);const c=getSupabaseConfig();if(!c)throw Error('Supabase no est\u00e1 configurado.');
 const r=await fetchSupabase(new URL(`/rest/v1/rpc/${n}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(i)}),t=await r.text(),x=t?JSON.parse(t):null;
 if(!r.ok){const status=r.status===401?401:r.status===403||x?.code==='42501'?403:['55000','23503','23505','P0001','PT422'].includes(x?.code)?409:['22023','22P02','22003','22007','22008','23514','23502'].includes(x?.code)?400:500;throw Object.assign(Error(status===403?'El rol activo no puede realizar esta operaci\u00f3n.':status===409?'El documento est\u00e1 protegido por su estado, origen o historial.':status===400?'Revise los datos del documento.':'No fue posible procesar el documento de compra.'),{status});}return x;
}
export const purchaseDocumentAccess=(a:string,kind:string)=>rpc(a,'purchase_document_access',{p_type:kind},'context',kind);
export const purchaseWorkflowOptions=(a:string)=>rpc(a,'purchase_workflow_options',{},'context');
export const purchaseDocuments=(a:string,p:Record<string,unknown>)=>rpc(a,'purchase_document_report',{p_filters:p},'view',String(p.type||''));
export const purchaseDocumentDetail=(a:string,id:number)=>rpc(a,'purchase_document_detail',{p_document_id:id},'view');
export const purchaseDocumentSource=(a:string,id:number,kind:string)=>rpc(a,'purchase_document_source',{p_document_id:id,p_type:kind},'context',kind);
export const savePurchaseDocument=(a:string,p:Record<string,unknown>,id?:number)=>rpc(a,'save_purchase_document',{p_payload:p,p_document_id:id??null},id===undefined?'create':'edit',String(p.type||''));
export const deletePurchaseDocument=(a:string,id:number)=>rpc(a,'delete_purchase_document',{p_document_id:id},'delete');
