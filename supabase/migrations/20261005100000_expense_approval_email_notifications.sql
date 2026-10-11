begin;

-- Editable notification template used only when an OTROS payment request enters
-- a new approval level. Existing workflow instances are intentionally not
-- backfilled, so applying this migration never sends historical notifications.
alter table public.configuraciones_correos
  drop constraint if exists configuraciones_correos_tipo_notificacion_check;

alter table public.configuraciones_correos
  add constraint configuraciones_correos_tipo_notificacion_check
  check(tipo_notificacion in (
    'PAGO_PROVEEDOR',
    'ESTADO_CUENTA',
    'FACTURA_VENTA',
    'SOLICITUD_GASTO_APROBACION'
  ));

insert into public.configuraciones_correos(
  id_subsidiaria,
  tipo_notificacion,
  asunto_template,
  cuerpo_template,
  activo,
  updated_by_email
)
select
  s.subsidiary_id,
  'SOLICITUD_GASTO_APROBACION',
  'Solicitud de gasto {{numero_solicitud}} pendiente de aprobación · {{empresa_nombre}}',
  '<p>Hola <strong>{{aprobador_nombre}}</strong>,</p><p>Tiene la solicitud de gasto <strong>{{numero_solicitud}}</strong> pendiente de revisión y aprobación.</p><p>Revise el concepto, las imputaciones y los archivos de respaldo antes de tomar una decisión.</p>',
  true,
  'sistema'
from public.subsidiaries s
on conflict(id_subsidiaria,tipo_notificacion) do nothing;

-- This outbox is deliberately independent from wf_email_outbox: it stores an
-- immutable business snapshot and has an SMTP-safe lease lifecycle.
create table if not exists public.expense_approval_email_outbox(
  id uuid primary key default gen_random_uuid(),
  instance_id bigint not null,
  step_id bigint not null,
  approval_level integer not null check(approval_level>0),
  request_id bigint not null,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id),
  recipient_user_id bigint not null references public.users(user_id),
  recipient_email text,
  subject_template text not null,
  body_template text not null,
  deep_link text not null,
  payload jsonb not null,
  status text not null default 'PENDIENTE' check(status in (
    'PENDIENTE','ENVIANDO','ENVIADO','ERROR','INCIERTO',
    'ERROR_SIN_CORREO','OMITIDO','CANCELADO'
  )),
  attempts integer not null default 0 check(attempts>=0),
  lease uuid,
  lease_until timestamptz,
  started_at timestamptz,
  sent_at timestamptz,
  finished_at timestamptz,
  message_id text,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(step_id,recipient_user_id),
  check(
    (status='ENVIANDO' and lease is not null and lease_until is not null)
    or
    (status<>'ENVIANDO')
  )
);

-- Keep reruns compatible with databases where the first version of this
-- migration was already installed before bounded retries were introduced.
alter table public.expense_approval_email_outbox
  add column if not exists next_attempt_at timestamptz not null default now();

drop index if exists public.expense_approval_email_queue_idx;
create index if not exists expense_approval_email_queue_idx
  on public.expense_approval_email_outbox(next_attempt_at,created_at,id)
  where status='PENDIENTE';
create index if not exists expense_approval_email_request_idx
  on public.expense_approval_email_outbox(subsidiary_id,request_id,created_at desc);
create index if not exists expense_approval_email_lease_idx
  on public.expense_approval_email_outbox(lease_until)
  where status='ENVIANDO';

alter table public.expense_approval_email_outbox enable row level security;
alter table public.expense_approval_email_outbox force row level security;
revoke all on public.expense_approval_email_outbox from public,anon,authenticated;

