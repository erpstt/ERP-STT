-- Future final approvals only. This migration never queues historical requests.
set local lock_timeout='5s';
set local statement_timeout='60s';

create function company_master_private.treasury_email_value(p text)returns text
language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $normalize$
declare value text;parts text[];
begin
 if p is null then return null;end if;
 if p~'[[:cntrl:]]'then raise exception using errcode='22023',message='Correo electrónico de Tesorería inválido.';end if;
 value:=lower(btrim(p));if value=''then return null;end if;parts:=string_to_array(value,'@');
 if length(value)>254 or cardinality(parts)<>2 or length(parts[1])>64 or parts[1]=''or left(parts[1],1)='.'or right(parts[1],1)='.'or position('..'in parts[1])>0
  or value!~$mail$^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$$mail$then
  raise exception using errcode='22023',message='Correo electrónico de Tesorería inválido.';
 end if;
 return value;
end$normalize$;
revoke all on function company_master_private.treasury_email_value(text)from public,anon,authenticated,service_role;
alter table public.subsidiaries add column treasury_email text;
alter table public.subsidiaries add constraint subsidiaries_treasury_email_valid check(
 treasury_email is null or treasury_email is not distinct from company_master_private.treasury_email_value(treasury_email)
);
comment on column public.subsidiaries.treasury_email is 'Destinatario opcional de avisos de aprobación final de solicitudes de pago de esta empresa.';

-- Preserve the protected company writer, including its revision, role, scope,
-- structural restrictions, audit behavior, OID, owner, ACL and configuration.
do $company$
declare definition text;needle text;replacement text;target regprocedure;
begin
 target:='organization_master_private.meta(text)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))<>'e003b07494761359e98c3706dfaaaae1'then raise exception 'Reviewed organization metadata changed.';end if;
 definition:=pg_get_functiondef(target);needle:=$old$'logo_url','address','email','phone','administrative_approver'$old$;replacement:=$new$'logo_url','address','email','treasury_email','phone','administrative_approver'$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected subsidiary metadata field list.';end if;
 execute replace(definition,needle,replacement);
 target:='company_master_private.save(text,jsonb,bigint)'::regprocedure;
 if md5((select prosrc from pg_proc where oid=target))<>'15c1c39036cf5cb2c04fdba130aeb9e6'then raise exception 'Reviewed company writer changed.';end if;
 definition:=pg_get_functiondef(target);needle:=$old$foreach field in array c.fields loop$old$;
 replacement:=$new$if k='subsidiaries'and p?'treasury_email'then data:=data||jsonb_build_object('treasury_email',company_master_private.treasury_email_value(p->>'treasury_email'));end if;
 foreach field in array c.fields loop$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected company contact validation.';end if;
 execute replace(definition,needle,replacement);
end$company$;

alter table public.configuraciones_correos drop constraint configuraciones_correos_tipo_notificacion_check;
alter table public.configuraciones_correos add constraint configuraciones_correos_tipo_notificacion_check check(tipo_notificacion in(
 'PAGO_PROVEEDOR','ESTADO_CUENTA','FACTURA_VENTA','SOLICITUD_GASTO_APROBACION','USUARIO_INVITACION','USUARIO_RECUPERACION','SOLICITUD_PAGO_APROBADA'
));

create schema payment_request_approved_email_private;
revoke all on schema payment_request_approved_email_private from public,anon,authenticated,service_role;

