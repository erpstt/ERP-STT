-- Approval reminders observe the real workflow; they never approve, post or pay.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema payment_request_reminder_private;
revoke all on schema payment_request_reminder_private from public,anon,authenticated,service_role;

-- Preserve all published notification kinds, including account invitations.
do $$declare definition text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint
 where conrelid='public.configuraciones_correos'::regclass and conname='configuraciones_correos_tipo_notificacion_check' and contype='c';
 if definition is null or definition not like '%SOLICITUD_PAGO_APROBADA%' or definition like '%SOLICITUD_PAGO_RECORDATORIO_APROBACION%'
 or definition not like '%USUARIO_INVITACION%' or definition not like '%USUARIO_RECUPERACION%' then raise exception 'Reviewed notification kinds changed';end if;
end$$;
alter table public.configuraciones_correos drop constraint configuraciones_correos_tipo_notificacion_check;
alter table public.configuraciones_correos add constraint configuraciones_correos_tipo_notificacion_check check(tipo_notificacion in
 ('PAGO_PROVEEDOR','ESTADO_CUENTA','FACTURA_VENTA','SOLICITUD_GASTO_APROBACION','USUARIO_INVITACION','USUARIO_RECUPERACION','SOLICITUD_PAGO_APROBADA','SOLICITUD_PAGO_RECORDATORIO_APROBACION'));

create table payment_request_reminder_private.activation(
 singleton boolean primary key default true check(singleton),activated_at timestamptz not null default now());
insert into payment_request_reminder_private.activation default values;
create table payment_request_reminder_private.current_stage(
 instance_id bigint primary key references public.wf_instances(id) on delete cascade,
 request_id bigint not null,subsidiary_id bigint not null,step_id bigint,
 epoch uuid not null default gen_random_uuid(),signature jsonb not null,
 assigned_at timestamptz not null,active boolean not null,initial_approvers bigint[] not null default '{}',
 next_collect_at timestamptz not null default now(),last_error text,template_was_disabled boolean not null default false);
create index payment_reminder_stage_active on payment_request_reminder_private.current_stage(next_collect_at,instance_id) where active;
alter table payment_request_reminder_private.activation enable row level security;
alter table payment_request_reminder_private.activation force row level security;
alter table payment_request_reminder_private.current_stage enable row level security;
alter table payment_request_reminder_private.current_stage force row level security;

create table public.payment_request_approval_reminder_email_outbox(
 id uuid primary key default gen_random_uuid(),assignment_id uuid not null unique default gen_random_uuid(),
 request_id bigint not null,subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
 instance_id bigint not null,approval_version integer not null check(approval_version>0),
 approval_level_id bigint not null,approver_user_id bigint not null,stage_epoch uuid not null,
 reminder_cycle text not null,assigned_at timestamptz not null,due_at timestamptz not null,
 recipient_email text,subject_template text not null,body_template text not null,payload jsonb not null,
 status text not null default 'PENDIENTE' check(status in('PENDIENTE','ENVIANDO','ENVIADO','ERROR','INCIERTO','ERROR_SIN_CORREO','OMITIDO','CANCELADO')),
 attempts integer not null default 0 check(attempts>=0),lease uuid,lease_until timestamptz,
 started_at timestamptz,sent_at timestamptz,finished_at timestamptz,message_id text,last_error text,
 next_attempt_at timestamptz not null,created_at timestamptz not null default now(),
 check(reminder_cycle='assignment:'||assignment_id::text),check(due_at>=assigned_at),
 check(status<>'ENVIANDO' or (lease is not null and lease_until is not null)));
-- A cancelled eligibility binding may be replaced; its replacement starts a new clock.
create unique index payment_reminder_current_recipient on public.payment_request_approval_reminder_email_outbox(stage_epoch,approver_user_id) where status<>'CANCELADO';
create index payment_reminder_pending on public.payment_request_approval_reminder_email_outbox(next_attempt_at,created_at,id) where status='PENDIENTE';
create index payment_reminder_lease on public.payment_request_approval_reminder_email_outbox(lease_until) where status='ENVIANDO';
create index payment_reminder_instance on public.payment_request_approval_reminder_email_outbox(instance_id,stage_epoch);
alter table public.payment_request_approval_reminder_email_outbox enable row level security;
alter table public.payment_request_approval_reminder_email_outbox force row level security;
revoke all on public.payment_request_approval_reminder_email_outbox from public,anon,authenticated,service_role;
revoke all on all tables in schema payment_request_reminder_private from public,anon,authenticated,service_role;

