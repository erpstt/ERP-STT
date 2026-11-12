import {parseCustomerEmailRecipients} from '../../../public/customer-email-recipients.js';
import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';
export const entityMasters=new Set(['customers','suppliers','employees','other-names']);type Action='view'|'create'|'edit'|'delete';
export function denyEntityRelationWrite():never{throw Object.assign(Error('Las asignaciones se mantienen desde el cliente o proveedor.'),{status:403});}
export async function assertEntityMasterAccess(auth:string,k:string,a:Action){if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});if(!entityMasters.has(k))throw Object.assign(Error('Maestro de entidad inválido.'),{status:400});const{assertRoleAccess,myRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');if(a==='view'){await assertRoleAccess(auth,'entities:'+k,a);return;}const access=await myRoleAccess(auth),flag=a==='create'?'canCreate':a==='edit'?'canEdit':'canDelete';if(!access.grants.some(g=>g.resourceKey==='entities:'+k&&g[flag]===true))throw Object.assign(Error('Requiere permiso explícito para mantener este maestro.'),{status:403});}
export async function entityMasterRpc(auth:string,k:string,a:Action|'options',p:Record<string,unknown>={},id?:number){
 await assertEntityMasterAccess(auth,k,a==='options'?'view':a);
 if(id!==undefined&&(!Number.isSafeInteger(id)||id<=0))throw Object.assign(Error('Identificador de entidad inválido.'),{status:400});
 const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const otherNames=k==='other-names';
 const name=otherNames
  ?a==='options'?'other_name_options':a==='view'?'other_name_list':a==='delete'?'delete_other_name':'save_other_name'
  :a==='options'?'entity_master_options':a==='view'?'entity_master_list':a==='delete'?'delete_entity_master':'save_entity_master';
 if(k==='customers'&&(a==='create'||a==='edit'))p={...p,email:parseCustomerEmailRecipients(p.email).join(', ')||null};
 const payload={...(otherNames?{}:{p_catalog:k}),...(a==='options'||a==='view'?{}:a==='delete'?{p_id:id,p_revision:p._revision??null}:{p_payload:p,p_id:id??null})};
 const r=await fetchSupabase(new URL('/rest/v1/rpc/'+name,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const text=await r.text(),d=text?JSON.parse(text):null;
 if(!r.ok){
  if(k==='customers'&&d?.code==='23514'&&/customers_email_format|customer_statement_email_required/.test(String(d?.message)))throw Object.assign(Error('Revise los correos del cliente: use direcciones v\u00e1lidas separadas por coma o punto y coma. El env\u00edo autom\u00e1tico de estados de cuenta requiere al menos un correo.'),{status:400});
  const referenceErrors=new Set(['Las monedas deben estar disponibles para las subsidiarias seleccionadas.','Departamento de cliente no disponible.','Representante de ventas no disponible.']);
  if(!otherNames&&d?.code==='42501'&&referenceErrors.has(d?.message))throw Object.assign(Error(d.message),{status:400});
  const status=r.status===401?401:r.status===403||d?.code==='42501'?403:['55000','23503','23505','P0001'].includes(d?.code)?409:['22023','22P02','22003','22001','23502','23514'].includes(d?.code)?400:500;
  const message=otherNames&&d?.code==='23505'
   ?'Ya existe un tercero con esa identificación en la subsidiaria activa.'
   :status===403?'Entidad, subsidiarias o referencias no autorizadas.'
   :status===409?'La entidad cambió, está utilizada o tiene dependencias. Consúltela nuevamente.'
   :status===400?(otherNames?'Revise identificación, nombre, correo, bancos, monedas, IBAN y números de cuenta.':k==='employees'?'Revise identificación, nombre, correo, referencias y datos bancarios del empleado.':'Revise los datos, monedas, cuentas bancarias y reglas de retención.')
   :'No fue posible procesar el maestro de entidad.';
  throw Object.assign(Error(message),{status});
 }
 return d;
}
