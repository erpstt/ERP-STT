import { assertRoleAccess, myRoleAccess } from '../security-catalogs/role-access-matrix.module.js';

export function denyLegacyWorkflowAccess():never {
  throw Object.assign(new Error('Utilice la configuración de flujos y la bandeja de aprobaciones.'), {status:403});
}

export async function assertWorkflowConfigAccess(auth:string,action:string,payload:Record<string,unknown>={}) {
  if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
  const access=await myRoleAccess(auth);
  const write=action==='save'||action==='delete';
  if(write&&!access.isAdmin)throw Object.assign(new Error('Se requiere el rol administrador activo para configurar flujos.'),{status:403});
  if(write){await assertRoleAccess(auth,'workflow:approval-workflows',action==='delete'?'delete':payload.id===undefined||payload.id===null||payload.id===''?'create':'edit');return;}
  for(const a of ['view','create','edit','delete'] as const) {
    if(a!=='view'&&!access.isAdmin)continue;
    try{await assertRoleAccess(auth,'workflow:approval-workflows',a);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}
  }
  throw Object.assign(new Error('El rol activo no tiene acceso a la configuración de flujos.'),{status:403});
}