-- Catalog names are display labels, NOT IANA names. Only persisted, explicit offsets
-- are accepted. This matches the existing subsidiary timezone catalog contract.
create function payment_request_reminder_private.offset_minutes(p_value text)returns integer
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare m text[];n integer;begin
 m:=regexp_match(p_value,'^UTC([+-])([0-9]{2}):([0-9]{2})$');
 if m is null or m[3]::integer>59 then return null;end if;
 n:=m[2]::integer*60+m[3]::integer;if n>840 then return null;end if;
 return case m[1] when '-' then -n else n end;
end$$;

create function payment_request_reminder_private.next_weekday(p_at timestamptz,p_offset integer)returns timestamptz
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare local_at timestamp;d integer;begin
 if p_at is null or not isfinite(p_at) or p_offset is null or abs(p_offset)>840 then return null;end if;
 local_at:=(p_at at time zone 'UTC')+make_interval(mins=>p_offset);d:=extract(isodow from local_at);
 if d=6 then local_at:=date_trunc('day',local_at)+interval '2 days';elsif d=7 then local_at:=date_trunc('day',local_at)+interval '1 day';end if;
 return (local_at-make_interval(mins=>p_offset))at time zone 'UTC';
end$$;

-- Count 48 local weekday hours, not 48 wall-clock hours and not office hours.
-- A deadline exactly at Saturday 00:00 is moved to Monday 00:00.
create function payment_request_reminder_private.deadline(p_start timestamptz,p_offset integer)returns timestamptz
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare local_at timestamp;midnight_at timestamp;remaining interval:=interval '48 hours';available interval;begin
 local_at:=(payment_request_reminder_private.next_weekday(p_start,p_offset)at time zone 'UTC')+make_interval(mins=>p_offset);
 if local_at is null then return null;end if;
 loop
  if extract(isodow from local_at)>=6 then local_at:=local_at+make_interval(days=>8-extract(isodow from local_at)::integer);local_at:=date_trunc('day',local_at);end if;
  midnight_at:=date_trunc('day',local_at)+interval '1 day';available:=midnight_at-local_at;
  if remaining<=available then local_at:=local_at+remaining;exit;end if;
  remaining:=remaining-available;local_at:=midnight_at;
 end loop;
 return payment_request_reminder_private.next_weekday((local_at-make_interval(mins=>p_offset))at time zone 'UTC',p_offset);
end$$;

create function payment_request_reminder_private.service_only()returns void
language plpgsql stable security invoker set search_path=pg_catalog as $$begin
 if coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then
 raise exception using errcode='42501',message='Operación exclusiva del servicio de notificaciones.';end if;
end$$;

create function payment_request_reminder_private.safe_email(p_value text)returns text
language plpgsql immutable security invoker set search_path=pg_catalog,public,pg_temp as $$begin
 return company_master_private.treasury_email_value(p_value);
exception when invalid_parameter_value then return null;end$$;

create function payment_request_reminder_private.ensure_template(p_sid bigint)returns void
language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
 insert into public.configuraciones_correos(id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo)
 values(p_sid,'SOLICITUD_PAGO_RECORDATORIO_APROBACION','Recordatorio: solicitud {{numero_solicitud}} pendiente de aprobación · {{empresa_nombre}}',
 '<p>La solicitud de pago <strong>{{numero_solicitud}}</strong> continúa pendiente de su aprobación después de 48 horas de lunes a viernes.</p><p>El cómputo excluye los sábados y domingos completos. Consulte el estado actual en GENTIA para revisar y aprobar o rechazar la solicitud.</p>',true)
 on conflict(id_subsidiaria,tipo_notificacion)do nothing
$$;