create table public.payment_request_approved_email_outbox(
 id uuid primary key default gen_random_uuid(),
 request_id bigint not null,subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
 instance_id bigint not null,approval_version integer not null check(approval_version>0),approval_cycle text not null,
 recipient_email text,subject_template text not null,body_template text not null,payload jsonb not null,
 status text not null check(status in('PENDIENTE','ENVIANDO','ENVIADO','ERROR','INCIERTO','ERROR_SIN_CORREO','OMITIDO','CANCELADO')),
 attempts integer not null default 0 check(attempts>=0),lease uuid,lease_until timestamptz,started_at timestamptz,sent_at timestamptz,finished_at timestamptz,
 message_id text,last_error text,next_attempt_at timestamptz not null default now(),created_at timestamptz not null default now(),
 unique(request_id,approval_cycle),
 check(approval_cycle='wf:'||instance_id),
 check(status<>'ENVIANDO'or(lease is not null and lease_until is not null))
);
create index payment_request_approved_email_pending_idx on public.payment_request_approved_email_outbox(next_attempt_at,created_at,id)where status='PENDIENTE';
create index payment_request_approved_email_lease_idx on public.payment_request_approved_email_outbox(lease_until)where status='ENVIANDO';
create index payment_request_approved_email_request_idx on public.payment_request_approved_email_outbox(subsidiary_id,request_id,created_at desc);
alter table public.payment_request_approved_email_outbox enable row level security;
alter table public.payment_request_approved_email_outbox force row level security;
revoke all on public.payment_request_approved_email_outbox from public,anon,authenticated,service_role;

create function payment_request_approved_email_private.ensure_template(p_sid bigint)returns void
language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 insert into public.configuraciones_correos(id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email)
 values(p_sid,'SOLICITUD_PAGO_APROBADA','Solicitud de pago {{numero_solicitud}} aprobada para Tesorería · {{empresa_nombre}}',
 '<p>La solicitud de pago <strong>{{numero_solicitud}}</strong> completó su aprobación y está lista para aplicar o ejecutar el pago en Tesorería.</p><p>Consulte su estado actual en GENTIA antes de ejecutar el pago.</p>',true,'sistema')
 on conflict(id_subsidiaria,tipo_notificacion)do nothing
$$;

create function public.payment_request_approved_email_settings(p_action text,p_payload jsonb default'{}')returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();uid bigint:=public.app_user_id();rid bigint:=public.app_active_role_id();action_name text:=lower(trim(coalesce(p_action,'')));cfg public.configuraciones_correos;unknown_tag text;can_edit boolean;
begin
 if auth.uid()is null or uid is null or rid is null or sid is null
  or not exists(select 1 from public.users where user_id=uid and is_active)
  or not exists(select 1 from public.user_roles where user_id=uid and role_id=rid)
  or not exists(select 1 from public.user_subsidiaries where user_id=uid and subsidiary_id=sid)then raise exception using errcode='42501',message='Seleccione usuario, rol y empresa autorizados.';end if;
 if action_name not in('get','save')then raise exception using errcode='22023',message='Acción de plantilla inválida.';end if;
 perform public.security_assert_role_access('configuration:notification-templates','view');
 if action_name='save'then
  perform public.security_assert_role_access('configuration:notification-templates','edit');
  if jsonb_typeof(p_payload)is distinct from'object'or length(trim(coalesce(p_payload->>'subject','')))not between 1 and 200
   or coalesce(p_payload->>'subject','')~E'[\r\n]'or length(coalesce(p_payload->>'body',''))not between 1 and 20000
   or(p_payload?'active'and jsonb_typeof(p_payload->'active')is distinct from'boolean')then raise exception using errcode='22023',message='Plantilla de correo inválida.';end if;
  select trim(m[1])into unknown_tag from regexp_matches((p_payload->>'subject')||E'\n'||(p_payload->>'body'),'\{\{[[:space:]]*([^{}]+?)[[:space:]]*\}\}','g')m
   where trim(m[1])<>all(array['empresa_nombre','numero_solicitud','tipo_solicitud','fecha_solicitud','fecha_pago_programada','moneda','monto_total','beneficiario_nombre','concepto','solicitante_nombre','aprobador_nombre','fecha_aprobacion','enlace_solicitud'])limit 1;
  if unknown_tag is not null then raise exception using errcode='22023',message='La plantilla contiene una variable no admitida.';end if;
 end if;
 perform payment_request_approved_email_private.ensure_template(sid);
 if action_name='save'then
  update public.configuraciones_correos set asunto_template=trim(p_payload->>'subject'),cuerpo_template=p_payload->>'body',activo=coalesce((p_payload->>'active')::boolean,false),updated_by_email=(select email from public.users where user_id=uid),updated_at=now()
   where id_subsidiaria=sid and tipo_notificacion='SOLICITUD_PAGO_APROBADA';
 end if;
 select *into cfg from public.configuraciones_correos where id_subsidiaria=sid and tipo_notificacion='SOLICITUD_PAGO_APROBADA';
 can_edit:=public.security_resource_allowed('configuration:notification-templates','view')and public.security_resource_allowed('configuration:notification-templates','edit');
 return jsonb_build_object('template',to_jsonb(cfg),'subsidiary',(select jsonb_build_object('id',subsidiary_id,'name',name,'treasuryEmail',treasury_email)from public.subsidiaries where subsidiary_id=sid),'canEdit',can_edit,
  'variables',jsonb_build_array('empresa_nombre','numero_solicitud','tipo_solicitud','fecha_solicitud','fecha_pago_programada','moneda','monto_total','beneficiario_nombre','concepto','solicitante_nombre','aprobador_nombre','fecha_aprobacion','enlace_solicitud'));
