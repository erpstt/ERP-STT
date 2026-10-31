import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { invalidateFixedAssetCatalogCache } from './fixed-asset-catalogs.module.js';
import { assertRoleAccess } from '../security-catalogs/role-access-matrix.module.js';

async function rpc(authorization:string,name:string,parameters:Record<string,unknown>={}) {
  const payload=parameters.p_payload as Record<string,unknown>|undefined;
  const proposal=name==='fixed_asset_proposal_report'||name==='process_fixed_asset_proposals';
  const depreciation=name==='fixed_asset_depreciation_preview'||name==='run_fixed_asset_depreciation';
  if(proposal||depreciation){
    if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
    await assertRoleAccess(authorization,proposal?'fixed-assets:asset-proposals':'fixed-assets:asset-depreciations',
      name==='process_fixed_asset_proposals'?(payload?.action==='DISCARD'?'edit':'create'):name==='run_fixed_asset_depreciation'?'create':'view');
    if(name==='process_fixed_asset_proposals'&&!['CAPITALIZE','DISCARD'].includes(String(payload?.action)))throw Object.assign(new Error('Acción no válida.'),{status:400});
  }
  const config=getSupabaseConfig();
  if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
  const text=await response.text();
  const result=text?JSON.parse(text):null;
  if(!response.ok){
    if(proposal||depreciation){
      const status=response.status===401?401:response.status===403||result?.code==='42501'?403:result?.code==='55000'?409:['22023','22P02','22007','22008'].includes(result?.code)?400:500;
      throw Object.assign(new Error(status===401?'La sesión no es válida.':status===403?'El rol activo no puede realizar esta operación.':status===409?'Revise el estado de los registros y el período contable.':status===400?'Revise los datos de los activos seleccionados.':'No fue posible procesar los activos fijos.'),{status});
    }
    throw new Error(result?.message||'No fue posible procesar los activos fijos.');
  }
  return result;
}

export const fixedAssetOptions=(authorization:string)=>rpc(authorization,'fixed_asset_options');
export const fixedAssetProposalReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_proposal_report',{p_filters:filters});
export async function processFixedAssetProposals(authorization:string,payload:Record<string,unknown>){const result=await rpc(authorization,'process_fixed_asset_proposals',{p_payload:payload});invalidateFixedAssetCatalogCache('assets');return result;}
export const fixedAssetReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_report',{p_filters:filters});
export async function saveFixedAsset(authorization:string,payload:Record<string,unknown>,id?:number){const result=await rpc(authorization,'save_fixed_asset',{p_payload:payload,p_asset_id:id||null});invalidateFixedAssetCatalogCache('assets');return result;}
export async function depreciationPreview(authorization:string,date:string) {
  const result = await rpc(authorization,'fixed_asset_depreciation_preview',{p_date:date});
  if (!result?.period?.id || !result.rows?.some((row:{processed:boolean})=>row.processed)) return result;
  const config = getSupabaseConfig()!;
  const query = new URLSearchParams({select:'depreciation_id,asset_id',fiscal_period_id:`eq.${result.period.id}`,is_opening_balance:'eq.false',order:'depreciation_id',limit:'1000'});
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
export async function runDepreciation(authorization:string,payload:Record<string,unknown>){const result=await rpc(authorization,'run_fixed_asset_depreciation',{p_date:payload.date,p_asset_ids:payload.assetIds});invalidateFixedAssetCatalogCache('assets');return result;}
export async function fixedAssetDetail(authorization:string,id:number){
  const [detail,origins]=await Promise.all([rpc(authorization,'fixed_asset_detail',{p_asset_id:id}),rpc(authorization,'fixed_asset_proposal_origins',{p_asset_id:id})]);
  return {...detail,origins};
}
export const fixedAssetAnalytics=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_analytics',{p_filters:filters});
export const fixedAssetOperationOptions=(authorization:string)=>rpc(authorization,'fixed_asset_operation_options');
export const fixedAssetOperationReport=(authorization:string,filters:Record<string,unknown>)=>rpc(authorization,'fixed_asset_operation_report',{p_filters:filters});
export const saveFixedAssetOperation=(authorization:string,payload:Record<string,unknown>,id?:number)=>rpc(authorization,'save_fixed_asset_operation',{p_payload:payload,p_operation_id:id||null});
export const deleteFixedAssetOperation=(authorization:string,type:string,id:number)=>rpc(authorization,'delete_fixed_asset_operation',{p_type:type,p_operation_id:id});
