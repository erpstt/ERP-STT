import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {assertRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
type Action='view'|'create'|'edit'|'delete';
export async function bankFeeRpc(authorization:string,action:Action,name:string,input:Record<string,unknown>={}){
 if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 await assertRoleAccess(authorization,'banking:bank-fees',action);
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result:unknown=raw?JSON.parse(raw):null;
 if(!response.ok){
  const value=result as {code?:unknown;message?:unknown}|null;
  if(response.status===401)throw Object.assign(new Error('La sesión no es válida.'),{status:401});
  if(response.status===403||value?.code==='42501')throw Object.assign(new Error('No tiene permiso para operar este comisión bancaria.'),{status:403});
  if(value?.code==='55000')throw Object.assign(new Error(typeof value.message==='string'?value.message:'El egreso no puede modificarse en su estado actual.'),{status:409});
  if(['22023','22P02'].includes(String(value?.code)))throw Object.assign(new Error('Revise los datos del comisión bancaria.'),{status:400});
  throw Error('No fue posible procesar el comisión bancaria.');
 }
 return result;
}
function feeId(id:number){if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Seleccione una comisión válida.'),{status:400});return {p_fee_id:id};}
export const bankFeeOptions=(a:string)=>bankFeeRpc(a,'view','bank_fee_options');
export const saveBankFee=(a:string,p:Record<string,unknown>)=>bankFeeRpc(a,'create','save_bank_fee',{p_payload:p});
export const importBankFees=(a:string,p:Record<string,unknown>)=>bankFeeRpc(a,'create','import_bank_fees',{p_payload:p});
export const bankFeeReport=(a:string,p:Record<string,unknown>)=>bankFeeRpc(a,'view','bank_fee_report',{p_filters:p});
export const bankFeeDetail=(a:string,id:number)=>bankFeeRpc(a,'view','bank_fee_detail',feeId(id));
export const updateBankFee=(a:string,id:number,p:Record<string,unknown>)=>bankFeeRpc(a,'edit','update_bank_fee',{...feeId(id),p_payload:p});
export const deleteBankFee=(a:string,id:number)=>bankFeeRpc(a,'delete','delete_bank_fee',feeId(id));
export const registerStatementBankFees=(a:string,p:Record<string,unknown>)=>bankFeeRpc(a,'create','register_bank_statement_fees',p);
