import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
export type RequestAction='view'|'create'|'edit'|'delete'|'context'|'support';
export async function assertPaymentRequestAccess(a:string,action:RequestAction,resource?:string){
 if(!/^Bearer\s+\S+$/i.test(a))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 const actions=action==='context'?['view','create','edit'] as const:action==='support'?['edit','create'] as const:[action] as const;
 for(const candidate of actions)for(const key of resource?[resource]:['treasury:payment-requests','accounting:payment-requests']){try{await assertRoleAccess(a,key,candidate);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}
 throw Object.assign(new Error('El rol activo no puede realizar esta acción en Solicitudes de Pago.'),{status:403});
}
export async function paymentRequestRpc<T=any>(a:string,name:string,input:Record<string,unknown>={},action:RequestAction='view',resource?:string):Promise<T>{
 await assertPaymentRequestAccess(a,action,resource);const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(input)}),raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok){
  if(response.status>=400&&response.status<500&&response.status!==401&&response.status!==403&&result?.code==='PRA01')throw Object.assign(new Error('Configure un Aprobador Administrativo activo y autorizado en la subsidiaria antes de enviar la solicitud a aprobación.'),{status:409});
  const status=response.status===401?401:response.status===403||result?.code==='42501'?403:['55000','23503','23505','PT422','P0001'].includes(result?.code)?409:['22023','22P02','22003','22007','22008','23514','23502'].includes(result?.code)?400:500;throw Object.assign(new Error(status===401?'La sesión no es válida.':status===403?'El rol activo no puede realizar esta operación.':status===409?'La solicitud está protegida por su versión, estado, saldo o historial.':status===400?'Revise los datos de la solicitud.':'No fue posible procesar la solicitud de pago.'),{status});}return result as T;
}
