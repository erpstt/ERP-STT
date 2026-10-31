import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { assertRoleAccess } from '../security-catalogs/role-access-matrix.module.js';
export async function assertJournalAccess(authorization:string,action:'view'|'create'|'edit'){
 if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 await assertRoleAccess(authorization,'accounting:journals',action);
}
export function journalRpcFailure(status:number,result:unknown):Error{
 const value=result as {code?:unknown;message?:unknown}|null;
 if(status===401)return Object.assign(new Error('La sesión no es válida.'),{status:401});
 if(status===403||value?.code==='42501')return Object.assign(new Error('No tiene permiso para realizar esta operación contable.'),{status:403});
 return new Error(typeof value?.message==='string'?value.message:'No fue posible guardar el asiento.');
}
async function call(authorization:string,functionName:string,body:Record<string,unknown>){
 const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${functionName}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const raw=await response.text();const result:unknown=raw?JSON.parse(raw):null;
 if(!response.ok)throw journalRpcFailure(response.status,result);
 return{journalId:Number(result)};
}
export const createJournalEntry=async(authorization:string,payload:Record<string,unknown>)=>{await assertJournalAccess(authorization,'create');return call(authorization,'create_journal_entry',{payload});};
export const updateJournalEntry=async(authorization:string,journalId:number,payload:Record<string,unknown>)=>{
 await assertJournalAccess(authorization,'edit');
 if(!Number.isSafeInteger(journalId)||journalId<=0)throw Object.assign(new Error('Seleccione un asiento válido.'),{status:400});
 return call(authorization,'update_journal_entry',{target_journal_id:journalId,payload});
};
export async function reverseManualJournal(authorization:string,journalId:number){
 await assertJournalAccess(authorization,'edit');
 if(!Number.isSafeInteger(journalId)||journalId<=0)throw Object.assign(new Error('Seleccione un asiento válido.'),{status:400});
 return (await call(authorization,'reverse_journal_entry',{target_journal_id:journalId})).journalId;
}
