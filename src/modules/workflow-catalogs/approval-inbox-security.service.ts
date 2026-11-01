import{assertRoleAccess}from'../security-catalogs/role-access-matrix.module.js';
export async function assertApprovalInboxAccess(auth:string){if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});await assertRoleAccess(auth,'workflow:approval-inbox','view');}
const invalid=(message:string):never=>{throw Object.assign(Error(message),{status:400});};
function positiveId(id:unknown){if((typeof id!=='number'&&typeof id!=='string')||!String(id).match(/^[1-9][0-9]*$/)||!Number.isSafeInteger(Number(id))||Number(id)<=0)invalid('Identificador de aprobación inválido.');}
export function validateApprovalPayload(action:string,p:Record<string,unknown>){
 if(['act','bulk'].includes(action)&&p.comment!==undefined&&p.comment!==null&&(typeof p.comment!=='string'||p.comment.length>4000))invalid('Indique un comentario de hasta 4.000 caracteres.');
 if(action==='notifications'&&p.markRead!==undefined&&typeof p.markRead!=='boolean')invalid('Indique si desea marcar las notificaciones como leídas.');
 if(action==='detail'){if(!['PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST','BUDGET_TRANSFER'].includes(String(p.entityType)))invalid('Tipo de documento inválido.');positiveId(p.entityId);}
 if(action==='act'){positiveId(p.instanceId);if(!['APROBAR','RECHAZAR','CANCELAR'].includes(String(p.action).toUpperCase()))invalid('Acción de aprobación inválida.');}
 if(action==='bulk'){if(!Array.isArray(p.ids)||p.ids.length<1||p.ids.length>100)invalid('Seleccione entre uno y cien documentos.');for(const id of p.ids as unknown[])positiveId(id);if(new Set((p.ids as unknown[]).map(Number)).size!==(p.ids as unknown[]).length)invalid('No repita documentos en la selección.');}
}
