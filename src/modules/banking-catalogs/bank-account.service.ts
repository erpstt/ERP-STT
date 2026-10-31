import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';

type Action='create'|'edit'|'delete';
async function mutate(auth:string,action:Action,name:string,input:Record<string,unknown>){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 // The access matrix builds its resource list from the banking catalog.
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 await assertRoleAccess(auth,'banking:bank-accounts',action);
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result:unknown=raw?JSON.parse(raw):null;
 if(!response.ok){
  const value=result as {code?:unknown;message?:unknown}|null;
  if(response.status===401)throw Object.assign(new Error('La sesión no es válida.'),{status:401});
  if(response.status===403||value?.code==='42501')throw Object.assign(new Error('No tiene permiso para administrar esta cuenta bancaria.'),{status:403});
  if(value?.code==='55000')throw Object.assign(new Error(typeof value.message==='string'?value.message:'La cuenta tiene movimientos o saldo.'),{status:409});
  if(['22023','22P02'].includes(String(value?.code)))throw Object.assign(new Error('Revise los datos de la cuenta. El saldo se modifica mediante procesos contables.'),{status:400});
  throw Error('No fue posible administrar la cuenta bancaria.');
 }
 return result as Record<string,unknown>;
}
function accountId(id:number){if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Seleccione una cuenta válida.'),{status:400});return {p_bank_account_id:id};}
export const createBankAccount=(auth:string,payload:Record<string,unknown>)=>mutate(auth,'create','create_bank_account',{p_payload:payload});
export const updateBankAccount=(auth:string,id:number,payload:Record<string,unknown>)=>mutate(auth,'edit','update_bank_account',{...accountId(id),p_payload:payload});
export const deleteBankAccount=(auth:string,id:number)=>mutate(auth,'delete','delete_bank_account',accountId(id));
