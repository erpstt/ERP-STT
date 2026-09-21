import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc(authorization:string,name:string,parameters:Record<string,unknown>={}) {
  const config=getSupabaseConfig();
  if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
  const text=await response.text();
  const result=text?JSON.parse(text):null;
  if(!response.ok)throw new Error(result?.message||'No fue posible procesar los activos fijos.');
  return result;
}

export const fixedAssetOptions=(authorization:string)=>rpc(authorization,'fixed_asset_options');
export const fixedAssetProposalReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_proposal_report',{p_filters:filters});
export const processFixedAssetProposals=(authorization:string,payload:Record<string,unknown>)=>rpc(authorization,'process_fixed_asset_proposals',{p_payload:payload});
export const fixedAssetReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_report',{p_filters:filters});
export const saveFixedAsset=(authorization:string,payload:Record<string,unknown>,id?:number)=>rpc(authorization,'save_fixed_asset',{p_payload:payload,p_asset_id:id||null});
export async function depreciationPreview(authorization:string,date:string) {
  const result = await rpc(authorization,'fixed_asset_depreciation_preview',{p_date:date});
  if (!result?.period?.id || !result.rows?.some((row:{processed:boolean})=>row.processed)) return result;
  const config = getSupabaseConfig()!;
  const query = new URLSearchParams({select:'depreciation_id,asset_id',fiscal_period_id:`eq.${result.period.id}`,order:'depreciation_id',limit:'1000'});
  const ids = new Map<string,number>();
  for (let offset=0;;) {
    query.set('offset',String(offset));
    const response = await fetchSupabase(new URL(`/rest/v1/asset_depreciation?${query}`,config.url),{
      headers:{apikey:config.anonKey,Authorization:authorization}
    });
    if (!response.ok) throw new Error('No fue posible consultar la autoría de las depreciaciones registradas.');
    const records = await response.json() as Array<{depreciation_id:number;asset_id:number}>;
    if (!records.length) break;
    records.forEach(row=>ids.set(String(row.asset_id),row.depreciation_id));
    offset+=records.length;
  }
  result.rows = result.rows.map((row:{id:number})=>({...row,depreciationId:ids.get(String(row.id))??null}));
  return result;
}
export const runDepreciation=(authorization:string,payload:Record<string,unknown>)=>rpc(authorization,'run_fixed_asset_depreciation',{p_date:payload.date,p_asset_ids:payload.assetIds});
export async function fixedAssetDetail(authorization:string,id:number){
  const [detail,origins]=await Promise.all([rpc(authorization,'fixed_asset_detail',{p_asset_id:id}),rpc(authorization,'fixed_asset_proposal_origins',{p_asset_id:id})]);
  return {...detail,origins};
}
export const fixedAssetAnalytics=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_analytics',{p_filters:filters});
export const fixedAssetOperationOptions=(authorization:string)=>rpc(authorization,'fixed_asset_operation_options');
export const fixedAssetOperationReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_operation_report',{p_filters:filters});
export const saveFixedAssetOperation=(authorization:string,payload:Record<string,unknown>,id?:number)=>rpc(authorization,'save_fixed_asset_operation',{p_payload:payload,p_operation_id:id||null});
export const deleteFixedAssetOperation=(authorization:string,type:string,id:number)=>rpc(authorization,'delete_fixed_asset_operation',{p_type:type,p_operation_id:id});
