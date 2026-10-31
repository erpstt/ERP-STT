import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
type Action='view'|'create'|'edit'|'delete';
export async function assertAssetMasterAccess(authorization:string,resource:string,action:Action){
 if(!/^Bearer\s+\S+$/i.test(authorization))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 await assertRoleAccess(authorization,resource,action);
}
export async function assetMasterRpc(authorization:string,resource:string,action:Action,name:string,parameters:Record<string,unknown>={}){
 await assertAssetMasterAccess(authorization,resource,action);
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
 const raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok){
  const status=response.status===401?401:response.status===403||result?.code==='42501'?403:['55000','23503','23505'].includes(result?.code)?409:['22023','22P02','22007','22008','23514','23502'].includes(result?.code)?400:500;
  throw Object.assign(new Error(status===401?'La sesión no es válida.':status===403?'El rol activo no puede realizar esta operación.':status===409?'El registro tiene historial o dependencias que impiden el cambio.':status===400?'Revise los datos del activo o categoría.':'No fue posible procesar el maestro de activos.'),{status});
 }
 return result;
}
