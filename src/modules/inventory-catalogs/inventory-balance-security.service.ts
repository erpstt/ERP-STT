import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
export const inventoryBalanceCatalogs=new Set(['stock','stock-adjustments','stock-lots','stock-serials','stock-reservations','stock-transfers','stock-movements']);
export async function assertInventoryBalanceView(auth:string,slug:string){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesi\u00f3n.'),{status:401});
 if(!inventoryBalanceCatalogs.has(slug))throw Object.assign(new Error('Consulta de inventario inv\u00e1lida.'),{status:400});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 try{await assertRoleAccess(auth,'inventory:'+slug,'view');}catch(e){if(slug!=='stock-movements'||(e as {status?:number}).status!==403)throw e;const {assertPurchaseDocumentAccess}=await import('../purchasing-catalogs/purchase-workflow.service.js');await assertPurchaseDocumentAccess(auth,'view','RECEIPT');}
}
export function denyInventoryBalanceWrite(slug:string){if(inventoryBalanceCatalogs.has(slug))throw Object.assign(new Error('Este registro es de consulta. Los cambios requieren un proceso de inventario autorizado.'),{status:403});}
export async function inventoryBalanceOptions(auth:string,slug:string){
 await assertInventoryBalanceView(auth,slug);const c=getSupabaseConfig();if(!c)throw Error('Supabase no est\u00e1 configurado.');
 const r=await fetchSupabase(new URL('/rest/v1/rpc/inventory_balance_options',c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({p_catalog:slug})});if(!r.ok)throw Object.assign(new Error('No fue posible consultar las referencias de inventario.'),{status:r.status===401?401:r.status===403?403:500});return r.json();
}
