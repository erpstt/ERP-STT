import {getSupabaseConfig} from '../../core/database/supabase.client.js';
const actions:Record<string,string>={options:'pr_options',invoices:'pr_invoices',report:'pr_report',detail:'pr_detail',save:'pr_save',transition:'pr_transition',execute:'pr_execute'};
export async function paymentRequests(auth:string,action:string,payload:Record<string,unknown>={}){
 const c=getSupabaseConfig(),name=actions[action];if(!c||!name)throw Error('Solicitud no valida.');
 const r=await fetch(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(action==='options'?{}:{p:payload})});
 const result=await r.json();if(!r.ok)throw Error(result?.message||'No fue posible procesar la solicitud.');return result;
}
