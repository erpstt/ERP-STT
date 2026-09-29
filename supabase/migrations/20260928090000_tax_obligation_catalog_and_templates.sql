-- Catálogo fiscal de obligaciones por país y plantillas de correo del calendario tributario.

create table public.tax_obligation_types(
  id uuid primary key default gen_random_uuid(),
  country_id bigint not null references public.countries(country_id) on delete restrict,
  code varchar(80) not null check(code=upper(trim(code)) and code~'^[A-Z0-9][A-Z0-9._%/-]{0,79}$'),
  name varchar(160) not null check(length(trim(name)) between 2 and 160),
  frequency text not null default 'monthly' check(frequency in('monthly','quarterly','annual','other')),
  description text check(description is null or length(description)<=1000),
  is_active boolean not null default true,
  created_by bigint references public.users(user_id) on delete set null,
  updated_by bigint references public.users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(country_id,code)
);

create table public.tax_calendar_email_templates(
  id uuid primary key default gen_random_uuid(),
  country_id bigint not null references public.countries(country_id) on delete cascade,
  kind text not null check(kind in('reminder','overdue')),
  subject_template varchar(200) not null check(length(trim(subject_template)) between 3 and 200),
  body_template text not null check(length(trim(body_template)) between 10 and 4000),
  is_active boolean not null default true,
  created_by bigint references public.users(user_id) on delete set null,
  updated_by bigint references public.users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(country_id,kind)
);

create index tax_obligation_types_country_active_idx
  on public.tax_obligation_types(country_id,is_active,name);
create index tax_calendar_email_templates_country_idx
  on public.tax_calendar_email_templates(country_id,kind)
  where is_active;

create trigger tax_obligation_types_touch before update on public.tax_obligation_types
for each row execute function public.tax_calendar_touch_updated_at();
create trigger tax_calendar_email_templates_touch before update on public.tax_calendar_email_templates
for each row execute function public.tax_calendar_touch_updated_at();

-- Conserva como punto de partida los códigos fiscales ya configurados en el ERP.
insert into public.tax_obligation_types(country_id,code,name,frequency,description)
select distinct tc.country_id,upper(trim(tc.code_name)),
  left(trim(tt.type_name)||case when tc.rate_percentage>0 then ' · '||trim(to_char(tc.rate_percentage,'FM990D99999'))||'%' else '' end,160),
  'other','Importado desde el catálogo de códigos de impuesto existente.'
from public.tax_codes tc
join public.tax_types tt using(tax_type_id)
where trim(tc.code_name)~*'^[A-Z0-9][A-Z0-9._%/-]{0,79}$'
on conflict(country_id,code)do nothing;

-- Registra los códigos históricos que no provenían del catálogo contable.
insert into public.tax_obligation_types(country_id,code,name,frequency,description)
select distinct s.country_id,upper(trim(e.tax_type_code)),left(trim(e.tax_type_code),160),'other',
  'Migrado desde una obligación existente del calendario tributario.'
from public.tax_calendar_events e
join public.subsidiaries s using(subsidiary_id)
where trim(e.tax_type_code)~*'^[A-Z0-9][A-Z0-9._%/-]{0,79}$'
on conflict(country_id,code)do nothing;

alter table public.tax_calendar_events
  add column obligation_type_id uuid references public.tax_obligation_types(id) on delete restrict;

create index tax_calendar_events_obligation_type_idx
  on public.tax_calendar_events(obligation_type_id);

update public.tax_calendar_events e set obligation_type_id=o.id
from public.subsidiaries s,public.tax_obligation_types o
where s.subsidiary_id=e.subsidiary_id and o.country_id=s.country_id
  and o.code=upper(trim(e.tax_type_code)) and e.obligation_type_id is null;

insert into public.tax_calendar_email_templates(country_id,kind,subject_template,body_template)
select c.country_id,k.kind,
  case when k.kind='overdue'
    then 'URGENTE · {{obligacion}} · {{empresa}} · vencida'
    else '{{obligacion}} · {{empresa}} · {{mensaje_vencimiento}}' end,
  case when k.kind='overdue' then
    E'La obligación {{obligacion}} de {{empresa}}, correspondiente al período {{periodo}}, se encuentra vencida.\n\nFecha límite: {{fecha_vencimiento}}\nResponsable: {{responsable}}\n\nIngrese a NEXO ERP para revisar y completar su presentación.'
  else
    E'La obligación {{obligacion}} de {{empresa}}, correspondiente al período {{periodo}}, requiere seguimiento.\n\nFecha límite: {{fecha_vencimiento}}\nResponsable: {{responsable}}\nEstado: {{estado}}\n\n{{mensaje_vencimiento}}.' end