end$$;

create function payment_request_approved_email_private.final_event()returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare wi public.wf_instances;cfg public.configuraciones_correos;snap jsonb;recipient text;cycle text;st text;
begin
 if new.estado is not distinct from old.estado then return null;end if;
 if old.estado='APROBADO'and new.estado<>'APROBADO'then
  update public.payment_request_approved_email_outbox set status='CANCELADO',last_error='La solicitud dejó de estar aprobada y pendiente de pago.',finished_at=now()
   where request_id=new.id and subsidiary_id=new.id_subsidiaria and status in('PENDIENTE','ERROR','ERROR_SIN_CORREO','OMITIDO');
 end if;
 if new.estado<>'APROBADO'or new.aprobado_por is null or new.aprobado_at is null or new.version is null or new.version<=0 then return null;end if;
 select *into wi from public.wf_instances where entity_type='PAYMENT_REQUEST'and entity_id=new.id order by id desc limit 1;
 if wi.id is null or wi.subsidiaria_id<>new.id_subsidiaria or wi.status<>'APROBADO'or wi.current_level is not null
  or exists(select 1 from public.wf_instance_steps where instance_id=wi.id and status is distinct from'APROBADO')then return null;end if;
 cycle:='wf:'||wi.id;
 perform payment_request_approved_email_private.ensure_template(new.id_subsidiaria);
 select *into cfg from public.configuraciones_correos where id_subsidiaria=new.id_subsidiaria and tipo_notificacion='SOLICITUD_PAGO_APROBADA';
 select jsonb_build_object('requestId',h.id,'subsidiaryId',h.id_subsidiaria,'instanceId',wi.id,'approvalVersion',h.version,'approvalCycle',cycle,
  'empresa_nombre',s.name,'empresa_zona_horaria',(select name from public.timezones where timezone_id=s.timezone_id),'numero_solicitud',h.numero,'tipo_solicitud',h.tipo_solicitud,'fecha_solicitud',h.fecha_solicitud,'fecha_pago_programada',h.fecha_pago_programada,
  'moneda',c.currency_code,'monto_total',h.total,'total',h.total,'concepto',h.concepto,'fecha_aprobacion',h.aprobado_at,
  'beneficiario_nombre',coalesce(nullif(supplier.company_name,''),parties.names,'Sin beneficiario'),
  'solicitante_nombre',coalesce(nullif(trim(concat_ws(' ',requester.first_name,requester.last_name)),''),requester.email,''),
  'aprobador_nombre',coalesce(nullif(trim(concat_ws(' ',approver.first_name,approver.last_name)),''),approver.email,''),
  'enlace_solicitud','/payment-requests.html?id='||h.id||'&company='||h.id_subsidiaria,'deepLink','/payment-requests.html?id='||h.id||'&company='||h.id_subsidiaria),s.treasury_email
 into snap,recipient
 from public.solicitudes_pago h join public.subsidiaries s on s.subsidiary_id=h.id_subsidiaria join public.currencies c on c.currency_id=h.id_moneda
 left join public.users requester on requester.user_id=h.id_solicitante left join public.users approver on approver.user_id=h.aprobado_por left join public.suppliers supplier on supplier.supplier_id=h.id_proveedor
 left join lateral(
  select string_agg(distinct name,', 'order by name)names from(
   select case l.tipo_tercero when'Cliente'then customer.company_name when'Proveedor'then vendor.company_name when'Empleado'then nullif(trim(concat_ws(' ',employee.first_name,employee.last_name)),'')when'Agencia Tributaria'then agency.agency_name when'Otro Nombre'then other_name.name end name
   from public.solicitudes_pago_lineas l left join public.customers customer on customer.customer_id=l.id_cliente left join public.suppliers vendor on vendor.supplier_id=l.id_proveedor
   left join public.employees employee on employee.employee_id=l.id_empleado left join public.tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria left join public.other_names other_name on other_name.other_name_id=l.id_otro_nombre
   where l.id_solicitud=h.id
  )names
 )parties on true where h.id=new.id and h.id_subsidiaria=new.id_subsidiaria;
 st:=case when not cfg.activo then'OMITIDO'when coalesce(recipient,'')!~'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'or length(recipient)>254 then'ERROR_SIN_CORREO'else'PENDIENTE'end;
 insert into public.payment_request_approved_email_outbox(request_id,subsidiary_id,instance_id,approval_version,approval_cycle,recipient_email,subject_template,body_template,payload,status,last_error,finished_at)
 values(new.id,new.id_subsidiaria,wi.id,new.version,cycle,recipient,cfg.asunto_template,cfg.cuerpo_template,snap,st,
  case st when'OMITIDO'then'La plantilla está desactivada para esta empresa.'when'ERROR_SIN_CORREO'then'La empresa no tiene un correo de Tesorería válido.'end,
  case when st in('OMITIDO','ERROR_SIN_CORREO')then now()end)
 on conflict(request_id,approval_cycle)do nothing;
 return null;