create or replace function public.expense_approval_email_ensure_template(p_subsidiary_id bigint)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if p_subsidiary_id is null or not exists(
    select 1 from public.subsidiaries where subsidiary_id=p_subsidiary_id
  ) then
    return;
  end if;

  insert into public.configuraciones_correos(
    id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
  ) values(
    p_subsidiary_id,
    'SOLICITUD_GASTO_APROBACION',
    'Solicitud de gasto {{numero_solicitud}} pendiente de aprobación · {{empresa_nombre}}',
    '<p>Hola <strong>{{aprobador_nombre}}</strong>,</p><p>Tiene la solicitud de gasto <strong>{{numero_solicitud}}</strong> pendiente de revisión y aprobación.</p><p>Revise el concepto, las imputaciones y los archivos de respaldo antes de tomar una decisión.</p>',
    true,
    'sistema'
  ) on conflict(id_subsidiaria,tipo_notificacion) do nothing;
end
$$;

create or replace function public.expense_approval_email_snapshot(
  p_instance_id bigint,
  p_step_id bigint,
  p_recipient_user_id bigint
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'instanceId',wi.id,
    'stepId',ws.id,
    'approvalLevel',ws.nivel,
    'approvalLevelName',ws.nombre_nivel,
    'requestId',h.id,
    'subsidiaryId',h.id_subsidiaria,
    'empresa_nombre',s.name,
    'empresa_logo_url',s.logo_url,
    'approverId',approver.user_id,
    'aprobador_nombre',coalesce(
      nullif(trim(concat_ws(' ',approver.first_name,approver.last_name)),''),
      approver.email
    ),
    'aprobador_correo',approver.email,
    'requesterId',requester.user_id,
    'solicitante_nombre',coalesce(
      nullif(trim(concat_ws(' ',requester.first_name,requester.last_name)),''),
      requester.email
    ),
    'solicitante_correo',requester.email,
    'numero_solicitud',h.numero,
    'fecha_solicitud',h.fecha_solicitud,
    'fecha_pago_programada',h.fecha_pago_programada,
    'moneda',currency.currency_code,
    'simbolo_moneda',currency.symbol,
    'total',h.total,
    'concepto',coalesce(h.concepto,''),
    'departamentos',coalesce(dimensions.departments,'[]'::jsonb),
    'departamentos_texto',coalesce(dimensions.department_names,'Sin departamento'),
    'centros_costos',coalesce(dimensions.cost_centers,'[]'::jsonb),
    'centros_costos_texto',coalesce(dimensions.cost_center_names,'Sin centro de costos'),
    'lineas',coalesce(lines.items,'[]'::jsonb),
    'enlace_solicitud','/payment-requests.html?id='||h.id||'&company='||h.id_subsidiaria,
    'deepLink','/payment-requests.html?id='||h.id||'&company='||h.id_subsidiaria
  ) into result
  from public.wf_instances wi
  join public.wf_instance_steps ws
    on ws.instance_id=wi.id and ws.id=p_step_id
  join public.solicitudes_pago h
    on h.id=wi.entity_id and h.id_subsidiaria=wi.subsidiaria_id
  join public.subsidiaries s on s.subsidiary_id=h.id_subsidiaria
  join public.currencies currency on currency.currency_id=h.id_moneda
  join public.users requester on requester.user_id=h.id_solicitante
  join public.users approver on approver.user_id=p_recipient_user_id
  left join lateral(
    select
      jsonb_agg(jsonb_build_object(
        'id',line_data.line_id,
        'cuenta',line_data.account_label,
        'tercero',line_data.party_name,
        'departamento',line_data.department_name,
        'centroCosto',line_data.cost_center_name,
        'concepto',line_data.line_concept,
        'monto',line_data.line_amount
      ) order by line_data.line_id) items
    from(
      select
        l.id line_id,
        nullif(trim(concat_ws(' · ',account.account_number,account.account_name)),'') account_label,
        coalesce(customer.company_name,supplier.company_name,
          nullif(trim(concat_ws(' ',employee.first_name,employee.last_name)),''),'Sin tercero') party_name,
        department.name department_name,
        case when center.cost_center_id is null then null
          else concat_ws(' · ',nullif(center.code,''),center.name) end cost_center_name,
        coalesce(l.concepto,'') line_concept,
        l.monto line_amount
      from public.solicitudes_pago_lineas l
      left join public.chart_accounts account on account.account_id=l.id_cuenta_contable
      left join public.customers customer on customer.customer_id=l.id_cliente
      left join public.suppliers supplier on supplier.supplier_id=l.id_proveedor
      left join public.employees employee on employee.employee_id=l.id_empleado
      left join public.cost_centers center on center.cost_center_id=l.id_centro_costo
      left join public.customers center_customer on center_customer.customer_id=center.customer_id
      left join public.departments department on department.department_id=coalesce(
        employee.department_id,customer.department_id,center_customer.department_id
      )
      where l.id_solicitud=h.id
    ) line_data
  ) lines on true
  left join lateral(
    select
      jsonb_agg(jsonb_build_object('id',d.department_id,'name',d.name) order by d.name) departments,
      string_agg(d.name,', ' order by d.name) department_names,
      (
        select jsonb_agg(jsonb_build_object('id',cc.cost_center_id,'code',cc.code,'name',cc.name)
                         order by cc.code,cc.name)
        from(
          select distinct center.cost_center_id,center.code,center.name
          from public.solicitudes_pago_lineas l
          join public.cost_centers center on center.cost_center_id=l.id_centro_costo
          where l.id_solicitud=h.id
        ) cc
      ) cost_centers,
      (
        select string_agg(concat_ws(' · ',nullif(cc.code,''),cc.name),', ' order by cc.code,cc.name)
        from(
          select distinct center.cost_center_id,center.code,center.name
          from public.solicitudes_pago_lineas l
          join public.cost_centers center on center.cost_center_id=l.id_centro_costo
          where l.id_solicitud=h.id
        ) cc
      ) cost_center_names
    from(
      select distinct department.department_id,department.name
      from public.solicitudes_pago_lineas l
      left join public.customers customer on customer.customer_id=l.id_cliente
      left join public.employees employee on employee.employee_id=l.id_empleado
      left join public.cost_centers center on center.cost_center_id=l.id_centro_costo
      left join public.customers center_customer on center_customer.customer_id=center.customer_id
      join public.departments department on department.department_id=coalesce(
        employee.department_id,customer.department_id,center_customer.department_id
      )
      where l.id_solicitud=h.id
    ) d
  ) dimensions on true
  where wi.id=p_instance_id
    and wi.entity_type='PAYMENT_REQUEST'
    and h.tipo_solicitud='OTROS';

  return result;
