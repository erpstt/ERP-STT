import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';
export const accessMasters=new Set(['users','roles','user-roles','user-subsidiaries','permissions','role-permissions']);
export async function accessAdminRpc(auth:string,name:string,payload:Record<string,unknown>={}){
 if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const r=await fetchSupabase(new URL('/rest/v1/rpc/'+name,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();
 if(!r.ok){const status=r.status===401?401:r.status===403||d?.code==='42501'?403:['55000','23503','23505','P0001'].includes(d?.code)?409:['22023','22P02','22003','23502','23514'].includes(d?.code)?400:500;throw Object.assign(Error(status===403?'Operación de seguridad no autorizada.':status===409?'El registro cambió o tiene dependencias. Consúltelo nuevamente.':status===400?'Revise los datos de seguridad.':'No fue posible completar la operación.'),{status});}return d;
}
