import {invalidateFixedAssetCatalogCache} from './fixed-asset-catalogs.module.js';
import {assetMasterRpc} from './asset-master-access.service.js';
const resource='fixed-assets:asset-categories';
export const assetCategoryOptions=(a:string)=>assetMasterRpc(a,resource,'view','asset_category_options');
export const assetCategoryReport=(a:string,p:Record<string,unknown>)=>assetMasterRpc(a,resource,'view','asset_category_report',{p_filters:p});
export async function saveAssetCategory(a:string,p:Record<string,unknown>,id?:number){
 const result=await assetMasterRpc(a,resource,id===undefined?'create':'edit','save_asset_category',{p_payload:p,p_category_id:id??null});
 invalidateFixedAssetCatalogCache('asset-categories');return result;
}
export async function deleteAssetCategory(a:string,id:number){
 const result=await assetMasterRpc(a,resource,'delete','delete_asset_category',{p_category_id:id});
 invalidateFixedAssetCatalogCache('asset-categories');return result;
}
