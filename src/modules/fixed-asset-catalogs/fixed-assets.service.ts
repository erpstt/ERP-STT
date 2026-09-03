import { getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc(authorization:string,name:string,parameters:Record<string,unknown>={}) {
  const config=getSupabaseConfig();
  if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetch(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
  const text=await response.text();
  const result=text?JSON.parse(text):null;
  if(!response.ok)throw new Error(result?.message||'No fue posible procesar los activos fijos.');
  return result;
}

export const fixedAssetOptions=(authorization:string)=>rpc(authorization,'fixed_asset_options');
export const fixedAssetReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_report',{p_filters:filters});
export const saveFixedAsset=(authorization:string,payload:Record<string,unknown>,id?:number)=>rpc(authorization,'save_fixed_asset',{p_payload:payload,p_asset_id:id||null});
export const depreciationPreview=(authorization:string,date:string)=>rpc(authorization,'fixed_asset_depreciation_preview',{p_date:date});
export const runDepreciation=(authorization:string,payload:Record<string,unknown>)=>rpc(authorization,'run_fixed_asset_depreciation',{p_date:payload.date,p_asset_ids:payload.assetIds});
