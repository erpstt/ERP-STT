import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
type Action='view'|'create'|'edit'|'context';
export class SupplierInvoiceDuplicateError extends Error{
 readonly status=409;
 readonly code='SUPPLIER_INVOICE_DUPLICATE';
 readonly field='invoice_number';
 constructor(){super('El número de factura ya se encuentra registrado para este proveedor. Revise el número antes de guardar.');this.name='SupplierInvoiceDuplicateError';}
}
export async function assertSupplierInvoiceAccess(a:string,action:Action,resource='purchasing:supplier-invoices'){
 if(!/^Bearer\s+\S+$/i.test(a))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 if(action!=='context'){await assertRoleAccess(a,resource,action);return;}
 for(const candidate of ['view','create','edit'] as const){try{await assertRoleAccess(a,resource,candidate);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}
 throw Object.assign(new Error('El rol activo no tiene acceso a facturas de proveedores.'),{status:403});
}
export async function supplierInvoiceRpc<T=unknown>(a:string,name:string,input:Record<string,unknown>={},action:Action='view',resource='purchasing:supplier-invoices'):Promise<T>{
 await assertSupplierInvoiceAccess(a,action,resource);
 const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:a,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const raw=await response.text(),result=raw?JSON.parse(raw):null;
 if(!response.ok){
  const status=response.status===401?401:response.status===403||result?.code==='42501'?403:['55000','23503','23505','PT422'].includes(result?.code)?409:['22023','22P02','22003','22007','22008','23514','23502'].includes(result?.code)?400:500;
  if(status===409&&name==='save_supplier_invoice'&&result?.code==='23505'&&result?.message==='duplicate key value violates unique constraint "supplier_invoice_invoice_number_supplier_id_key"')throw new SupplierInvoiceDuplicateError();
  throw Object.assign(new Error(status===401?'La sesión no es válida.':status===403?'El rol activo no puede realizar esta operación.':status===409?'La factura está protegida por su estado, historial o control presupuestario.':status===400?'Revise los datos de la factura.':'No fue posible procesar la factura de proveedor.'),{status});
 }
 return result as T;
}
