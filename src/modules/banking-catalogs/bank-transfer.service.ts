import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { assertRoleAccess } from '../security-catalogs/role-access-matrix.module.js';

async function rpc<T>(authorization:string,action:'view'|'create',name:string,input:Record<string,unknown>={}){
  if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
  await assertRoleAccess(authorization,'banking:bank-transfers',action);
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok){
    const code=typeof payload==='object'&&payload&&'code'in payload?payload.code:null;
    if(response.status===401)throw Object.assign(new Error('La sesión no es válida.'),{status:401});
    if(response.status===403||code==='42501')throw Object.assign(new Error('No tiene permiso para realizar esta operación bancaria.'),{status:403});
    if(code==='55000')throw Object.assign(new Error('La transferencia no puede realizarse en su estado actual.'),{status:409});
    if(code==='22023'||code==='22P02')throw Object.assign(new Error('Revise los datos de la transferencia bancaria.'),{status:400});
    throw new Error('No fue posible procesar la transferencia.');
  }
  return payload as T;
}
export const bankTransferOptions=(authorization:string)=>rpc(authorization,'view','bank_transfer_options');
export const createBankTransfer=(authorization:string,payload:Record<string,unknown>)=>rpc(authorization,'create','create_bank_transfer',{p_payload:payload});
export const runBankTransferReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'view','run_bank_transfer_report',{p_filters:filters});
export const bankTransferJournal=(authorization:string,transferId:number)=>{
  if(!Number.isSafeInteger(transferId)||transferId<=0)throw Object.assign(new Error('Seleccione una transferencia válida.'),{status:400});
  return rpc(authorization,'view','bank_transfer_journal',{p_transfer_id:transferId});
};