from public.countries c cross join(values('reminder'),('overdue'))k(kind)
on conflict(country_id,kind)do nothing;

create or replace function public.tax_calendar_country_can(p_country_id bigint,p_code text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.tax_calendar_has_permission(p_code) and exists(
    select 1 from public.subsidiaries s
    join public.user_subsidiaries us using(subsidiary_id)
    where s.country_id=p_country_id and s.is_active and us.user_id=public.app_user_id()
  )
$$;

alter table public.tax_obligation_types enable row level security;
alter table public.tax_obligation_types force row level security;
alter table public.tax_calendar_email_templates enable row level security;
alter table public.tax_calendar_email_templates force row level security;

create policy tax_obligation_types_read on public.tax_obligation_types for select to authenticated
using(public.tax_calendar_country_can(country_id,'tax_calendar.view'));
create policy tax_obligation_types_write on public.tax_obligation_types for all to authenticated
using(public.tax_calendar_country_can(country_id,'tax_calendar.manage'))
with check(public.tax_calendar_country_can(country_id,'tax_calendar.manage'));
create policy tax_calendar_email_templates_read on public.tax_calendar_email_templates for select to authenticated
using(public.tax_calendar_country_can(country_id,'tax_calendar.view'));
create policy tax_calendar_email_templates_write on public.tax_calendar_email_templates for all to authenticated
using(public.tax_calendar_country_can(country_id,'tax_calendar.manage'))
with check(public.tax_calendar_country_can(country_id,'tax_calendar.manage'));

revoke all on public.tax_obligation_types,public.tax_calendar_email_templates from public,anon,authenticated;

create or replace function public.tax_obligation_catalog_manage(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid bigint:=public.app_user_id();
  country_key bigint;
  obligation_key uuid;
  prior public.tax_obligation_types%rowtype;
  code_value text;
  name_value text;
  frequency_value text;
  description_value text;
  active_value boolean;
  kind_value text;
  subject_value text;
  body_value text;
  result jsonb;
begin
  if uid is null then raise exception using errcode='42501',message='La sesión no identifica un usuario del ERP.';end if;
  if not public.tax_calendar_has_permission('tax_calendar.view') then
    raise exception using errcode='42501',message='No tiene permiso para consultar la configuración tributaria.';
  end if;

  if p_action='options' then
    return jsonb_build_object(
      'permissions',jsonb_build_object('view',true,'manage',public.tax_calendar_has_permission('tax_calendar.manage')),
      'countries',coalesce((
        select jsonb_agg(jsonb_build_object('id',x.country_id,'name',x.name)order by x.name)
        from(
          select distinct c.country_id,c.name
          from public.countries c
          join public.subsidiaries s using(country_id)
          join public.user_subsidiaries us using(subsidiary_id)
          where us.user_id=uid and s.is_active
        )x
      ),'[]'::jsonb),
      'placeholders',jsonb_build_array(
        jsonb_build_object('token','{{empresa}}','label','Subsidiaria'),
        jsonb_build_object('token','{{obligacion}}','label','Nombre de la obligación'),
        jsonb_build_object('token','{{codigo}}','label','Código'),
        jsonb_build_object('token','{{periodo}}','label','Período'),
        jsonb_build_object('token','{{fecha_vencimiento}}','label','Fecha límite'),
        jsonb_build_object('token','{{responsable}}','label','Responsable'),
        jsonb_build_object('token','{{estado}}','label','Estado'),
        jsonb_build_object('token','{{mensaje_vencimiento}}','label','Vence hoy, en X días o está vencida'),
        jsonb_build_object('token','{{enlace}}','label','Enlace a NEXO')
      )
    );
  end if;

  if p_action='calendar-options' then
    return jsonb_build_object('taxTypes',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'code',x.code,'name',x.code||' · '||x.name,'countryId',x.country_id,
        'frequency',x.frequency,'subsidiaryIds',x.subsidiary_ids
      )order by x.country_name,x.name,x.code)
      from(
        select o.id,o.country_id,o.code,o.name,o.frequency,c.name country_name,
          jsonb_agg(distinct s.subsidiary_id order by s.subsidiary_id)subsidiary_ids
        from public.tax_obligation_types o
        join public.countries c using(country_id)
        join public.subsidiaries s on s.country_id=o.country_id and s.is_active
        join public.user_subsidiaries us on us.subsidiary_id=s.subsidiary_id and us.user_id=uid
        where o.is_active
        group by o.id,o.country_id,o.code,o.name,o.frequency,c.name
      )x
    ),'[]'::jsonb));
  end if;

  if p_action='list' then
    country_key:=nullif(p_payload->>'countryId','')::bigint;
    if country_key is not null and not public.tax_calendar_country_can(country_key,'tax_calendar.view') then
      raise exception using errcode='42501',message='No tiene acceso al país seleccionado.';
    end if;
    select jsonb_build_object(
      'obligations',coalesce((select jsonb_agg(jsonb_build_object(
        'id',o.id,'countryId',o.country_id,'countryName',c.name,'code',o.code,'name',o.name,
        'frequency',o.frequency,'description',o.description,'isActive',o.is_active,
        'createdAt',o.created_at,'updatedAt',o.updated_at
      )order by c.name,o.name,o.code)
      from public.tax_obligation_types o join public.countries c using(country_id)
      where(country_key is null or o.country_id=country_key)
        and public.tax_calendar_country_can(o.country_id,'tax_calendar.view')),'[]'::jsonb),
      'templates',coalesce((select jsonb_agg(jsonb_build_object(
        'id',t.id,'countryId',t.country_id,'countryName',c.name,'kind',t.kind,
        'subjectTemplate',t.subject_template,'bodyTemplate',t.body_template,'isActive',t.is_active,
        'updatedAt',t.updated_at
      )order by c.name,t.kind)
      from public.tax_calendar_email_templates t join public.countries c using(country_id)
      where(country_key is null or t.country_id=country_key)
        and public.tax_calendar_country_can(t.country_id,'tax_calendar.view')),'[]'::jsonb)
    )into result;
    return result;
  end if;

  if not public.tax_calendar_has_permission('tax_calendar.manage') then
    raise exception using errcode='42501',message='No tiene permiso para administrar la configuración tributaria.';
  end if;

  if p_action='save' then
    obligation_key:=nullif(p_payload->>'id','')::uuid;
    country_key:=nullif(p_payload->>'countryId','')::bigint;
    code_value:=upper(trim(coalesce(p_payload->>'code','')));
    name_value:=trim(coalesce(p_payload->>'name',''));
    frequency_value:=coalesce(nullif(p_payload->>'frequency',''),'monthly');
    description_value:=nullif(trim(p_payload->>'description'),'');
    active_value:=coalesce((p_payload->>'isActive')::boolean,true);
    if country_key is null or not public.tax_calendar_country_can(country_key,'tax_calendar.manage') then
      raise exception using errcode='42501',message='No tiene permiso para administrar obligaciones de este país.';
    end if;
    if code_value!~'^[A-Z0-9][A-Z0-9._%/-]{0,79}$' then raise exception 'Ingrese un código válido usando letras, números, punto, guion, barra, porcentaje o guion bajo.';end if;
    if length(name_value)not between 2 and 160 then raise exception 'El nombre debe contener entre 2 y 160 caracteres.';end if;
    if frequency_value not in('monthly','quarterly','annual','other')then raise exception 'Seleccione una frecuencia válida.';end if;
    if description_value is not null and length(description_value)>1000 then raise exception 'La descripción supera 1.000 caracteres.';end if;
    if obligation_key is null then
      insert into public.tax_obligation_types(country_id,code,name,frequency,description,is_active,created_by)
      values(country_key,code_value,name_value,frequency_value,description_value,active_value,uid)returning id into obligation_key;
    else
      select * into prior from public.tax_obligation_types where id=obligation_key for update;
      if prior.id is null then raise exception 'La obligación tributaria no existe.';end if;
      if not public.tax_calendar_country_can(prior.country_id,'tax_calendar.manage')then raise exception using errcode='42501',message='No tiene permiso para modificar esta obligación.';end if;
      if row(prior.country_id,prior.code)is distinct from row(country_key,code_value)and exists(
        select 1 from public.tax_calendar_events e join public.subsidiaries s using(subsidiary_id)
        where e.obligation_type_id=prior.id or(s.country_id=prior.country_id and e.tax_type_code=prior.code)
      )then raise exception 'El código y el país no pueden cambiar porque la obligación ya tiene movimientos en el calendario.';end if;
      update public.tax_obligation_types set country_id=country_key,code=code_value,name=name_value,frequency=frequency_value,
        description=description_value,is_active=active_value,updated_by=uid where id=obligation_key;
    end if;
    return jsonb_build_object('success',true,'id',obligation_key);
  end if;

  if p_action='delete' then
    obligation_key:=nullif(p_payload->>'id','')::uuid;
    select * into prior from public.tax_obligation_types where id=obligation_key for update;
    if prior.id is null then raise exception 'La obligación tributaria no existe.';end if;
    if not public.tax_calendar_country_can(prior.country_id,'tax_calendar.manage')then raise exception using errcode='42501',message='No tiene permiso para eliminar esta obligación.';end if;
    if exists(select 1 from public.tax_calendar_events e join public.subsidiaries s using(subsidiary_id)where e.obligation_type_id=prior.id or(s.country_id=prior.country_id and e.tax_type_code=prior.code))then
      raise exception 'La obligación tiene movimientos en el calendario. Desactívela para conservar el historial.';
    end if;
    delete from public.tax_obligation_types where id=obligation_key;
    return jsonb_build_object('success',true,'id',obligation_key);
  end if;

  if p_action='save-template' then
    country_key:=nullif(p_payload->>'countryId','')::bigint;
    kind_value:=p_payload->>'kind';
    subject_value:=trim(coalesce(p_payload->>'subjectTemplate',''));
    body_value:=trim(coalesce(p_payload->>'bodyTemplate',''));
    active_value:=coalesce((p_payload->>'isActive')::boolean,true);
    if country_key is null or not public.tax_calendar_country_can(country_key,'tax_calendar.manage')then raise exception using errcode='42501',message='No tiene permiso para administrar plantillas de este país.';end if;
    if kind_value not in('reminder','overdue')then raise exception 'Seleccione un tipo de plantilla válido.';end if;
    if length(subject_value)not between 3 and 200 or subject_value~'[\r\n]'then raise exception 'El asunto debe contener entre 3 y 200 caracteres en una sola línea.';end if;
    if length(body_value)not between 10 and 4000 then raise exception 'El mensaje debe contener entre 10 y 4.000 caracteres.';end if;
    insert into public.tax_calendar_email_templates(country_id,kind,subject_template,body_template,is_active,created_by,updated_by)
    values(country_key,kind_value,subject_value,body_value,active_value,uid,uid)
    on conflict(country_id,kind)do update set subject_template=excluded.subject_template,body_template=excluded.body_template,
      is_active=excluded.is_active,updated_by=uid;
    return jsonb_build_object('success',true,'countryId',country_key,'kind',kind_value);
  end if;

  raise exception 'Acción de configuración tributaria no válida.';