end
$$;

create or replace function public.expense_approval_email_enqueue(
  p_instance_id bigint,
  p_step_id bigint,
  p_recipient_user_id bigint
) returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  snap jsonb;
  cfg public.configuraciones_correos%rowtype;
  recipient public.users%rowtype;
  sid bigint;
  next_status text;
  reason text;
  can_receive boolean;
begin
  snap:=public.expense_approval_email_snapshot(p_instance_id,p_step_id,p_recipient_user_id);
  if snap is null then
    return;
  end if;

  sid:=(snap->>'subsidiaryId')::bigint;
  perform public.expense_approval_email_ensure_template(sid);
  select * into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid
    and tipo_notificacion='SOLICITUD_GASTO_APROBACION';
  select * into recipient from public.users where user_id=p_recipient_user_id;

  can_receive:=recipient.user_id is not null
    and recipient.is_active
    and exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=p_recipient_user_id and access.subsidiary_id=sid
    );

  if not coalesce(cfg.activo,false) then
    next_status:='OMITIDO';
    reason:='La plantilla de aprobación de solicitudes de gasto está desactivada.';
  elsif not can_receive then
    next_status:='ERROR_SIN_CORREO';
    reason:='El aprobador está inactivo o no tiene acceso a la subsidiaria.';
  elsif coalesce(recipient.email,'') !~* '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then
    next_status:='ERROR_SIN_CORREO';
    reason:='El aprobador no tiene un correo electrónico válido.';
  else
    next_status:='PENDIENTE';
  end if;

  insert into public.expense_approval_email_outbox(
    instance_id,step_id,approval_level,request_id,subsidiary_id,
    recipient_user_id,recipient_email,subject_template,body_template,
    deep_link,payload,status,last_error,finished_at
  ) values(
    p_instance_id,
    p_step_id,
    (snap->>'approvalLevel')::integer,
    (snap->>'requestId')::bigint,
    sid,
    p_recipient_user_id,
    recipient.email,
    cfg.asunto_template,
    cfg.cuerpo_template,
    snap->>'deepLink',
    snap,
    next_status,
    reason,
    case when next_status in('OMITIDO','ERROR_SIN_CORREO') then now() end
  ) on conflict(step_id,recipient_user_id) do nothing;
