import {assetMasterRpc,assertAssetMasterAccess} from './asset-master-access.service.js';
export function assetOperationResource(type:unknown){
 const resources:Record<string,string>={TRANSFER:'fixed-assets:asset-transfers',DISPOSAL:'fixed-assets:asset-disposals',MAINTENANCE:'fixed-assets:asset-maintenances'};
 if(typeof type!=='string'||!Object.hasOwn(resources,type))throw Object.assign(new Error('Tipo de operación inválido.'),{status:400});return resources[type]!;
}
export async function assetOperationRpc(a:string,name:string,p:Record<string,unknown>){
 if(name==='fixed_asset_operation_options'){
  for(const type of ['TRANSFER','DISPOSAL','MAINTENANCE']){const resource=assetOperationResource(type);try{await assertAssetMasterAccess(a,resource,'view');}catch(error){if((error as {status?:number}).status!==403)throw error;continue;}return assetMasterRpc(a,resource,'view',name,p);}
  throw Object.assign(new Error('El rol activo no puede consultar operaciones de activos.'),{status:403});
 }
 const payload=(p.p_payload??p.p_filters) as Record<string,unknown>|undefined,resource=assetOperationResource(p.p_type??payload?.type);
 const action=name==='save_fixed_asset_operation'?(p.p_operation_id===null?'create':'edit'):name==='delete_fixed_asset_operation'?'delete':'view';
 return assetMasterRpc(a,resource,action,name,p);
}
