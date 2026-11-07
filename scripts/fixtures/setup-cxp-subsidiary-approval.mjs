import {readFile} from 'node:fs/promises';
import {setupPaymentRequestSecurity} from './setup-payment-request-security.mjs';

// Full definitions captured by the read-only production preflight. They are
// the actual published oracles, not a simulated permissions implementation.
const approvalOracles = ["CREATE OR REPLACE FUNCTION public.app_is_admin()\n RETURNS boolean\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'public'\nAS $function$\n  select exists(\n    select 1 from public.roles r\n    where r.role_id=public.app_active_role_id()\n      and lower(r.role_name) in('administrador','administrator','admin')\n  )\n$function$\n", "CREATE OR REPLACE FUNCTION public.security_assert_role_access(p_resource_key text, p_action text DEFAULT 'view'::text)\n RETURNS void\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\ndeclare allowed boolean:=false;\nbegin\n if p_resource_key in('security:users','security:roles','security:user-roles','security:user-subsidiaries','security:permissions','security:role-permissions','security:role-access-matrix')then perform access_admin_private.access(substr(p_resource_key,10),p_action);return;end if;\n if public.app_is_admin()then return;end if;\n if p_action not in('view','create','edit','delete')then raise exception'La acción solicitada no es válida.';end if;\n select exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and(\n    false  or(m.resource_key=p_resource_key and case p_action when'view'then m.can_view when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end)\n ))into allowed;\n if not allowed then raise exception using errcode='42501',message='El rol activo no tiene permiso para realizar esta acción.';end if;\nend$function$\n"];
export const cxpApprovalMigration = '20261107161212_route_cxp_to_subsidiary_administrative_approver.sql';
export async function applyCxpSubsidiaryApproval(db){
  const sql=(await readFile(new URL('../../supabase/migrations/'+cxpApprovalMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  await db.exec('begin');
  try{await db.exec(sql);await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
export async function setupCxpSubsidiaryApproval(db,{apply=true}={}){
  await setupPaymentRequestSecurity(db);
  for(const definition of approvalOracles)await db.exec(definition);
  // Checkout CRLF must not change the deployed LF prosrc guard.
  const original=(await db.query("select pg_get_functiondef('payment_request_private.pr_resolve_payment_request_approver(bigint)'::regprocedure) definition")).rows[0].definition;
  await db.exec(original.replace(/\r\n/g,'\n'));
  await db.exec(`
    insert into roles values(91,'Synthetic CxP approver',false),(92,'Synthetic blind writer',false);
    insert into role_access_matrix values(91,'accounting:payment-requests',true,false,false,false),(92,'treasury:payment-requests',false,true,true,false);
    insert into users(user_id,auth_user_id,is_active,first_name,last_name,email)values
      (11,'00000000-0000-0000-0000-000000000011',true,'Synthetic','Approver','approver11@example.invalid'),
      (12,'00000000-0000-0000-0000-000000000012',true,'Synthetic','Blind','blind12@example.invalid'),
      (13,'00000000-0000-0000-0000-000000000013',true,'Synthetic','NoRole','norole13@example.invalid');
    insert into user_roles values(11,91),(12,92);
    insert into user_subsidiaries values(11,1),(12,1),(13,1);
    update employees set user_id=2,is_active=true where employee_id=10;
  `);
  if(apply)await applyCxpSubsidiaryApproval(db);
}
