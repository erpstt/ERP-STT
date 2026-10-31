import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';
export const inventoryGlobalCatalogs=new Set(['item-types','product-categories','product-brands','product-groups']);
type Action='view'|'create'|'edit'|'delete';
export async function assertInventoryGlobalAccess(auth:string,slug:string,action:Action){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 if(!inventoryGlobalCatalogs.has(slug)&&slug!=='uom')throw Object.assign(new Error('Catálogo global inválido.'),{status:400});
 const{assertRoleAccess,myRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');const resource=(slug==='uom'?'configuration:':'inventory:')+slug;
 if(action==='view'){await assertRoleAccess(auth,resource,action);return;}
 const access=await myRoleAccess(auth),property=action==='create'?'canCreate':action==='edit'?'canEdit':'canDelete';
 if(!access.grants.some(g=>g.resourceKey===resource&&g[property]===true))throw Object.assign(new Error('Requiere permiso explícito para modificar este catálogo global.'),{status:403});
}
export async function inventoryGlobalRpc(auth:string,slug:string,action:Action,payload?:Record<string,unknown>,id?:number){
 await assertInventoryGlobalAccess(auth,slug,action);const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const name=action==='view'?'inventory_global_access':action==='delete'?'delete_inventory_global':'save_inventory_global';
 const r=await fetchSupabase(new URL('/rest/v1/rpc/'+name,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({p_catalog:slug,...(action==='view'?{}:action==='delete'?{p_id:id}:{p_payload:payload,p_id:id??null})})});
 const raw=await r.text(),data=raw?JSON.parse(raw):null;if(!r.ok){const status=r.status===401?401:r.status===403||data?.code==='42501'?403:['55000','23503','23505'].includes(data?.code)?409:['22023','22P02','23502','23514'].includes(data?.code)?400:500;throw Object.assign(new Error(status===403?'Requiere permiso explícito de mantenimiento global.':status===409?'El registro está utilizado, tiene dependencias o ya no existe.':status===400?'Revise los campos y la jerarquía del catálogo.':'No fue posible procesar el catálogo global.'),{status});}return data;
}
