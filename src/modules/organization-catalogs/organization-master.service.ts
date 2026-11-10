import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';
export const organizationMasters=new Set(['departments','locations','classes','cost-centers','financial-creditors','related-companies','fiscal-years','fiscal-calendars','accounting-periods','subsidiaries','branches']);
const fiscalCatalogs=new Set(['fiscal-years','fiscal-calendars','accounting-periods']);
const fiscalErrorMessages=new Map<string,string>([
 ['42501\nRequiere permiso específico de cierre fiscal.','El rol activo necesita el permiso específico para cerrar y reabrir períodos fiscales.'],
 ['22023\nRespete la secuencia de cierre AP, AR y GL.','Bloquee Cuentas por Pagar y Cuentas por Cobrar antes del Mayor; bloquee los tres antes de cerrar el período.'],
 ['55000\nReabra el año antes de modificar el cierre del período.','Reabra el año fiscal antes de cambiar el cierre del período.'],
 ['55000\nCierre todos los períodos antes de cerrar el año.','Cierre todos los períodos antes de cerrar el año fiscal.'],
 ['55000\nEl período utilizado conserva fechas, año y estado activo.','Un período con referencias conserva sus fechas, año y estado activo.']
].flatMap(([key,message]):[string,string][]=>[[key,message],[Buffer.from(key,'utf8').toString('latin1'),message]]));
function fiscalErrorMessage(catalog:string,code:unknown,message:unknown,status:number){
 if(!fiscalCatalogs.has(catalog)||status===401||typeof code!=='string'||typeof message!=='string')return undefined;
 if(status!==(code==='42501'?403:code==='55000'?409:code==='22023'?400:0))return undefined;
 return fiscalErrorMessages.get(code+'\n'+message);
}
export async function assertOrganizationMasterAccess(auth:string,k:string,a:'view'|'create'|'edit'|'delete'){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});if(!organizationMasters.has(k))throw Object.assign(Error('Catálogo inválido.'),{status:400});
 const{assertRoleAccess,myRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');if(a==='view'){await assertRoleAccess(auth,'organization:'+k,a);return;}
 const access=await myRoleAccess(auth),flag=a==='create'?'canCreate':a==='edit'?'canEdit':'canDelete';if(['locations','subsidiaries'].includes(k)&&a==='delete'||!access.grants.some(g=>g.resourceKey==='organization:'+k&&g[flag]===true))throw Object.assign(Error('Requiere permiso explícito para mantener este catálogo.'),{status:403});
}
export async function organizationMasterRpc(auth:string,k:string,a:'view'|'options'|'detail'|'create'|'edit'|'delete',p:Record<string,unknown>={},id?:number){
 await assertOrganizationMasterAccess(auth,k,a==='options'||a==='detail'?'view':a);if(id!==undefined&&(!Number.isSafeInteger(id)||id<=0))throw Object.assign(Error('Identificador inválido.'),{status:400});const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const name=a==='detail'?'organization_company_detail':a==='view'?'organization_master_list':a==='options'?'organization_master_options':a==='delete'?'delete_organization_master':'save_organization_master',payload=a==='detail'?{p_id:id}:{p_catalog:k,...(a==='view'||a==='options'?{}:a==='delete'?{p_id:id,p_revision:p._revision??null}:{p_payload:p,p_id:id??null})};
 const r=await fetchSupabase(new URL('/rest/v1/rpc/'+name,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok){const status=r.status===401?401:r.status===403||d?.code==='42501'?403:['55000','23503','23505','P0001'].includes(d?.code)?409:['22023','22007','22008','22P02','22003','22001','23502','23514'].includes(d?.code)?400:500;throw Object.assign(Error(fiscalErrorMessage(k,d?.code,d?.message,status)??(status===403?'Catálogo, filiales o referencias no autorizados.':status===409?'El catálogo cambió o tiene dependencias. Consúltelo nuevamente.':status===400?'Revise nombre, tipo, jerarquía y asignaciones.':'No fue posible procesar el catálogo.')),{status});}return d;
}