end$$;
-- The existing deferred payment_request_email_event (actual supplier payments)
-- remains untouched. This separate trigger only observes future state changes.
create trigger payment_request_final_approved_treasury_email_event after update of estado on public.solicitudes_pago
for each row execute function payment_request_approved_email_private.final_event();

create function public.payment_request_approved_email_claim()returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare job public.payment_request_approved_email_outbox;token uuid;
begin
 if coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role'then raise exception using errcode='42501',message='Operación exclusiva del servicio de notificaciones.';end if;
 update public.payment_request_approved_email_outbox set status='INCIERTO',last_error='El envío se interrumpió; no se reintentará automáticamente para evitar duplicados.',finished_at=now(),lease=null,lease_until=null where status='ENVIANDO'and lease_until<=now();
 loop
  select *into job from public.payment_request_approved_email_outbox where status='PENDIENTE'and next_attempt_at<=now()order by next_attempt_at,created_at,id for update skip locked limit 1;
  if job.id is null then return null;end if;
  if not exists(select 1 from public.solicitudes_pago h where h.id=job.request_id and h.id_subsidiaria=job.subsidiary_id and h.estado='APROBADO'and h.aprobado_at=(job.payload->>'fecha_aprobacion')::timestamptz
    and h.aprobado_por is not null and exists(select 1 from public.wf_instances wi where wi.id=job.instance_id and wi.entity_type='PAYMENT_REQUEST'and wi.entity_id=h.id and wi.subsidiaria_id=h.id_subsidiaria and wi.status='APROBADO'and wi.current_level is null and not exists(select 1 from public.wf_instance_steps where instance_id=wi.id and status is distinct from'APROBADO')))then
   update public.payment_request_approved_email_outbox set status='CANCELADO',last_error='La aprobación ya no está vigente o la solicitud ya fue aplicada o anulada.',finished_at=now()where id=job.id;continue;
  end if;
  if not exists(select 1 from public.configuraciones_correos where id_subsidiaria=job.subsidiary_id and tipo_notificacion='SOLICITUD_PAGO_APROBADA'and activo)then
   update public.payment_request_approved_email_outbox set status='OMITIDO',last_error='La plantilla fue desactivada antes del envío.',finished_at=now()where id=job.id;continue;
  end if;
  -- A changed address never redirects a queued financial snapshot. The old
  -- recipient is invalidated, and no new historical notification is created.
  if not exists(select 1 from public.subsidiaries where subsidiary_id=job.subsidiary_id and treasury_email=job.recipient_email)
   or coalesce(job.recipient_email,'')!~'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'or length(job.recipient_email)>254 then
   update public.payment_request_approved_email_outbox set status='ERROR_SIN_CORREO',last_error='El correo de Tesorería cambió o ya no es válido.',finished_at=now()where id=job.id;continue;
  end if;
  token:=gen_random_uuid();
  update public.payment_request_approved_email_outbox set status='ENVIANDO',attempts=attempts+1,lease=token,lease_until=now()+interval'5 minutes',started_at=now(),finished_at=null,last_error=null where id=job.id and status='PENDIENTE'returning *into job;
  if job.id is not null then return to_jsonb(job);end if;
 end loop;
