import { getSupabaseConfig } from '../../core/database/supabase.client.js';
const functions: Record<string,string> = { options:'fx_options', settings:'fx_save_settings', preview:'fx_prepare', execute:'fx_execute', cancel:'fx_cancel', report:'fx_report' };
export async function fxRevaluation(authorization:string,action:string,payload:Record<string,unknown>={}) {
  const name=functions[action];
  if(!name)throw Error('Acción de revaluación no válida.');
  const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(action==='options'?{}:{p_payload:payload})});
  const result=await response.json() as Record<string,unknown>;
  if(!response.ok)throw Error(String(result.message||'No fue posible completar la revaluación.'));
  return result;
}
