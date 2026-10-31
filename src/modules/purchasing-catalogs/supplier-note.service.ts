import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
type Action='view'|'create'|'edit'|'context';
export function supplierNoteResource(kind:string){if(!['CREDIT','DEBIT'].includes(kind))throw Object.assign(new Error('Tipo de nota inválido.'),{status:400});return `purchasing:supplier-${kind==='CREDIT'?'credit':'debit'}-notes`;}
export async function assertSupplierNoteAccess(a:string,kind:string,action:Action){
 if(!/^Bearer\s+\S+$/i.test(a))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 const resource=supplierNoteResource(kind),{assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 if(action!=='context')return assertRoleAccess(a,resource,action);
 for(const candidate of ['view','create','edit'] as const){try{await assertRoleAccess(a,resource,candidate);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}
 throw Object.assign(new Error('El rol activo no tiene acceso a este tipo de nota.'),{status:403});
}
export async function assertSupplierNoteLinesAccess(a:string){for(const kind of ['CREDIT','DEBIT']){try{await assertSupplierNoteAccess(a,kind,'view');return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}throw Object.assign(new Error('El rol activo no puede consultar notas de proveedor.'),{status:403});}
async function rpc(a:string,kind:string,action:Action,name:string,input:Record<string,unknown>){
 await assertSupplierNoteAccess(a,kind,action);const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok){const status=response.status===401?401:response.status===403||result?.code==='42501'?403:['55000','23503','23505'].includes(result?.code)?409:['22023','22P02','22003','22007','22008','23514','23502'].includes(result?.code)?400:500;throw Object.assign(new Error(status===401?'La sesión no es válida.':status===403?'El rol activo no puede realizar esta operación.':status===409?'La nota está protegida por su origen, saldo o historial.':status===400?'Revise los datos de la nota.':'No fue posible procesar la nota de proveedor.'),{status});}return result;
}
export const supplierNoteAccess=(a:string,kind:string)=>rpc(a,kind,'context','supplier_note_access',{p_kind:kind});
export const supplierNoteOptions=(a:string,kind:string)=>rpc(a,kind,'context','supplier_note_options',{p_kind:kind});
export const saveSupplierNote=(a:string,kind:string,payload:Record<string,unknown>,id:number|null=null)=>rpc(a,kind,id===null?'create':'edit','save_supplier_note',{p_kind:kind,p_payload:payload,p_target_id:id});
