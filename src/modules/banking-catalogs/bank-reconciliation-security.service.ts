import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
export type ReconciliationAction='view'|'create'|'edit'|'delete';
export async function requireReconciliationAccess(auth:string,resource:string,action:ReconciliationAction){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 await assertRoleAccess(auth,resource,action);
}
export async function reconciliationRpc<T=unknown>(auth:string,name:string,input:Record<string,unknown>,resource:string,action:ReconciliationAction):Promise<T>{
 await requireReconciliationAccess(auth,resource,action);
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const r=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await r.text(),value=raw?JSON.parse(raw):null;
 if(!r.ok){
  if(r.status===401)throw Object.assign(new Error('La sesión no es válida.'),{status:401});
  if(r.status===403||value?.code==='42501')throw Object.assign(new Error('No tiene permiso para operar esta conciliación o extracto.'),{status:403});
  throw Object.assign(new Error(value?.code==='55000'?'La conciliación o el extracto está protegido por su estado o punteos existentes.':'Revise los datos de la conciliación o extracto.'),{status:value?.code==='55000'?409:422});
 }
 return value as T;
}
function id(value:number){if(!Number.isSafeInteger(value)||value<=0)throw Object.assign(new Error('Seleccione un extracto válido.'),{status:400});return value;}
export const saveBankStatementMetadata=(auth:string,payload:Record<string,unknown>,statementId?:number)=>reconciliationRpc<Record<string,unknown>>(auth,'save_bank_statement_metadata',{p_statement_id:statementId===undefined?null:id(statementId),p_payload:payload},'banking:bank-statements',statementId===undefined?'create':'edit');
export const deleteBankStatement=(auth:string,statementId:number)=>reconciliationRpc(auth,'delete_bank_statement',{p_statement_id:id(statementId)},'banking:bank-statements','delete');