end$$;

create function public.payment_request_approved_email_finish(p_id uuid,p_lease uuid,p_status text,p_message_id text default null,p_error text default null)returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role'then raise exception using errcode='42501',message='Operación exclusiva del servicio de notificaciones.';end if;
 if p_status is null or p_status not in('ENVIADO','ERROR','INCIERTO','REINTENTO')then raise exception using errcode='22023',message='Estado de finalización inválido.';end if;
 if p_status='REINTENTO'then
  update public.payment_request_approved_email_outbox set status=case when attempts<3 then'PENDIENTE'else'ERROR'end,finished_at=case when attempts<3 then null else now()end,
   next_attempt_at=case when attempts=1 then now()+interval'1 minute'when attempts=2 then now()+interval'5 minutes'else next_attempt_at end,last_error=left(coalesce(nullif(p_error,''),'Fallo SMTP temporal.'),1000),lease=null,lease_until=null
   where id=p_id and lease=p_lease and status='ENVIANDO'and lease_until>now();return found;
 end if;
 update public.payment_request_approved_email_outbox set status=p_status,sent_at=case when p_status='ENVIADO'then now()else sent_at end,finished_at=now(),message_id=case when p_status='ENVIADO'then left(nullif(p_message_id,''),500)else message_id end,
  last_error=case when p_status='ENVIADO'then null else left(nullif(p_error,''),1000)end,lease=null,lease_until=null
  where id=p_id and lease=p_lease and status='ENVIANDO'and lease_until>now();return found;
end$$;

revoke all on all functions in schema payment_request_approved_email_private from public,anon,authenticated,service_role;
revoke all on function public.payment_request_approved_email_settings(text,jsonb),public.payment_request_approved_email_claim(),public.payment_request_approved_email_finish(uuid,uuid,text,text,text)from public,anon,authenticated,service_role;
grant execute on function public.payment_request_approved_email_settings(text,jsonb)to authenticated;
grant execute on function public.payment_request_approved_email_claim(),public.payment_request_approved_email_finish(uuid,uuid,text,text,text)to service_role;
notify pgrst,'reload schema';
