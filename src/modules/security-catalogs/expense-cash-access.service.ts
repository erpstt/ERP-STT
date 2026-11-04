import {assertRoleAccess,myRoleAccess} from './role-access-matrix.module.js';
type Action='view'|'create'|'edit'|'delete';
const resources=new Set(['expenses:expense-types','expenses:expense-policies','expenses:expenses','expenses:expense-lines','expenses:expense-approvals','expenses:expense-payments','treasury:cashboxes','treasury:cash-transactions','treasury:cash-openings','treasury:cash-closings','treasury:cash-transfers']);
export async function requireExpenseCashAccess(auth:string,resource:string,action:Action){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 if(!resources.has(resource))throw Object.assign(Error('Catálogo no válido.'),{status:400});
 await assertRoleAccess(auth,resource,'view');
 if(action!=='view')await assertRoleAccess(auth,resource,action);
 if(resource==='expenses:expense-types'&&action!=='view'&&!(await myRoleAccess(auth)).isAdmin)
  throw Object.assign(Error('El mantenimiento global de tipos de gasto requiere un administrador.'),{status:403});
}
export function expenseCashDbError(status:number,payload:unknown):never{
 const code=payload&&typeof payload==='object'&&'code'in payload?String(payload.code):'';
 const denied=status===403||code==='42501';
 throw Object.assign(Error(denied?'El rol activo no tiene acceso al gasto o caja en la subsidiaria seleccionada.':'No fue posible completar la operación de gastos o cajas.'),{status:status===401?401:denied?403:['22023','22P02','23502','23503','23505','23514','P0001'].includes(code)?400:500});
}
