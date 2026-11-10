import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {invalidateRoleAccessCaches} from '../security-catalogs/role-access-matrix.module.js';

export type FiscalClosurePermissionOptions = {canConfigure:false}|{
  canConfigure:true;enabled:boolean;revision:string;role:{id:number;name:string};
};
const revisionPattern=/^[a-f0-9]{32}$/;
function authenticated(auth:string){
  if(!/^Bearer\s+\S+$/i.test(auth??''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
}
function options(value:unknown):FiscalClosurePermissionOptions{
  const data=value as Record<string,unknown>|null;
  if(data?.canConfigure===false)return{canConfigure:false};
  const role=data?.role as Record<string,unknown>|undefined;
  if(data?.canConfigure!==true||typeof data.enabled!=='boolean'||typeof data.revision!=='string'||!revisionPattern.test(data.revision)
    ||!role||!Number.isSafeInteger(role.id)||Number(role.id)<=0||typeof role.name!=='string'||!role.name.trim()||role.name.length>120){
    throw Object.assign(Error('No fue posible comprobar la configuración del permiso de cierre.'),{status:502});
  }
  return{canConfigure:true,enabled:data.enabled,revision:data.revision,role:{id:Number(role.id),name:role.name}};
}
async function rpc(auth:string,name:string,payload:Record<string,unknown>){
  const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
  let response:Response;
  try{response=await fetchSupabase(new URL('/rest/v1/rpc/'+name,config.url),{
    method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload),
  });}catch{throw Object.assign(Error('No fue posible confirmar el cambio del permiso de cierre. Consúltelo antes de reintentar.'),{status:503});}
  let data:unknown;try{data=await response.json();}catch{throw Object.assign(Error('No fue posible confirmar la configuración del permiso de cierre. Consúltela nuevamente.'),{status:502});}
  if(!response.ok){
    const code=(data as {code?:unknown})?.code;
    const status=response.status===401?401:response.status===403||code==='42501'?403:code==='55000'?409:code==='22023'?400:503;
    const message=status===401?'Debe iniciar sesión.':status===403?'Esta configuración requiere un administrador central autorizado.':status===409?'La configuración del rol cambió. Consúltela nuevamente.':status===400?'Revise la confirmación y la revisión del permiso de cierre.':'No fue posible confirmar el cambio del permiso de cierre. Consúltelo antes de reintentar.';
    throw Object.assign(Error(message),{status});
  }
  return options(data);
}
export async function fiscalClosurePermissionOptions(auth:string):Promise<FiscalClosurePermissionOptions>{
  authenticated(auth);return rpc(auth,'fiscal_closure_permission_options',{});
}
export async function setFiscalClosurePermission(auth:string,input:unknown):Promise<FiscalClosurePermissionOptions>{
  authenticated(auth);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||Object.keys(input).some(key=>!['enabled','revision'].includes(key))){
    throw Object.assign(Error('Indique únicamente el permiso y su revisión vigente.'),{status:400});
  }
  const value=input as Record<string,unknown>;
  if(typeof value.enabled!=='boolean'||typeof value.revision!=='string'||!revisionPattern.test(value.revision))throw Object.assign(Error('Revise la confirmación y la revisión del permiso de cierre.'),{status:400});
  const result=await rpc(auth,'set_fiscal_closure_permission',{p_enabled:value.enabled,p_revision:value.revision});
  if(!result.canConfigure||result.enabled!==value.enabled)throw Object.assign(Error('La respuesta no confirmó el cambio del permiso de cierre. Consúltelo nuevamente.'),{status:502});
  invalidateRoleAccessCaches();
  return result;
}
