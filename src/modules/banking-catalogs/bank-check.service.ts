import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {assertRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
type Action='view'|'create'|'edit'|'delete';
export async function bankCheckRpc(authorization:string,action:Action,name:string,input:Record<string,unknown>={}){
 if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 await assertRoleAccess(authorization,'banking:bank-checks',action);
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result:unknown=raw?JSON.parse(raw):null;
 if(!response.ok){
  const value=result as {code?:unknown;message?:unknown}|null;
  if(response.status===401)throw Object.assign(new Error('La sesión no es válida.'),{status:401});
  if(response.status===403||value?.code==='42501')throw Object.assign(new Error('No tiene permiso para operar este egreso bancario.'),{status:403});
  if(value?.code==='55000')throw Object.assign(new Error(typeof value.message==='string'?value.message:'El egreso no puede modificarse en su estado actual.'),{status:409});
  if(['22023','22P02'].includes(String(value?.code)))throw Object.assign(new Error('Revise los datos del cheque o transferencia.'),{status:400});
  throw Error('No fue posible procesar el cheque o transferencia.');
 }
 return result;
}
function checkId(id:number){if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Seleccione un egreso válido.'),{status:400});return {p_check_id:id};}
export const bankCheckOptions=(a:string)=>bankCheckRpc(a,'view','bank_check_options');
export const bankCheckReport=(a:string,p:Record<string,unknown>)=>bankCheckRpc(a,'view','bank_check_report',{p_filters:p});
export const bankCheckDetail=(a:string,id:number)=>bankCheckRpc(a,'view','bank_check_detail',checkId(id));
export const saveBankCheck=(a:string,p:Record<string,unknown>,id?:number)=>bankCheckRpc(a,id===undefined?'create':'edit','save_bank_check_transfer',{p_payload:p,p_check_id:id===undefined?null:checkId(id).p_check_id});
export const deleteBankCheck=(a:string,id:number)=>bankCheckRpc(a,'delete','delete_bank_check_transfer',checkId(id));
