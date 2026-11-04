import{assertOrganizationMasterAccess}from'./organization-master.service.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

function publicProviderMessage(name:string){
  switch(name){
    case 'up_approver_options':return 'No fue posible cargar las opciones de aprobadores UP.';
    case 'up_approver_selector_options':return 'No fue posible cargar la lista de aprobadores UP.';
    case 'up_cost_centers_by_approver':return 'No fue posible consultar los centros de costo del aprobador UP.';
    case 'up_reassign_cost_centers':return 'No fue posible reasignar los centros de costo al aprobador UP.';
    default:return 'No fue posible procesar los aprobadores UP.';
  }
}

async function rpc<T>(authorization:string,name:string,parameters:Record<string,unknown>={}){
  const config=getSupabaseConfig();
  if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{
    method:'POST',
    headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},
    body:JSON.stringify(parameters)
  });
  const raw=await response.text();
  if(!response.ok){
    let payload:{code?:unknown}|null=null;
    try{payload=raw?JSON.parse(raw):null;}catch{}
    const failure=new Error(publicProviderMessage(name))as Error&{status?:number};
    failure.status=payload?.code==='42501'?403:400;
    throw failure;
  }
  return (raw?JSON.parse(raw):null) as T;
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

export async function reassignCostCenterUpApprover(authorization:string,payload:Record<string,unknown>){
  await assertOrganizationMasterAccess(authorization,'cost-centers','edit');
  return rpc<Record<string,unknown>>(authorization,'up_reassign_cost_centers',{p:payload});
}
