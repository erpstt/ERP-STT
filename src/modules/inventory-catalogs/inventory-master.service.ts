import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
export const inventoryMasterCatalogs=new Set(['products','product-subsidiaries','product-suppliers','product-images','barcodes','warehouse-locations','bins','item-location-configurations']);
export async function assertInventoryMasterAccess(auth:string,slug:string,action:'view'|'create'|'edit'){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 await assertRoleAccess(auth,(slug==='locations'?'organization:':'inventory:')+slug,action);
 if(action!=='view'&&slug==='product-subsidiaries')throw Object.assign(new Error('Las asignaciones requieren mantenimiento central autorizado.'),{status:403});
}
export async function inventoryMasterRpc(auth:string,slug:string,action:'view'|'create'|'edit',payload?:Record<string,unknown>,id?:number){
 await assertInventoryMasterAccess(auth,slug,action);
 const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const r=await fetchSupabase(new URL('/rest/v1/rpc/'+(action==='view'?'inventory_master_data':'save_inventory_master'),c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({p_catalog:slug,...(action==='view'?{}:{p_payload:payload,p_id:id??null})})});
 const data=await r.json();if(!r.ok){const status=r.status===401?401:r.status===403||data?.code==='42501'?403:['55000','23503','23505'].includes(data?.code)?409:['22023','22P02','23502','23514'].includes(data?.code)?400:500;throw Object.assign(new Error(status===403?'El maestro es ajeno, compartido o no tiene permiso para modificarlo.':status===409?'El origen del registro no puede cambiarse.':status===400?'Revise los campos y referencias del maestro.':'No fue posible procesar el maestro.'),{status});}return data;
}
export function denyInventoryMasterDelete(){throw Object.assign(new Error('No se permite eliminar maestros ni sus dependencias. Desactive el producto cuando corresponda.'),{status:403});}
