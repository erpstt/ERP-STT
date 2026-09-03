import { getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc<T>(authorization:string,name:string,input:Record<string,unknown>={}){
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const raw=await response.text(),payload:unknown=raw?JSON.parse(raw):null;
  if(!response.ok)throw new Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):'No fue posible procesar la transferencia.');
  return payload as T;
}
export const bankTransferOptions=(authorization:string)=>rpc(authorization,'bank_transfer_options');
export const createBankTransfer=(authorization:string,payload:Record<string,unknown>)=>rpc(authorization,'create_bank_transfer',{p_payload:payload});
export const runBankTransferReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'run_bank_transfer_report',{p_filters:filters});
export const bankTransferJournal=(authorization:string,transferId:number)=>rpc(authorization,'bank_transfer_journal',{p_transfer_id:transferId});