create function public.payment_request_approval_reminder_email_settings(p_action text,p_payload jsonb default '{}'::jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare uid bigint:=public.app_user_id();sid bigint:=public.active_subsidiary_id();rid bigint:=public.app_active_role_id();
 action_name text:=lower(trim(coalesce(p_action,'')));cfg public.configuraciones_correos;unknown_tag text;
 allowed_tags text[]:=array['empresa_nombre','numero_solicitud','tipo_solicitud','fecha_solicitud','fecha_pago_programada','moneda','monto_total','beneficiario_nombre','concepto','solicitante_nombre','aprobador_nombre','fecha_inicio_aprobacion','fecha_limite_recordatorio','enlace_solicitud'];begin
 if auth.uid()is null or uid is null or sid is null or rid is null
 or not exists(select 1 from public.users where user_id=uid and is_active)
 or not exists(select 1 from public.user_roles where user_id=uid and role_id=rid)
 or not exists(select 1 from public.user_subsidiaries where user_id=uid and subsidiary_id=sid)then
  raise exception using errcode='42501',message='Debe iniciar sesión y seleccionar rol y empresa autorizados.';end if;
 if action_name not in('get','save')then raise exception using errcode='22023',message='Acción inválida.';end if;
 perform public.security_assert_role_access('configuration:notification-templates','view');
 if action_name='save'then
  perform public.security_assert_role_access('configuration:notification-templates','edit');
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or length(trim(coalesce(p_payload->>'subject','')))not between 1 and 200
   or coalesce(p_payload->>'subject','')~E'[\r\n]' or length(coalesce(p_payload->>'body',''))not between 1 and 20000
   or (p_payload?'active'and jsonb_typeof(p_payload->'active')<>'boolean')then raise exception using errcode='22023',message='Indique asunto, cuerpo y estado válidos.';end if;
  select x[1] into unknown_tag from regexp_matches((p_payload->>'subject')||' '||(p_payload->>'body'),'\{\{\s*([A-Za-z0-9_]+)\s*\}\}','g')x where not x[1]=any(allowed_tags)limit 1;
  if unknown_tag is not null then raise exception using errcode='22023',message='La plantilla contiene una variable no admitida.';end if;
 end if;
 perform payment_request_reminder_private.ensure_template(sid);
 if action_name='save'then update public.configuraciones_correos set asunto_template=trim(p_payload->>'subject'),cuerpo_template=p_payload->>'body',activo=coalesce((p_payload->>'active')::boolean,false),updated_by_email=(select email from public.users where user_id=uid),updated_at=clock_timestamp()
  where id_subsidiaria=sid and tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION';end if;
 select *into cfg from public.configuraciones_correos where id_subsidiaria=sid and tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION';
 return jsonb_build_object('template',to_jsonb(cfg),'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'utcOffsetMinutes',payment_request_reminder_private.offset_minutes(tz.utc_offset),'timezoneName',tz.name)from public.subsidiaries s left join public.timezones tz on tz.timezone_id=s.timezone_id where s.subsidiary_id=sid),
  'canEdit',public.security_resource_allowed('configuration:notification-templates','view')and public.security_resource_allowed('configuration:notification-templates','edit'),'variables',to_jsonb(allowed_tags));
end$$;

-- Parameterized equivalent of the existing approval_eligible/inbox rules. A
-- recipient must actually be assigned; unrelated administrators are not targets.
-- An explicitly assigned user can select any assigned role that grants reading.
create function payment_request_reminder_private.eligible_users(p_instance bigint,p_require_pending boolean default true)
returns table(user_id bigint,email text)language sql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
 select distinct u.user_id,u.email
 from public.wf_instances i join public.solicitudes_pago h on h.id=i.entity_id and h.id_subsidiaria=i.subsidiaria_id
 join public.wf_instance_steps st on st.instance_id=i.id and st.nivel=i.current_level
 join public.users u on (st.usuario_aprobador_id=u.user_id or (st.usuario_aprobador_id is null and st.rol_aprobador_id is not null))
 join public.user_subsidiaries us on us.user_id=u.user_id and us.subsidiary_id=i.subsidiaria_id
 join public.user_roles ur on ur.user_id=u.user_id
 join public.roles r on r.role_id=ur.role_id
 where i.id=p_instance and i.entity_type='PAYMENT_REQUEST' and i.status='EN_REVISION'
 and (not p_require_pending or h.estado='PENDIENTE_APROBACION') and st.status='PENDIENTE' and u.is_active
 and (st.usuario_aprobador_id=u.user_id or (st.usuario_aprobador_id is null and st.rol_aprobador_id=ur.role_id))
 and (lower(r.role_name)in('administrador','administrator','admin') or exists(
  select 1 from public.role_access_matrix access where access.role_id=ur.role_id and access.can_view
  and access.resource_key in('treasury:payment-requests','accounting:payment-requests')))
 and not exists(select 1 from public.wf_step_decisions d where d.step_id=st.id and d.usuario_id=u.user_id)
$$;

create function payment_request_reminder_private.sync_stage(p_instance bigint,p_now timestamptz default clock_timestamp())returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare i public.wf_instances;st public.wf_instance_steps;previous payment_request_reminder_private.current_stage;sig jsonb;is_active boolean;header_state text;begin
 perform pg_advisory_xact_lock(793154,(p_instance%2147483647)::integer);
 select *into i from public.wf_instances where id=p_instance;
 if i.id is null or i.entity_type<>'PAYMENT_REQUEST' then return;end if;
 select *into st from public.wf_instance_steps where instance_id=i.id and nivel=i.current_level;
 select estado into header_state from public.solicitudes_pago where id=i.entity_id and id_subsidiaria=i.subsidiaria_id;
 is_active:=coalesce(i.status='EN_REVISION' and st.id is not null and st.status='PENDIENTE' and header_state='PENDIENTE_APROBACION',false);
 sig:=jsonb_build_array(i.status,i.current_level,st.id,st.status,st.usuario_aprobador_id,st.rol_aprobador_id,st.politica,st.required_count,header_state);
 select *into previous from payment_request_reminder_private.current_stage where instance_id=i.id for update;
 if previous.instance_id is null then
  insert into payment_request_reminder_private.current_stage(instance_id,request_id,subsidiary_id,step_id,signature,assigned_at,active,next_collect_at,initial_approvers)
  values(i.id,i.entity_id,i.subsidiaria_id,st.id,sig,p_now,is_active,p_now,array(select user_id from payment_request_reminder_private.eligible_users(i.id,false)));
 elsif previous.signature is distinct from sig then
  update payment_request_reminder_private.current_stage set epoch=gen_random_uuid(),step_id=st.id,signature=sig,assigned_at=p_now,active=is_active,next_collect_at=p_now,last_error=null,template_was_disabled=false,initial_approvers=array(select user_id from payment_request_reminder_private.eligible_users(i.id,false)) where instance_id=i.id;
 end if;
 update public.payment_request_approval_reminder_email_outbox o set status='CANCELADO',last_error='La etapa o asignación de aprobación cambió.',finished_at=p_now
 where o.instance_id=i.id and o.status='PENDIENTE' and (not is_active or not exists(select 1 from payment_request_reminder_private.current_stage s where s.instance_id=i.id and s.epoch=o.stage_epoch));
end$$;

create function payment_request_reminder_private.workflow_event()returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare id_value bigint;begin
 if tg_table_name='wf_instances' then id_value:=new.id;
 elsif tg_table_name='wf_instance_steps' then id_value:=case when tg_op='DELETE' then old.instance_id else new.instance_id end;
 else select id into id_value from public.wf_instances where entity_type='PAYMENT_REQUEST' and entity_id=new.id order by id desc limit 1;end if;
 if id_value is not null then perform payment_request_reminder_private.sync_stage(id_value);end if;
 return null;
end$$;
create trigger payment_reminder_instance_event after insert or update of current_level,status on public.wf_instances for each row execute function payment_request_reminder_private.workflow_event();
create trigger payment_reminder_step_event after insert or delete or update of usuario_aprobador_id,rol_aprobador_id,nivel,status,politica,required_count on public.wf_instance_steps for each row execute function payment_request_reminder_private.workflow_event();
create trigger payment_reminder_request_event after update of estado,assigned_approver_id on public.solicitudes_pago for each row execute function payment_request_reminder_private.workflow_event();

-- Existing steps have no authoritative assignment-change timestamp. Start their
-- clocks at feature activation instead of guessing from request/future-step dates.
do $$declare i bigint;t timestamptz;begin
 select activated_at into t from payment_request_reminder_private.activation;
 for i in select id from public.wf_instances where entity_type='PAYMENT_REQUEST' and status='EN_REVISION' and current_level is not null loop
  perform payment_request_reminder_private.sync_stage(i,t);
 end loop;
end$$;

create function payment_request_reminder_private.job_current(p_job public.payment_request_approval_reminder_email_outbox)returns boolean
language sql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from payment_request_reminder_private.current_stage s
 join public.wf_instances i on i.id=s.instance_id and i.entity_type='PAYMENT_REQUEST' and i.entity_id=s.request_id and i.subsidiaria_id=s.subsidiary_id
 join public.wf_instance_steps st on st.id=s.step_id and st.instance_id=i.id and st.nivel=i.current_level
 join public.solicitudes_pago h on h.id=s.request_id and h.id_subsidiaria=s.subsidiary_id
 join public.subsidiaries company on company.subsidiary_id=s.subsidiary_id
 join public.timezones tz on tz.timezone_id=company.timezone_id
 join payment_request_reminder_private.eligible_users(i.id) u on u.user_id=p_job.approver_user_id
 where s.instance_id=p_job.instance_id and s.request_id=p_job.request_id and s.subsidiary_id=p_job.subsidiary_id
 and s.active and s.epoch=p_job.stage_epoch and st.id=p_job.approval_level_id and st.status='PENDIENTE'
 and i.status='EN_REVISION' and h.estado='PENDIENTE_APROBACION'
 and payment_request_reminder_private.safe_email(u.email)=p_job.recipient_email
 and payment_request_reminder_private.offset_minutes(tz.utc_offset)=(p_job.payload->>'companyUtcOffsetMinutes')::integer)
