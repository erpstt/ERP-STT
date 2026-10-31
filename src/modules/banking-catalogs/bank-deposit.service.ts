import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {assertRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
type Action='view'|'create'|'edit'|'delete';
async function rpc(authorization:string,action:Action,name:string,input:Record<string,unknown>={}){
 if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 await assertRoleAccess(authorization,'banking:bank-deposits',action);
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result:unknown=raw?JSON.parse(raw):null;
 if(!response.ok){
  const value=result as {code?:unknown;message?:unknown}|null;
  if(response.status===401)throw Object.assign(new Error('La sesión no es válida.'),{status:401});
  if(response.status===403||value?.code==='42501')throw Object.assign(new Error('No tiene permiso para realizar esta operación de depósitos.'),{status:403});
  throw Error(typeof value?.message==='string'?value.message:'No fue posible procesar el depósito.');
 }
 return result;
}
function depositId(id:number){
 if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Seleccione un depósito válido.'),{status:400});
 return {p_deposit_id:id};
}
export const bankDepositOptions=(auth:string)=>rpc(auth,'view','bank_deposit_options');
export const listBankDeposits=(auth:string,filters:Record<string,unknown>)=>rpc(auth,'view','bank_deposit_report',{p_filters:filters});
export const bankDepositDetail=(auth:string,id:number)=>rpc(auth,'view','bank_deposit_detail',depositId(id));
export const saveBankDeposit=(auth:string,payload:Record<string,unknown>)=>rpc(auth,'create','save_bank_deposit',{p_payload:payload});
export const updateBankDeposit=(auth:string,id:number,payload:Record<string,unknown>)=>rpc(auth,'edit','update_bank_deposit',{...depositId(id),p_payload:payload});
export const deleteBankDeposit=(auth:string,id:number)=>rpc(auth,'delete','delete_bank_deposit',depositId(id));
