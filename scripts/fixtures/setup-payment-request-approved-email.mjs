import {readFile}from'node:fs/promises';
import {setupCompanyMasterSecurity}from'./setup-company-master-security.mjs';
export const treasuryApprovalEmailMigration='20261104182110_add_payment_request_approved_treasury_email.sql';
const read=p=>readFile(new URL(p,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));

export async function setupPaymentRequestApprovedEmail(db){
 // Includes the real protected payment-request writers and approval engine,
 // plus the real protected company maintenance functions and role sessions.
 await setupCompanyMasterSecurity(db);
 // Published fixture sources can have CRLF after a Windows checkout. The
 // production source guards remain exact; canonicalize only the reviewed
 // function definitions before replaying the published access-admin patch.
 await db.exec(`do $$declare target regprocedure;begin foreach target in array array['organization_master_private.meta(text)'::regprocedure,'company_master_private.save(text,jsonb,bigint)'::regprocedure]loop
  execute replace(pg_get_functiondef(target),E'\\r\\n',E'\\n');
 end loop;end$$;`);
 const access=await read('../../supabase/migrations/20261101184932_secure_access_administration.sql');
 await db.exec(access.slice(access.indexOf('do $$'),access.indexOf('create schema access_admin_private;')));
 // Replay the captured common authorization oracle and its unchanged A06
 // retirement patches. This includes legitimate active-admin behavior while
 // removing the obsolete legacy matrix grant from this synthetic fixture.
 const authorization=await read('./legacy-authorization-functions.sql');
 const activation=await read('../../supabase/migrations/20261102014321_activate_legacy_authorization_retirement_after_server.sql');
 for(const name of['security_assert_role_access','security_resource_allowed']){
  const start=authorization.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'('),end=authorization.indexOf('$function$;',start);
  if(start<0||end<0)throw Error('Missing reviewed authorization oracle');
  await db.exec(authorization.slice(start,end+'$function$;'.length));
  const patches=[...activation.matchAll(/do \$patch\$[\s\S]*?end\$patch\$;/g)].map(m=>m[0]).filter(p=>p.includes("oid='public."+name+"(text,text)'::regprocedure"));
  if(patches.length!==1)throw Error('Missing reviewed authorization retirement patch');
  await db.exec(patches[0]);
 }
 const boundary=activation.match(/delete from public\.role_access_matrix where resource_key='legacy:all';\s*alter table public\.role_access_matrix add constraint no_legacy_authorization check\(resource_key<>'legacy:all'\);/);
 if(!boundary)throw Error('Missing reviewed legacy grant boundary');await db.exec(boundary[0]);
 await db.exec(`
 create table other_names(other_name_id bigint primary key,name text);
 insert into other_names values(91,'Synthetic other beneficiary');
 alter table solicitudes_pago_lineas add column id_otro_nombre bigint;
 create table configuraciones_correos(
  id uuid primary key default gen_random_uuid(),id_subsidiaria bigint not null references subsidiaries(subsidiary_id),
  tipo_notificacion text not null default'PAGO_PROVEEDOR',asunto_template varchar(200)not null,cuerpo_template text not null,
  activo boolean not null default false,updated_by_email text,updated_at timestamptz not null default now(),
  unique(id_subsidiaria,tipo_notificacion),constraint configuraciones_correos_tipo_notificacion_check check(tipo_notificacion in('PAGO_PROVEEDOR','ESTADO_CUENTA','FACTURA_VENTA','SOLICITUD_GASTO_APROBACION','USUARIO_INVITACION','USUARIO_RECUPERACION'))
 );
 alter table configuraciones_correos enable row level security;
 revoke all on configuraciones_correos from public,anon,authenticated,service_role;
 insert into configuraciones_correos(id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo)values(1,'PAGO_PROVEEDOR','Synthetic existing subject','Synthetic existing body',true);
 create table fixture_existing_payment_email_events(request_id bigint);
 create function payment_email_event()returns trigger language plpgsql security definer as $$begin insert into fixture_existing_payment_email_events values(new.id);return null;end$$;
 create constraint trigger payment_request_email_event after update on solicitudes_pago deferrable initially deferred for each row execute function payment_email_event();
 insert into role_access_matrix values(1,'configuration:notification-templates',true,false,true,false),(3,'configuration:notification-templates',true,false,false,false);
 update users set first_name='Synthetic '||user_id,last_name='User';
 insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,estado,fecha_solicitud,fecha_pago_programada,id_solicitante,concepto,total,version,aprobado_por,aprobado_at)
 values('SYN-HISTORICAL-APPROVED',1,1,'OTROS','APROBADO','2026-10-01','2026-10-31',1,'Historical approval before feature',25,3,2,'2026-10-01T12:00:00Z');
 insert into wf_instances(subsidiaria_id,entity_type,entity_id,amount,current_level,status,requested_by,completed_at)
 select 1,'PAYMENT_REQUEST',id,25,null,'APROBADO',1,'2026-10-01T12:00:00Z'from solicitudes_pago where numero='SYN-HISTORICAL-APPROVED';
 `);
}

export async function applyPaymentRequestApprovedEmailMigration(db){
 await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+treasuryApprovalEmailMigration));await db.exec('commit');}catch(e){await db.exec('rollback');throw e;}
}