$$;

create function payment_request_reminder_private.collect_at(p_now timestamptz)returns integer
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare s payment_request_reminder_private.current_stage;u record;h public.solicitudes_pago;cfg public.configuraciones_correos;
 snap jsonb;recipient text;offset_value integer;zone_label text;start_value timestamptz;due_value timestamptz;assignment uuid;state_value text;count_value integer:=0;begin
 if not pg_try_advisory_xact_lock(793154,48) then return 0;end if;
 for s in select *from payment_request_reminder_private.current_stage where active and next_collect_at<=p_now order by next_collect_at,instance_id for update skip locked limit 500 loop
  update payment_request_reminder_private.current_stage set next_collect_at=p_now+interval '120 seconds' where instance_id=s.instance_id;
  -- Cancel stale queued recipients without redirecting their immutable snapshots.
  update public.payment_request_approval_reminder_email_outbox o set status='CANCELADO',finished_at=p_now,last_error='El destinatario o la autorización ya no están vigentes.'
  where o.instance_id=s.instance_id and o.status='PENDIENTE' and not payment_request_reminder_private.job_current(o);
  update public.payment_request_approval_reminder_email_outbox o set status='CANCELADO',finished_at=p_now,last_error='La configuración fue corregida; la nueva asignación comenzará otro plazo.'
  where o.instance_id=s.instance_id and o.stage_epoch=s.epoch and (
   (o.status='OMITIDO' and exists(select 1 from public.configuraciones_correos where id_subsidiaria=s.subsidiary_id and tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION' and activo))
   or(o.status='ERROR_SIN_CORREO' and exists(select 1 from payment_request_reminder_private.eligible_users(s.instance_id) eu where eu.user_id=o.approver_user_id and payment_request_reminder_private.safe_email(eu.email)is not null)));
  select *into h from public.solicitudes_pago where id=s.request_id and id_subsidiaria=s.subsidiary_id and estado='PENDIENTE_APROBACION';
  if h.id is null then continue;end if;
  select payment_request_reminder_private.offset_minutes(tz.utc_offset),tz.name into offset_value,zone_label
  from public.subsidiaries company left join public.timezones tz on tz.timezone_id=company.timezone_id where company.subsidiary_id=s.subsidiary_id;
  if offset_value is null then update payment_request_reminder_private.current_stage set last_error='La empresa no tiene un desplazamiento UTC válido; no se enviará sin zona verificable.' where instance_id=s.instance_id;continue;end if;
  update payment_request_reminder_private.current_stage set last_error=null where instance_id=s.instance_id;
  perform payment_request_reminder_private.ensure_template(s.subsidiary_id);
  select *into cfg from public.configuraciones_correos where id_subsidiaria=s.subsidiary_id and tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION';
  if not cfg.activo then update payment_request_reminder_private.current_stage set template_was_disabled=true where instance_id=s.instance_id;continue;end if;
  for u in select *from payment_request_reminder_private.eligible_users(s.instance_id) loop
   if exists(select 1 from public.payment_request_approval_reminder_email_outbox where stage_epoch=s.epoch and approver_user_id=u.user_id and status<>'CANCELADO')then continue;end if;
   -- Recovered eligibility/address is a new binding, never an immediate resend.
   start_value:=case when s.template_was_disabled or s.last_error is not null or not u.user_id=any(s.initial_approvers) or exists(select 1 from public.payment_request_approval_reminder_email_outbox where stage_epoch=s.epoch and approver_user_id=u.user_id)then p_now else s.assigned_at end;
   due_value:=payment_request_reminder_private.deadline(start_value,offset_value);assignment:=gen_random_uuid();
   recipient:=payment_request_reminder_private.safe_email(u.email);
   state_value:=case when not cfg.activo then 'OMITIDO' when recipient is null then 'ERROR_SIN_CORREO' else 'PENDIENTE' end;
   select jsonb_build_object('requestId',h.id,'subsidiaryId',h.id_subsidiaria,'instanceId',s.instance_id,'approvalVersion',h.version,
    'approvalLevelId',s.step_id,'approverUserId',u.user_id,'assignmentId',assignment,'reminderCycle','assignment:'||assignment,
    'companyUtcOffsetMinutes',offset_value,'empresa_zona_horaria',zone_label,
    'empresa_nombre',company.name,'numero_solicitud',h.numero,'tipo_solicitud',h.tipo_solicitud,'fecha_solicitud',h.fecha_solicitud,'fecha_pago_programada',h.fecha_pago_programada,
    'moneda',currency.currency_code,'monto_total',h.total::text,'concepto',h.concepto,
    'beneficiario_nombre',coalesce(nullif(vendor.company_name,''),parties.names,'Sin beneficiario'),
    'solicitante_nombre',coalesce(nullif(trim(concat_ws(' ',requester.first_name,requester.last_name)),''),requester.email,''),
    'aprobador_nombre',coalesce(nullif(trim(concat_ws(' ',approver.first_name,approver.last_name)),''),approver.email,''),
    'fecha_inicio_aprobacion',start_value,'fecha_limite_recordatorio',due_value,
    'enlace_solicitud','/payment-requests.html?id='||h.id||'&company='||h.id_subsidiaria)into snap
   from public.subsidiaries company join public.currencies currency on currency.currency_id=h.id_moneda
   left join public.users requester on requester.user_id=h.id_solicitante left join public.users approver on approver.user_id=u.user_id
   left join public.suppliers vendor on vendor.supplier_id=h.id_proveedor
   left join lateral(select string_agg(distinct name,', 'order by name)names from(
    select case l.tipo_tercero when 'Cliente' then customer.company_name when 'Proveedor' then supplier.company_name when 'Empleado' then nullif(trim(concat_ws(' ',employee.first_name,employee.last_name)),'') when 'Agencia Tributaria' then agency.agency_name when 'Otro Nombre' then other_name.name end name
    from public.solicitudes_pago_lineas l left join public.customers customer on customer.customer_id=l.id_cliente left join public.suppliers supplier on supplier.supplier_id=l.id_proveedor
    left join public.employees employee on employee.employee_id=l.id_empleado left join public.tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria left join public.other_names other_name on other_name.other_name_id=l.id_otro_nombre where l.id_solicitud=h.id
   )names)parties on true where company.subsidiary_id=h.id_subsidiaria;
   insert into public.payment_request_approval_reminder_email_outbox(assignment_id,request_id,subsidiary_id,instance_id,approval_version,approval_level_id,approver_user_id,stage_epoch,reminder_cycle,assigned_at,due_at,recipient_email,subject_template,body_template,payload,status,next_attempt_at,last_error,finished_at)
   values(assignment,h.id,h.id_subsidiaria,s.instance_id,h.version,s.step_id,u.user_id,s.epoch,'assignment:'||assignment,start_value,due_value,recipient,cfg.asunto_template,cfg.cuerpo_template,snap,state_value,due_value,
    case state_value when 'OMITIDO' then 'La plantilla está desactivada para esta empresa.' when 'ERROR_SIN_CORREO' then 'El aprobador no tiene un correo válido.' end,case when state_value<>'PENDIENTE' then p_now end)
   on conflict do nothing;
   if found then count_value:=count_value+1;end if;
  end loop;
  update payment_request_reminder_private.current_stage set template_was_disabled=false where instance_id=s.instance_id;
 end loop;
 return count_value;
end$$;

create function public.payment_request_approval_reminder_email_collect()returns integer
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform payment_request_reminder_private.service_only();return payment_request_reminder_private.collect_at(clock_timestamp());
end$$;

create function payment_request_reminder_private.claim_at(p_now timestamptz)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare job public.payment_request_approval_reminder_email_outbox;next_valid timestamptz;cfg public.configuraciones_correos;begin
 update public.payment_request_approval_reminder_email_outbox set status='INCIERTO',last_error='El envío se interrumpió; no se reintentará automáticamente para evitar duplicados.',finished_at=p_now,lease=null,lease_until=null where status='ENVIANDO' and lease_until<=p_now;
 loop
  select *into job from public.payment_request_approval_reminder_email_outbox where status='PENDIENTE' and next_attempt_at<=p_now order by next_attempt_at,created_at,id for update skip locked limit 1;
  if job.id is null then return null;end if;
  if not payment_request_reminder_private.job_current(job) then
   update public.payment_request_approval_reminder_email_outbox set status='CANCELADO',last_error='La solicitud, etapa, asignación o autorización ya no están vigentes.',finished_at=p_now where id=job.id;continue;end if;
  select *into cfg from public.configuraciones_correos where id_subsidiaria=job.subsidiary_id and tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION' and activo;
  if cfg.id is null then
   update public.payment_request_approval_reminder_email_outbox set status='OMITIDO',last_error='La plantilla fue desactivada antes del envío.',finished_at=p_now where id=job.id;continue;end if;
  next_valid:=payment_request_reminder_private.next_weekday(p_now,(job.payload->>'companyUtcOffsetMinutes')::integer);
  if next_valid>p_now then update public.payment_request_approval_reminder_email_outbox set next_attempt_at=next_valid where id=job.id;continue;end if;
  update public.payment_request_approval_reminder_email_outbox set status='ENVIANDO',attempts=attempts+1,lease=gen_random_uuid(),lease_until=p_now+interval '5 minutes',started_at=p_now,finished_at=null,last_error=null,subject_template=cfg.asunto_template,body_template=cfg.cuerpo_template where id=job.id returning *into job;
  return to_jsonb(job);
 end loop;
end$$;
create function public.payment_request_approval_reminder_email_claim()returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 perform payment_request_reminder_private.service_only();return payment_request_reminder_private.claim_at(clock_timestamp());
end$$;

create function public.payment_request_approval_reminder_email_authorize(p_id uuid,p_lease uuid)returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare job public.payment_request_approval_reminder_email_outbox;t timestamptz:=clock_timestamp();next_valid timestamptz;cfg public.configuraciones_correos;begin
 perform payment_request_reminder_private.service_only();
 select *into job from public.payment_request_approval_reminder_email_outbox where id=p_id and lease=p_lease and status='ENVIANDO' and lease_until>clock_timestamp() for update;
 if job.id is null then return false;end if;
 if not payment_request_reminder_private.job_current(job) then update public.payment_request_approval_reminder_email_outbox set status='CANCELADO',last_error='La autorización cambió antes del envío.',finished_at=clock_timestamp(),lease=null,lease_until=null where id=job.id;return false;end if;
 select *into cfg from public.configuraciones_correos where id_subsidiaria=job.subsidiary_id and tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION' and activo;
 if cfg.id is null then update public.payment_request_approval_reminder_email_outbox set status='OMITIDO',finished_at=t,lease=null,lease_until=null where id=job.id;return false;end if;
 -- Message edits are not new approval assignments: refresh on the next claim,
 -- retain the same id/epoch/deadline, and prove again before SMTP.
 if job.subject_template is distinct from cfg.asunto_template or job.body_template is distinct from cfg.cuerpo_template then
  update public.payment_request_approval_reminder_email_outbox set status='PENDIENTE',next_attempt_at=t,attempts=greatest(0,attempts-1),lease=null,lease_until=null,last_error='La plantilla cambió antes del envío; se volverá a preparar el mensaje.'where id=job.id;
  return false;
 end if;
 next_valid:=payment_request_reminder_private.next_weekday(t,(job.payload->>'companyUtcOffsetMinutes')::integer);
 if next_valid>t then
  update public.payment_request_approval_reminder_email_outbox set status='PENDIENTE',next_attempt_at=next_valid,attempts=greatest(0,attempts-1),lease=null,lease_until=null,last_error='El envío se pospuso al siguiente día hábil.'where id=job.id;
  return false;
 end if;return true;
end$$;

create function public.payment_request_approval_reminder_email_finish(p_id uuid,p_lease uuid,p_status text,p_message_id text default null,p_error text default null)returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare job public.payment_request_approval_reminder_email_outbox;t timestamptz:=clock_timestamp();begin
 perform payment_request_reminder_private.service_only();
 if p_status is null or p_status not in('ENVIADO','ERROR','INCIERTO','REINTENTO')then raise exception using errcode='22023',message='Estado de finalización inválido.';end if;
 select *into job from public.payment_request_approval_reminder_email_outbox where id=p_id and lease=p_lease and status='ENVIANDO' and lease_until>t for update;
 if job.id is null then return false;end if;
 if p_status='REINTENTO' then
  update public.payment_request_approval_reminder_email_outbox set status=case when attempts<3 then 'PENDIENTE' else 'ERROR' end,finished_at=case when attempts>=3 then t end,
   next_attempt_at=payment_request_reminder_private.next_weekday(t+case when attempts=1 then interval '1 minute' else interval '5 minutes' end,(payload->>'companyUtcOffsetMinutes')::integer),last_error=left(coalesce(nullif(p_error,''),'Fallo SMTP temporal.'),1000),lease=null,lease_until=null where id=p_id;
 else
  update public.payment_request_approval_reminder_email_outbox set status=p_status,sent_at=case when p_status='ENVIADO' then t else sent_at end,finished_at=t,
   message_id=case when p_status='ENVIADO' then left(nullif(p_message_id,''),500) else message_id end,last_error=case when p_status='ENVIADO' then null else left(nullif(p_error,''),1000) end,lease=null,lease_until=null where id=p_id;
 end if;return true;
end$$;

revoke all on all functions in schema payment_request_reminder_private from public,anon,authenticated,service_role;
revoke all on function public.payment_request_approval_reminder_email_settings(text,jsonb)from public,anon,authenticated,service_role;
grant execute on function public.payment_request_approval_reminder_email_settings(text,jsonb)to authenticated;
revoke all on function public.payment_request_approval_reminder_email_collect(),public.payment_request_approval_reminder_email_claim(),public.payment_request_approval_reminder_email_authorize(uuid,uuid),public.payment_request_approval_reminder_email_finish(uuid,uuid,text,text,text)from public,anon,authenticated,service_role;
grant execute on function public.payment_request_approval_reminder_email_collect(),public.payment_request_approval_reminder_email_claim(),public.payment_request_approval_reminder_email_authorize(uuid,uuid),public.payment_request_approval_reminder_email_finish(uuid,uuid,text,text,text)to service_role;
notify pgrst,'reload schema';
