import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
type Action='view'|'create'|'edit'|'delete'|'context';
export async function assertSupplierPaymentAccess(a:string,action:Action){
 if(!/^Bearer\s+\S+$/i.test(a))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 if(action!=='context')return assertRoleAccess(a,'purchasing:supplier-payments',action);
 for(const candidate of ['view','create','edit'] as const){try{await assertRoleAccess(a,'purchasing:supplier-payments',candidate);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}
 throw Object.assign(new Error('El rol activo no tiene acceso a pagos de proveedores.'),{status:403});
}
export async function supplierPaymentRpc(a:string,name:string,input:Record<string,unknown>={},action:Action='view'){
 await assertSupplierPaymentAccess(a,action);const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok){const status=response.status===401?401:response.status===403||result?.code==='42501'?403:['55000','23503','23505','PT422','P0001'].includes(result?.code)?409:['22023','22P02','22003','22007','22008','23514','23502'].includes(result?.code)?400:500;throw Object.assign(new Error(status===401?'La sesión no es válida.':status===403?'El rol activo no puede realizar esta operación.':status===409?'El pago está protegido por su origen, saldo, conciliación o historial.':status===400?'Revise los datos del pago.':'No fue posible procesar el pago de proveedor.'),{status});}return result;
}