end
$$;

create or replace function public.expense_approval_email_settings(
  p_action text,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
  sid bigint:=public.active_subsidiary_id();
  cfg public.configuraciones_correos%rowtype;
  action_name text:=lower(coalesce(p_action,''));
begin
  if uid is null or sid is null
    or not exists(
      select 1
      from public.users u
      join public.user_subsidiaries access on access.user_id=u.user_id
      where u.user_id=uid and u.is_active and access.subsidiary_id=sid
    ) then
    raise exception using errcode='42501',message='Debe iniciar sesión y seleccionar una subsidiaria autorizada.';
  end if;

  perform public.expense_approval_email_ensure_template(sid);

  if action_name='save' then
    if not public.app_is_admin() then
      raise exception using errcode='42501',message='Solo un administrador puede modificar esta plantilla.';
    end if;
    if length(trim(coalesce(p_payload->>'subject',''))) not between 1 and 200
      or coalesce(p_payload->>'subject','') ~ E'[\r\n]'
      or length(coalesce(p_payload->>'body','')) not between 1 and 20000 then
      raise exception 'La plantilla de correo no es válida.';
    end if;

    update public.configuraciones_correos
    set asunto_template=trim(p_payload->>'subject'),
        cuerpo_template=p_payload->>'body',
        activo=coalesce((p_payload->>'active')::boolean,false),
        updated_by_email=(select email from public.users where user_id=uid),
        updated_at=now()
    where id_subsidiaria=sid
      and tipo_notificacion='SOLICITUD_GASTO_APROBACION';
  elsif action_name<>'get' then
    raise exception 'Acción inválida.';
  end if;

  select * into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid
    and tipo_notificacion='SOLICITUD_GASTO_APROBACION';

  return jsonb_build_object(
    'template',to_jsonb(cfg),
    'subsidiary',(select jsonb_build_object('id',subsidiary_id,'name',name,'logo',logo_url)
                  from public.subsidiaries where subsidiary_id=sid),
    'canEdit',public.app_is_admin(),
    'variables',jsonb_build_array(
      'empresa_nombre','aprobador_nombre','solicitante_nombre','numero_solicitud',
      'tipo_solicitud','fecha_solicitud','fecha_pago_programada','moneda','monto_total',
      'concepto','departamentos','centros_costo','nivel_aprobacion',
      'enlace_solicitud'
    )
  );
end
$$;

-- A claim changes PENDIENTE to ENVIANDO before SMTP is contacted. If the
-- worker disappears after that point, lease expiry becomes INCIERTO and is
-- never retried automatically, avoiding duplicate approval emails.
create or replace function public.expense_approval_email_claim()
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  job public.expense_approval_email_outbox%rowtype;
  token uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception using errcode='42501',message='Operación exclusiva del servicio de notificaciones.';
  end if;

  update public.expense_approval_email_outbox
  set status='INCIERTO',
      last_error='El envío se interrumpió y no se reintentará automáticamente para evitar duplicados.',
      finished_at=now(),
      lease=null,
      lease_until=null
  where status='ENVIANDO' and lease_until<=now();

  loop
    select * into job
    from public.expense_approval_email_outbox
    where status='PENDIENTE' and next_attempt_at<=now()
    order by next_attempt_at,created_at,id
    for update skip locked
    limit 1;

    if job.id is null then
      return null;
    end if;

    if not exists(
      select 1 from public.configuraciones_correos cfg
      where cfg.id_subsidiaria=job.subsidiary_id
        and cfg.tipo_notificacion='SOLICITUD_GASTO_APROBACION'
        and cfg.activo
    ) then
      update public.expense_approval_email_outbox
      set status='OMITIDO',last_error='La plantilla fue desactivada antes del envío.',finished_at=now()
      where id=job.id;
      continue;
    end if;

    if not exists(
      select 1
      from public.users u
      join public.user_subsidiaries access on access.user_id=u.user_id
      where u.user_id=job.recipient_user_id
        and u.is_active
        and access.subsidiary_id=job.subsidiary_id
        and u.email=job.recipient_email
        and u.email ~* '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'
    ) then
      update public.expense_approval_email_outbox
      set status='ERROR_SIN_CORREO',
          last_error='El aprobador ya no está activo, no tiene acceso a la subsidiaria o su correo cambió.',
          finished_at=now()
      where id=job.id;
      continue;
    end if;

    if not exists(
      select 1
      from public.wf_instances wi
      join public.wf_instance_steps ws on ws.instance_id=wi.id
      join public.solicitudes_pago request on request.id=wi.entity_id
      where wi.id=job.instance_id
        and wi.entity_type='PAYMENT_REQUEST'
        and wi.entity_id=job.request_id
        and wi.subsidiaria_id=job.subsidiary_id
        and wi.status='EN_REVISION'
        and wi.current_level=job.approval_level
        and ws.id=job.step_id
        and ws.nivel=job.approval_level
        and ws.status='PENDIENTE'
        and (
          ws.usuario_aprobador_id=job.recipient_user_id
          or (
            ws.usuario_aprobador_id is null
            and ws.rol_aprobador_id is not null
            and exists(
              select 1 from public.user_roles current_membership
              where current_membership.user_id=job.recipient_user_id
                and current_membership.role_id=ws.rol_aprobador_id
            )
          )
        )
        and request.tipo_solicitud='OTROS'
        and request.estado='PENDIENTE_APROBACION'
        and not exists(
          select 1 from public.wf_step_decisions decision
          where decision.step_id=job.step_id
            and decision.usuario_id=job.recipient_user_id
        )
    ) then
      update public.expense_approval_email_outbox
      set status='CANCELADO',
          last_error='El nivel ya no está pendiente para este aprobador.',
          finished_at=now()
      where id=job.id;
      continue;
    end if;

    token:=gen_random_uuid();
    update public.expense_approval_email_outbox
    set status='ENVIANDO',
        attempts=attempts+1,
        lease=token,
        lease_until=now()+interval '5 minutes',
        started_at=now(),
        finished_at=null,
        last_error=null
    where id=job.id and status='PENDIENTE'
    returning * into job;

    if job.id is not null then
      return to_jsonb(job);
    end if;
  end loop;
end
$$;

create or replace function public.expense_approval_email_finish(
  p_id uuid,
  p_lease uuid,
  p_status text,
  p_message_id text default null,
  p_error text default null
) returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception using errcode='42501',message='Operación exclusiva del servicio de notificaciones.';
  end if;
  if p_status not in('ENVIADO','ERROR','INCIERTO','REINTENTO') then
    raise exception 'Estado de finalización inválido.';
  end if;

  if p_status='REINTENTO' then
    update public.expense_approval_email_outbox
    set status=case when attempts<3 then 'PENDIENTE' else 'ERROR' end,
        finished_at=case when attempts<3 then null else now() end,
        next_attempt_at=case
          when attempts=1 then now()+interval '1 minute'
          when attempts=2 then now()+interval '5 minutes'
          else next_attempt_at
        end,
        last_error=left(coalesce(nullif(p_error,''),'Fallo SMTP temporal.'),1000),
        lease=null,
        lease_until=null
    where id=p_id and lease=p_lease and status='ENVIANDO';

    return found;
  end if;

  update public.expense_approval_email_outbox
  set status=p_status,
      sent_at=case when p_status='ENVIADO' then now() else sent_at end,
      finished_at=now(),
      message_id=case when p_status='ENVIADO' then left(nullif(p_message_id,''),500) else message_id end,
      last_error=case when p_status='ENVIADO' then null else left(nullif(p_error,''),1000) end,
      next_attempt_at=case when p_status='ENVIADO' then next_attempt_at else now() end,
      lease=null,
      lease_until=null
  where id=p_id and lease=p_lease and status='ENVIANDO';

  return found;
end
$$;

-- Preserve the existing in-app notification for every supported workflow.
-- Expense requests use the durable, templated outbox; the other entity types
-- keep their existing generic wf_email_outbox behavior.
create or replace function public.wf_notify_level(p_instance bigint)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  st public.wf_instance_steps%rowtype;
  ins public.wf_instances%rowtype;
  entity jsonb;
  candidate record;
  title text;
  link text;
  is_expense_request boolean:=false;
  eligible boolean;
begin
  select * into ins from public.wf_instances where id=p_instance;
  if ins.id is null then return; end if;
  select * into st
  from public.wf_instance_steps
  where instance_id=p_instance and nivel=ins.current_level;
  if st.id is null then return; end if;

  entity:=public.wf_entity_data(ins.entity_type,ins.entity_id);
  title:='Aprobación pendiente · '||(entity->>'number');
  link:=entity->>'deepLink';
  is_expense_request:=ins.entity_type='PAYMENT_REQUEST' and exists(
    select 1 from public.solicitudes_pago request
    where request.id=ins.entity_id
      and request.id_subsidiaria=ins.subsidiaria_id
      and request.tipo_solicitud='OTROS'
  );

  for candidate in
    select distinct
      u.user_id,
      u.email,
      u.is_active,
      exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=u.user_id and access.subsidiary_id=ins.subsidiaria_id
      ) has_access
    from public.users u
    where(
      st.usuario_aprobador_id is not null
      and u.user_id=st.usuario_aprobador_id
    ) or(
      st.usuario_aprobador_id is null
      and st.rol_aprobador_id is not null
      and u.is_active
      and exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=u.user_id and access.subsidiary_id=ins.subsidiaria_id
      )
      and exists(
        select 1 from public.user_roles membership
        where membership.user_id=u.user_id and membership.role_id=st.rol_aprobador_id
      )
    )
  loop
    eligible:=candidate.is_active and candidate.has_access;

    if eligible and not exists(
      select 1 from public.wf_notifications notification
      where notification.usuario_id=candidate.user_id
        and notification.instance_id=ins.id
        and notification.deep_link=link
        and notification.titulo=title
        and notification.mensaje='Requiere su aprobación en el nivel '||st.nivel||': '||st.nombre_nivel
    ) then
      insert into public.wf_notifications(usuario_id,instance_id,titulo,mensaje,deep_link)
      values(
        candidate.user_id,
        ins.id,
        title,
        'Requiere su aprobación en el nivel '||st.nivel||': '||st.nombre_nivel,
        link
      );
    end if;

    if is_expense_request then
      -- Direct approvers are also snapshotted when inactive or without company
      -- access, yielding ERROR_SIN_CORREO instead of aborting the submission.
      perform public.expense_approval_email_enqueue(ins.id,st.id,candidate.user_id);
    elsif eligible then
      insert into public.wf_email_outbox(usuario_id,email,subject,body,deep_link)
      values(
        candidate.user_id,
        candidate.email,
        title,
        'Tiene un documento pendiente de aprobación en GENTIA.',
        link
      );
    end if;
  end loop;
end
$$;

revoke all on function public.expense_approval_email_ensure_template(bigint),
  public.expense_approval_email_snapshot(bigint,bigint,bigint),
  public.expense_approval_email_enqueue(bigint,bigint,bigint),
  public.expense_approval_email_settings(text,jsonb),
  public.expense_approval_email_claim(),
  public.expense_approval_email_finish(uuid,uuid,text,text,text),
  public.wf_notify_level(bigint)
from public,anon,authenticated;

grant execute on function public.expense_approval_email_settings(text,jsonb)
to authenticated;
grant execute on function public.expense_approval_email_claim(),
  public.expense_approval_email_finish(uuid,uuid,text,text,text)
to service_role;

notify pgrst,'reload schema';
commit;
