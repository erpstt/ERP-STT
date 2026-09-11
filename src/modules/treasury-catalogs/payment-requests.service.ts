import {getSupabaseConfig} from '../../core/database/supabase.client.js';
const actions:Record<string,string>={options:'pr_options',invoices:'pr_invoices',report:'pr_report',detail:'pr_detail',save:'pr_save',transition:'pr_transition',execute:'pr_execute'};
async function rpc(auth:string,name:string,parameters:Record<string,unknown>={}){const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');const r=await fetch(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(parameters)}),raw=await r.text(),result=raw?JSON.parse(raw):null;if(!r.ok)throw Error(result?.message||'No fue posible procesar la solicitud.');return result}
export async function paymentRequests(auth:string,action:string,payload:Record<string,unknown>={}){
 const name=actions[action];if(!name)throw Error('Solicitud no válida.');
 if(action==='transition'){
  const transition=String(payload.transition||'').toUpperCase(),id=Number(payload.id);
  if(['APPROVE','REJECT','CANCEL'].includes(transition)){
   const detail=await rpc(auth,'wf_instance_detail',{p_entity_type:'PAYMENT_REQUEST',p_entity_id:id});
   if(detail?.instance){const map:Record<string,string>={APPROVE:'APROBAR',REJECT:'RECHAZAR',CANCEL:'CANCELAR'};return rpc(auth,'wf_act',{p_instance_id:detail.instance.id,p_action:map[transition],p_comment:payload.reason||null,p_ip:null})}
  }
  const result=await rpc(auth,name,{p:payload});
  if(transition==='SUBMIT')await rpc(auth,'wf_start_entity',{p_entity_type:'PAYMENT_REQUEST',p_entity_id:id,p_context:{}});
  return result;
 }
 return rpc(auth,name,action==='options'?{}:{p:payload});
}
