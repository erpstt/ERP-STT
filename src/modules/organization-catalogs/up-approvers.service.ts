import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc<T>(authorization:string,name:string,parameters:Record<string,unknown>={}){
  const config=getSupabaseConfig();
  if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{
    method:'POST',
    headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},
    body:JSON.stringify(parameters)
  });
  const raw=await response.text();
  const payload=raw?JSON.parse(raw):null;
  if(!response.ok){
    const failure=new Error(payload?.message||'No fue posible procesar los aprobadores UP.')as Error&{status?:number};
    failure.status=payload?.code==='42501'?403:400;
    throw failure;
  }
  return payload as T;
}

export function upApproverOptions(authorization:string){
  return rpc<Record<string,unknown>>(authorization,'up_approver_options');
}

export function upApproverSelectorOptions(authorization:string){
  return rpc<unknown[]>(authorization,'up_approver_selector_options');
}

export function listCostCentersByUpApprover(authorization:string,approverId:number){
  if(!Number.isSafeInteger(approverId)||approverId<=0)throw new Error('El aprobador UP no es válido.');
  return rpc<Record<string,unknown>>(authorization,'up_cost_centers_by_approver',{p_approver_id:approverId});
}

export function reassignCostCenterUpApprover(authorization:string,payload:Record<string,unknown>){
  return rpc<Record<string,unknown>>(authorization,'up_reassign_cost_centers',{p:payload});
}