end$$;

create or replace function public.validate_tax_calendar_obligation_type() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare country_key bigint;obligation_key uuid;
begin
  select country_id into country_key from public.subsidiaries where subsidiary_id=new.subsidiary_id;
  select o.id into obligation_key from public.tax_obligation_types o
  where o.country_id=country_key and o.code=upper(trim(new.tax_type_code))
    and(o.is_active or(
      tg_op='UPDATE' and new.subsidiary_id=old.subsidiary_id
      and upper(trim(new.tax_type_code))=upper(trim(old.tax_type_code))
      and o.id=old.obligation_type_id
    ));
  if country_key is null or obligation_key is null then raise exception 'Seleccione una obligación tributaria activa correspondiente al país de la subsidiaria.';end if;
  new.tax_type_code:=upper(trim(new.tax_type_code));
  new.obligation_type_id:=obligation_key;
  return new;
end$$;

drop trigger if exists validate_tax_calendar_obligation_type on public.tax_calendar_events;
create trigger validate_tax_calendar_obligation_type
before insert or update of subsidiary_id,tax_type_code on public.tax_calendar_events
for each row execute function public.validate_tax_calendar_obligation_type();

create or replace function public.tax_calendar_enqueue_recipient(
  p_event_id uuid,p_user_id bigint,p_channel text,p_kind text,p_reminder_id uuid,p_days integer,p_priority text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  e public.tax_calendar_events%rowtype;
  u public.users%rowtype;
  s public.subsidiaries%rowtype;
  assigned_name text;
  obligation_name text;
  template_subject text;
  template_body text;
  key_base text;
  title_value text;
  message_value text;
  payload_value jsonb;
begin
  if p_user_id is null or p_channel not in('email','in_app','both')then return;end if;
  select * into e from public.tax_calendar_events where id=p_event_id;
  select * into u from public.users where user_id=p_user_id and is_active;
  select * into s from public.subsidiaries where subsidiary_id=e.subsidiary_id;
  if e.id is null or u.user_id is null or not exists(select 1 from public.user_subsidiaries us where us.user_id=p_user_id and us.subsidiary_id=e.subsidiary_id)then return;end if;
  select trim(concat_ws(' ',first_name,last_name))into assigned_name from public.users where user_id=e.assigned_user_id;
  select o.name into obligation_name from public.tax_obligation_types o where o.id=e.obligation_type_id;
  select t.subject_template,t.body_template into template_subject,template_body
  from public.tax_calendar_email_templates t where t.country_id=s.country_id and t.kind=p_kind and t.is_active;
  key_base:=p_kind||':'||e.id::text||':'||coalesce(p_reminder_id::text,e.due_date::text)||':'||p_user_id::text;
  title_value:=case when p_kind='overdue'then'Obligación tributaria vencida'else'Recordatorio tributario · '||coalesce(obligation_name,e.tax_type_code)end;
  message_value:=case when p_kind='overdue'then coalesce(obligation_name,e.tax_type_code)||' del período '||e.period||' venció el '||to_char(e.due_date,'DD/MM/YYYY')||'.' when p_days=0 then coalesce(obligation_name,e.tax_type_code)||' vence hoy.'else coalesce(obligation_name,e.tax_type_code)||' vence en '||p_days||case when p_days=1 then' día.'else' días.'end end;
  payload_value:=jsonb_build_object(
    'taxTypeCode',e.tax_type_code,'taxTypeName',coalesce(obligation_name,e.tax_type_code),'period',e.period,
    'dueDate',e.due_date,'daysBeforeDue',p_days,'status',case when p_kind='overdue'then'overdue'else e.status end,
    'subsidiaryName',s.name,'assignedUserName',assigned_name,'deepLink','/tax-calendar.html?event='||e.id::text,
    'templateSubject',template_subject,'templateBody',template_body,'notificationKind',p_kind
  );
  if p_channel in('in_app','both')then
    insert into public.tax_calendar_notifications(event_id,subsidiary_id,user_id,reminder_id,kind,priority,title,message,deep_link,dedupe_key)
    values(e.id,e.subsidiary_id,p_user_id,p_reminder_id,p_kind,p_priority,title_value,message_value,'/tax-calendar.html?event='||e.id::text,key_base||':in_app')
    on conflict(dedupe_key)do nothing;
  end if;
  if p_channel in('email','both')and u.email~*'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'then
    insert into public.tax_calendar_email_outbox(event_id,subsidiary_id,recipient_user_id,reminder_id,kind,priority,recipient_email,payload,dedupe_key)
    values(e.id,e.subsidiary_id,p_user_id,p_reminder_id,p_kind,p_priority,lower(u.email),payload_value,key_base||':email')
    on conflict(dedupe_key)do nothing;
  end if;
end$$;

revoke all on function public.tax_calendar_country_can(bigint,text),public.tax_obligation_catalog_manage(text,jsonb),
 public.validate_tax_calendar_obligation_type() from public,anon,authenticated,service_role;
grant execute on function public.tax_obligation_catalog_manage(text,jsonb) to authenticated;

notify pgrst,'reload schema';
