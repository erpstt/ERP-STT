-- Calendario tributario y seguimiento de obligaciones fiscales.
-- Las obligaciones usan UUID; las referencias a usuarios y subsidiarias conservan
-- los BIGINT del modelo existente de NEXO.

alter table public.subsidiaries
  add column if not exists tax_supervisor_user_id bigint references public.users(user_id) on delete set null;

create index if not exists subsidiaries_tax_supervisor_idx
  on public.subsidiaries(tax_supervisor_user_id)
  where tax_supervisor_user_id is not null;

create or replace function public.validate_tax_supervisor() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.tax_supervisor_user_id is not null and not exists(
    select 1 from public.users u
    join public.user_subsidiaries us on us.user_id=u.user_id
    where u.user_id=new.tax_supervisor_user_id
      and u.is_active
      and us.subsidiary_id=new.subsidiary_id
  ) then
    raise exception 'El supervisor tributario debe ser un usuario activo con acceso a la subsidiaria.';
  end if;
  return new;
end$$;

drop trigger if exists validate_tax_supervisor on public.subsidiaries;
create trigger validate_tax_supervisor
before insert or update of tax_supervisor_user_id on public.subsidiaries
for each row execute function public.validate_tax_supervisor();

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Supabase Storage no está disponible; no se puede crear el bucket privado del calendario tributario.';
  end if;
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('tax-calendar','tax-calendar',false,5242880,array['application/pdf','image/jpeg','image/png']::text[])
  on conflict(id) do update set
    public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;
end$$;

create table public.tax_calendar_events(
  id uuid primary key default gen_random_uuid(),
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  tax_type_code varchar(80) not null check(length(trim(tax_type_code)) between 1 and 80),
  period varchar(24) not null check(period ~ '^([0-9]{4}-(0[1-9]|1[0-2]|Q[1-4]|FY))$'),
  due_date date not null,
  assigned_user_id bigint references public.users(user_id) on delete set null,
  status text not null default 'pending' check(status in('pending','in_review','filed','overdue','exempt')),
  document_type text not null default 'none' check(document_type in('file_upload','external_url','none')),
  document_url text,
  external_link text,
  filing_date timestamptz,
  filing_reference_number varchar(120),
  notes text check(notes is null or length(notes)<=4000),
  created_by bigint not null references public.users(user_id) on delete restrict,
  updated_by bigint references public.users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subsidiary_id,tax_type_code,period),
  check(status<>'filed' or filing_date is not null),
  check(
    (document_type='none' and document_url is null and external_link is null) or
    (document_type='external_url' and document_url is null and external_link ~* '^https://[^[:space:]]+$') or
    (document_type='file_upload' and document_url is not null and external_link is null)
  )
);

create table public.tax_calendar_followers(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.tax_calendar_events(id) on delete cascade,
  user_id bigint not null references public.users(user_id) on delete cascade,
  notification_channel text not null check(notification_channel in('email','in_app','both')),
  created_at timestamptz not null default now(),
  unique(event_id,user_id)
);

create table public.tax_calendar_reminders(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.tax_calendar_events(id) on delete cascade,
  days_before_due integer not null check(days_before_due between 0 and 365),
  is_sent boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique(event_id,days_before_due),
  check((not is_sent and sent_at is null) or is_sent)
);

create table public.tax_calendar_documents(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.tax_calendar_events(id) on delete cascade,
  storage_path text not null unique check(length(storage_path) between 10 and 700),
  file_name varchar(255) not null,
  mime_type text not null check(mime_type in('application/pdf','image/jpeg','image/png')),
  file_size bigint not null check(file_size between 1 and 5242880),
  uploaded_by bigint not null references public.users(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tax_calendar_notifications(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.tax_calendar_events(id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  user_id bigint not null references public.users(user_id) on delete cascade,
  reminder_id uuid references public.tax_calendar_reminders(id) on delete cascade,
  kind text not null check(kind in('reminder','overdue')),
  priority text not null default 'normal' check(priority in('normal','high')),
  title varchar(200) not null,
  message text not null,
  deep_link text not null,
  dedupe_key text not null unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.tax_calendar_email_outbox(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.tax_calendar_events(id) on delete cascade,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete cascade,
  recipient_user_id bigint not null references public.users(user_id) on delete cascade,
  reminder_id uuid references public.tax_calendar_reminders(id) on delete cascade,
  kind text not null check(kind in('reminder','overdue')),
  priority text not null default 'normal' check(priority in('normal','high')),
  recipient_email text not null,
  payload jsonb not null,
  dedupe_key text not null unique,
  status text not null default 'PENDIENTE' check(status in('PENDIENTE','PREPARANDO','ENVIANDO','ENVIADO','ERROR','INCIERTO')),
  lease uuid,
  lease_until timestamptz,
  message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  finished_at timestamptz
);

create index tax_calendar_events_subsidiary_due_idx on public.tax_calendar_events(subsidiary_id,due_date);
create index tax_calendar_events_open_due_idx on public.tax_calendar_events(due_date,status)
  where status not in('filed','exempt');
create index tax_calendar_events_assigned_due_idx on public.tax_calendar_events(assigned_user_id,due_date)
  where assigned_user_id is not null;
create index tax_calendar_followers_user_idx on public.tax_calendar_followers(user_id,event_id);
create index tax_calendar_reminders_due_idx on public.tax_calendar_reminders(is_sent,days_before_due,event_id);
create index tax_calendar_notifications_user_idx on public.tax_calendar_notifications(user_id,read_at,created_at desc);
create index tax_calendar_email_pending_idx on public.tax_calendar_email_outbox(created_at)
  where status='PENDIENTE';

create or replace function public.tax_calendar_touch_updated_at() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin new.updated_at:=now();return new;end$$;
create trigger tax_calendar_events_touch before update on public.tax_calendar_events
for each row execute function public.tax_calendar_touch_updated_at();
create trigger tax_calendar_documents_touch before update on public.tax_calendar_documents
for each row execute function public.tax_calendar_touch_updated_at();

insert into public.permissions(code,module,description) values
 ('tax_calendar.view','Fiscal','Consultar obligaciones tributarias de las subsidiarias autorizadas.'),
 ('tax_calendar.manage','Fiscal','Crear y administrar obligaciones, responsables y recordatorios tributarios.'),
 ('tax_calendar.file','Fiscal','Cargar respaldos y confirmar la presentación de obligaciones tributarias.')
on conflict(code) do update set module=excluded.module,description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select r.role_id,p.permission_id
from public.roles r cross join public.permissions p
where p.code in('tax_calendar.view','tax_calendar.manage','tax_calendar.file')
  and lower(r.role_name) in('administrador','administrator','admin')
on conflict do nothing;

create or replace function public.tax_calendar_has_permission(p_code text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.app_user_id() is not null
    and exists(select 1 from public.users u where u.user_id=public.app_user_id() and u.is_active)
    and (
      public.app_is_admin() or exists(
        select 1 from public.role_permissions rp
        join public.permissions p using(permission_id)
        join public.user_roles ur on ur.user_id=public.app_user_id() and ur.role_id=rp.role_id
        where rp.role_id=public.app_active_role_id() and p.code=p_code
      )
    )
$$;

create or replace function public.tax_calendar_can(p_subsidiary_id bigint,p_code text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.tax_calendar_has_permission(p_code)
    and exists(
      select 1 from public.user_subsidiaries us
      where us.user_id=public.app_user_id() and us.subsidiary_id=p_subsidiary_id
    )
$$;

alter table public.tax_calendar_events enable row level security;
alter table public.tax_calendar_events force row level security;
alter table public.tax_calendar_followers enable row level security;
alter table public.tax_calendar_followers force row level security;
alter table public.tax_calendar_reminders enable row level security;
alter table public.tax_calendar_reminders force row level security;
alter table public.tax_calendar_documents enable row level security;
alter table public.tax_calendar_documents force row level security;
alter table public.tax_calendar_notifications enable row level security;
alter table public.tax_calendar_notifications force row level security;
alter table public.tax_calendar_email_outbox enable row level security;
alter table public.tax_calendar_email_outbox force row level security;

create policy tax_calendar_events_read on public.tax_calendar_events for select to authenticated
using(public.tax_calendar_can(subsidiary_id,'tax_calendar.view'));
create policy tax_calendar_events_create on public.tax_calendar_events for insert to authenticated
with check(public.tax_calendar_can(subsidiary_id,'tax_calendar.manage'));
create policy tax_calendar_events_change on public.tax_calendar_events for update to authenticated
using(public.tax_calendar_can(subsidiary_id,'tax_calendar.manage') or public.tax_calendar_can(subsidiary_id,'tax_calendar.file'))
with check(public.tax_calendar_can(subsidiary_id,'tax_calendar.manage') or public.tax_calendar_can(subsidiary_id,'tax_calendar.file'));
create policy tax_calendar_events_remove on public.tax_calendar_events for delete to authenticated
using(public.tax_calendar_can(subsidiary_id,'tax_calendar.manage'));

create policy tax_calendar_followers_read on public.tax_calendar_followers for select to authenticated using(exists(
  select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.view')));
create policy tax_calendar_followers_write on public.tax_calendar_followers for all to authenticated using(exists(
  select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.manage')))
with check(exists(select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.manage')));

create policy tax_calendar_reminders_read on public.tax_calendar_reminders for select to authenticated using(exists(
  select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.view')));
create policy tax_calendar_reminders_write on public.tax_calendar_reminders for all to authenticated using(exists(
  select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.manage')))
with check(exists(select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.manage')));

create policy tax_calendar_documents_read on public.tax_calendar_documents for select to authenticated using(exists(
  select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.view')));
create policy tax_calendar_documents_write on public.tax_calendar_documents for all to authenticated using(exists(
  select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.file')))
with check(exists(select 1 from public.tax_calendar_events e where e.id=event_id and public.tax_calendar_can(e.subsidiary_id,'tax_calendar.file')));

create policy tax_calendar_notifications_own on public.tax_calendar_notifications for select to authenticated
using(user_id=public.app_user_id() and public.tax_calendar_can(subsidiary_id,'tax_calendar.view'));

revoke all on public.tax_calendar_events,public.tax_calendar_followers,public.tax_calendar_reminders,
 public.tax_calendar_documents,public.tax_calendar_notifications,public.tax_calendar_email_outbox
from public,anon,authenticated;

create or replace function public.tax_calendar_local_date(p_subsidiary_id bigint,p_clock timestamptz default now()) returns date
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare zone_name text;offset_value text;answer date;
begin
  select t.name,t.utc_offset into zone_name,offset_value
  from public.subsidiaries s join public.timezones t using(timezone_id)
  where s.subsidiary_id=p_subsidiary_id;
  begin
    answer:=(p_clock at time zone zone_name)::date;
  exception when invalid_parameter_value then
    begin
      answer:=(p_clock + replace(coalesce(offset_value,'-06:00'),'UTC','')::interval)::date;
    exception when others then
      answer:=(p_clock at time zone 'America/Costa_Rica')::date;
    end;
  end;
  return answer;
end$$;

create or replace function public.tax_calendar_manage(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid bigint:=public.app_user_id();
  event_key uuid;
  sid bigint;
  prior public.tax_calendar_events%rowtype;
  found_event boolean:=false;
  can_manage boolean:=false;
  can_file boolean:=false;
  code_value text;
  period_value text;
  due_value date;
  assigned_value bigint;
  status_value text;
  document_value text;
  link_value text;
  filing_value timestamptz;
  reference_value text;
  notes_value text;
  structural_change boolean:=false;
  filing_change boolean:=false;
  item jsonb;
  follower_user bigint;
  reminder_days integer;
  file_value jsonb;
  file_name_value text;
  mime_value text;
  size_value bigint;
  path_value text;
  old_path text;
  result jsonb;
  selected_sid bigint;
  start_value date;
  end_value date;
  status_filter text;
  type_filter text;
begin
  if uid is null then raise exception using errcode='42501',message='La sesión no identifica un usuario del ERP.';end if;

  if p_action='options' then
    if not public.tax_calendar_has_permission('tax_calendar.view') then
      raise exception using errcode='42501',message='No tiene permiso para consultar el calendario tributario.';
    end if;
    return jsonb_build_object(
      'activeSubsidiaryId',case when exists(select 1 from public.user_subsidiaries us where us.user_id=uid and us.subsidiary_id=public.active_subsidiary_id()) then public.active_subsidiary_id() end,
      'permissions',jsonb_build_object(
        'view',public.tax_calendar_has_permission('tax_calendar.view'),
        'manage',public.tax_calendar_has_permission('tax_calendar.manage'),
        'file',public.tax_calendar_has_permission('tax_calendar.file')
      ),
      'subsidiaries',coalesce((
        select jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name,'countryId',s.country_id,'taxSupervisorUserId',s.tax_supervisor_user_id) order by s.name)
        from public.subsidiaries s join public.user_subsidiaries us using(subsidiary_id)
        where us.user_id=uid and s.is_active
      ),'[]'::jsonb),
      'users',coalesce((
        select jsonb_agg(jsonb_build_object('id',x.user_id,'name',x.name,'email',x.email,'subsidiaryIds',x.subsidiary_ids) order by x.name)
        from(
          select u.user_id,trim(concat_ws(' ',u.first_name,u.last_name)) name,u.email,
            jsonb_agg(distinct us.subsidiary_id order by us.subsidiary_id) subsidiary_ids
          from public.users u join public.user_subsidiaries us using(user_id)
          where u.is_active and us.subsidiary_id in(select subsidiary_id from public.user_subsidiaries where user_id=uid)
          group by u.user_id,u.first_name,u.last_name,u.email
        )x
      ),'[]'::jsonb),
      'taxTypes',coalesce((
        select jsonb_agg(jsonb_build_object('code',x.code_name,'name',x.label,'subsidiaryIds',x.subsidiary_ids) order by x.label)
        from(
          select tc.code_name,
            tc.code_name||' · '||tt.type_name||case when tc.rate_percentage>0 then ' · '||trim(to_char(tc.rate_percentage,'FM990D99999'))||'%' else '' end label,
            jsonb_agg(distinct s.subsidiary_id order by s.subsidiary_id) subsidiary_ids
          from public.tax_codes tc
          join public.tax_types tt using(tax_type_id)
          join public.subsidiaries s on s.country_id=tc.country_id
          join public.user_subsidiaries us on us.subsidiary_id=s.subsidiary_id and us.user_id=uid
          where not exists(select 1 from public.tax_code_subsidiaries tcs0 where tcs0.tax_code_id=tc.tax_code_id)
             or exists(select 1 from public.tax_code_subsidiaries tcs where tcs.tax_code_id=tc.tax_code_id and tcs.subsidiary_id=s.subsidiary_id)
          group by tc.code_name,tt.type_name,tc.rate_percentage
        )x
      ),'[]'::jsonb)
    );
  end if;

  if not public.tax_calendar_has_permission('tax_calendar.view') then
    raise exception using errcode='42501',message='No tiene permiso para consultar el calendario tributario.';
  end if;

  if p_action='list' then
    selected_sid:=nullif(p_payload->>'subsidiaryId','')::bigint;
    if selected_sid is not null and not public.tax_calendar_can(selected_sid,'tax_calendar.view') then
      raise exception using errcode='42501',message='La subsidiaria seleccionada no está autorizada.';
    end if;
    start_value:=nullif(p_payload->>'dateFrom','')::date;
    end_value:=nullif(p_payload->>'dateTo','')::date;
    if start_value is not null and end_value is not null and start_value>end_value then raise exception 'El rango de fechas no es válido.';end if;
    status_filter:=nullif(p_payload->>'status','');
    type_filter:=nullif(p_payload->>'taxTypeCode','');
    if status_filter is not null and status_filter not in('pending','in_review','filed','overdue','exempt') then raise exception 'El estado solicitado no es válido.';end if;
    with base as(
      select e.*,s.name subsidiary_name,trim(concat_ws(' ',u.first_name,u.last_name)) assigned_user_name,u.email assigned_user_email,
        coalesce((select count(*) from public.tax_calendar_followers f where f.event_id=e.id),0) follower_count,
        coalesce((select jsonb_agg(r.days_before_due order by r.days_before_due desc) from public.tax_calendar_reminders r where r.event_id=e.id),'[]'::jsonb) reminder_days
      from public.tax_calendar_events e
      join public.subsidiaries s using(subsidiary_id)
      left join public.users u on u.user_id=e.assigned_user_id
      where public.tax_calendar_can(e.subsidiary_id,'tax_calendar.view')
        and(selected_sid is null or e.subsidiary_id=selected_sid)
        and(start_value is null or e.due_date>=start_value)
        and(end_value is null or e.due_date<=end_value)
        and(type_filter is null or e.tax_type_code=type_filter)
    ), visible as(select * from base where status_filter is null or status=status_filter)
    select jsonb_build_object(
      'events',coalesce((select jsonb_agg(jsonb_build_object(
        'id',v.id,'subsidiaryId',v.subsidiary_id,'subsidiaryName',v.subsidiary_name,
        'taxTypeCode',v.tax_type_code,'taxTypeName',v.tax_type_code,'period',v.period,'dueDate',v.due_date,
        'assignedUserId',v.assigned_user_id,'assignedUserName',v.assigned_user_name,'assignedUserEmail',v.assigned_user_email,
        'status',v.status,'documentType',v.document_type,'documentUrl',v.document_url,'externalLink',v.external_link,
        'filingDate',v.filing_date,'filingReferenceNumber',v.filing_reference_number,'notes',v.notes,
        'followersCount',v.follower_count,'reminderDays',v.reminder_days,'createdAt',v.created_at,'updatedAt',v.updated_at
      )order by v.due_date,v.subsidiary_name,v.tax_type_code)from visible v),'[]'::jsonb),
      'metrics',jsonb_build_object(
        'total',(select count(*)from base),
        'pending',(select count(*)from base where status='pending'),
        'inReview',(select count(*)from base where status='in_review'),
        'overdue',(select count(*)from base where status='overdue'),
        'filed',(select count(*)from base where status='filed'),
        'exempt',(select count(*)from base where status='exempt'),
        'upcoming',(select count(*)from base where status in('pending','in_review')and due_date between current_date and current_date+7)
      ),
      'notifications',coalesce((select jsonb_agg(jsonb_build_object(
        'id',n.id,'eventId',n.event_id,'kind',n.kind,'priority',n.priority,'title',n.title,'message',n.message,
        'deepLink',n.deep_link,'readAt',n.read_at,'createdAt',n.created_at,'taxTypeCode',e.tax_type_code,'dueDate',e.due_date,
        'subsidiaryName',s.name
      )order by n.created_at desc)
      from(select * from public.tax_calendar_notifications where user_id=uid order by created_at desc limit 50)n
      join public.tax_calendar_events e on e.id=n.event_id
      join public.subsidiaries s on s.subsidiary_id=n.subsidiary_id),'[]'::jsonb)
    ) into result;
    return result;
  end if;

  if p_action in('get','delete') then
    event_key:=nullif(p_payload->>'id','')::uuid;
    select * into prior from public.tax_calendar_events where id=event_key;
    if not found then raise exception 'La obligación tributaria no existe.';end if;
    if not public.tax_calendar_can(prior.subsidiary_id,'tax_calendar.view') then raise exception using errcode='42501',message='No tiene acceso a esta obligación tributaria.';end if;
    if p_action='delete' then
      if not public.tax_calendar_can(prior.subsidiary_id,'tax_calendar.manage') then raise exception using errcode='42501',message='No tiene permiso para eliminar obligaciones tributarias.';end if;
      select storage_path into old_path from public.tax_calendar_documents where event_id=event_key;
      delete from public.tax_calendar_events where id=event_key;
      return jsonb_build_object('success',true,'id',event_key,'obsoleteStoragePath',old_path);
    end if;
    return jsonb_build_object(
      'event',jsonb_build_object(
        'id',prior.id,'subsidiaryId',prior.subsidiary_id,'taxTypeCode',prior.tax_type_code,'period',prior.period,
        'dueDate',prior.due_date,'assignedUserId',prior.assigned_user_id,'status',prior.status,
        'documentType',prior.document_type,'documentUrl',prior.document_url,'externalLink',prior.external_link,
        'filingDate',prior.filing_date,'filingReferenceNumber',prior.filing_reference_number,'notes',prior.notes,
        'createdAt',prior.created_at,'updatedAt',prior.updated_at
      ),
      'followers',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'userId',f.user_id,'notificationChannel',f.notification_channel,'name',trim(concat_ws(' ',u.first_name,u.last_name)),'email',u.email)order by u.first_name,u.last_name)from public.tax_calendar_followers f join public.users u using(user_id)where f.event_id=event_key),'[]'::jsonb),
      'reminders',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'daysBeforeDue',r.days_before_due,'isSent',r.is_sent,'sentAt',r.sent_at)order by r.days_before_due desc)from public.tax_calendar_reminders r where r.event_id=event_key),'[]'::jsonb),
      'document',(select jsonb_build_object('id',d.id,'fileName',d.file_name,'mimeType',d.mime_type,'fileSize',d.file_size,'createdAt',d.created_at)from public.tax_calendar_documents d where d.event_id=event_key)
    );
  end if;

  if p_action='mark-read' then
    if coalesce((p_payload->>'all')::boolean,false) then
      update public.tax_calendar_notifications set read_at=coalesce(read_at,now()) where user_id=uid and read_at is null;
    else
      update public.tax_calendar_notifications n set read_at=coalesce(n.read_at,now())
      where n.user_id=uid and n.id in(select value::uuid from jsonb_array_elements_text(coalesce(p_payload->'ids','[]'::jsonb)));
    end if;
    get diagnostics reminder_days=row_count;
    return jsonb_build_object('success',true,'updated',reminder_days);
  end if;

  if p_action<>'save' then raise exception 'Acción de calendario tributario no válida.';end if;

  event_key:=coalesce(nullif(p_payload->>'id','')::uuid,gen_random_uuid());
  select * into prior from public.tax_calendar_events where id=event_key for update;
  found_event:=found;
  sid:=coalesce(nullif(p_payload->>'subsidiaryId','')::bigint,case when found_event then prior.subsidiary_id end);
  if sid is null then raise exception 'Seleccione una subsidiaria.';end if;
  can_manage:=public.tax_calendar_can(sid,'tax_calendar.manage');
  can_file:=public.tax_calendar_can(sid,'tax_calendar.file');
  if found_event and prior.subsidiary_id<>sid and not public.tax_calendar_can(prior.subsidiary_id,'tax_calendar.manage') then raise exception using errcode='42501',message='No tiene permiso para mover esta obligación.';end if;
  if not found_event and not can_manage then raise exception using errcode='42501',message='No tiene permiso para crear obligaciones en esta subsidiaria.';end if;

  code_value:=coalesce(nullif(trim(p_payload->>'taxTypeCode'),''),case when found_event then prior.tax_type_code end);
  period_value:=coalesce(nullif(trim(p_payload->>'period'),''),case when found_event then prior.period end);
  due_value:=coalesce(nullif(p_payload->>'dueDate','')::date,case when found_event then prior.due_date end);
  assigned_value:=case when p_payload ? 'assignedUserId' then nullif(p_payload->>'assignedUserId','')::bigint when found_event then prior.assigned_user_id end;
  status_value:=coalesce(nullif(p_payload->>'status',''),case when found_event then prior.status end,'pending');
  document_value:=coalesce(nullif(p_payload->>'documentType',''),case when found_event then prior.document_type end,'none');
  link_value:=case when p_payload ? 'externalLink' then nullif(trim(p_payload->>'externalLink'),'') when found_event then prior.external_link end;
  filing_value:=case when p_payload ? 'filingDate' then nullif(p_payload->>'filingDate','')::timestamptz when found_event then prior.filing_date end;
  reference_value:=case when p_payload ? 'filingReferenceNumber' then nullif(trim(p_payload->>'filingReferenceNumber'),'') when found_event then prior.filing_reference_number end;
  notes_value:=case when p_payload ? 'notes' then nullif(trim(p_payload->>'notes'),'') when found_event then prior.notes end;

  if code_value is null or length(code_value)>80 then raise exception 'Seleccione un tipo de impuesto válido.';end if;
  if period_value is null or period_value!~'^([0-9]{4}-(0[1-9]|1[0-2]|Q[1-4]|FY))$' then raise exception 'El período debe tener formato AAAA-MM, AAAA-Q1…Q4 o AAAA-FY.';end if;
  if due_value is null then raise exception 'Indique la fecha de vencimiento.';end if;
  if status_value not in('pending','in_review','filed','overdue','exempt') then raise exception 'Seleccione un estado válido.';end if;
  if document_value not in('file_upload','external_url','none') then raise exception 'Seleccione un tipo de respaldo válido.';end if;
  if assigned_value is not null and not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)where u.user_id=assigned_value and u.is_active and us.subsidiary_id=sid) then raise exception 'El responsable no es un usuario activo autorizado en la subsidiaria.';end if;
  if status_value='filed' and filing_value is null then raise exception 'Indique la fecha real de presentación.';end if;
  if reference_value is not null and length(reference_value)>120 then raise exception 'El número de radicado supera 120 caracteres.';end if;
  if notes_value is not null and length(notes_value)>4000 then raise exception 'Las notas superan 4.000 caracteres.';end if;

  if found_event then
    structural_change:=row(prior.subsidiary_id,prior.tax_type_code,prior.period,prior.due_date,prior.assigned_user_id,prior.notes)
      is distinct from row(sid,code_value,period_value,due_value,assigned_value,notes_value);
    filing_change:=row(prior.status,prior.document_type,prior.external_link,prior.filing_date,prior.filing_reference_number)
      is distinct from row(status_value,document_value,link_value,filing_value,reference_value) or p_payload ? 'file';
    if structural_change and not can_manage then raise exception using errcode='42501',message='No tiene permiso para editar los datos de la obligación.';end if;
    if not can_manage and status_value not in(prior.status,'filed') then raise exception using errcode='42501',message='El permiso de presentación solo permite conservar el estado o marcar la obligación como presentada.';end if;
    if filing_change and not can_file then raise exception using errcode='42501',message='No tiene permiso para adjuntar respaldos o confirmar presentaciones.';end if;
  elsif(document_value<>'none' or status_value='filed' or p_payload ? 'file')and not can_file then
    raise exception using errcode='42501',message='No tiene permiso para adjuntar respaldos o confirmar presentaciones.';
  end if;

  file_value:=p_payload->'file';
  if file_value is not null then
    if jsonb_typeof(file_value)<>'object' or document_value<>'file_upload' then raise exception 'El archivo de respaldo no corresponde al tipo seleccionado.';end if;
    file_name_value:=nullif(trim(file_value->>'name'),'');
    mime_value:=file_value->>'mimeType';
    size_value:=nullif(file_value->>'size','')::bigint;
    path_value:=file_value->>'storagePath';
    if file_name_value is null or length(file_name_value)>255 or file_name_value~'[\x00-\x1F\\/]' then raise exception 'El nombre del archivo no es válido.';end if;
    if mime_value not in('application/pdf','image/jpeg','image/png')or size_value not between 1 and 5242880 then raise exception 'Solo se permiten PDF, JPG o PNG de hasta 5 MB.';end if;
    if path_value is null or path_value!~('^'||sid::text||'/'||event_key::text||'/[A-Za-z0-9._-]+$')or length(path_value)>700 then raise exception 'La ruta del respaldo no es válida para esta obligación.';end if;
  elsif document_value='file_upload' and not exists(select 1 from public.tax_calendar_documents where event_id=event_key) then
    raise exception 'Adjunte el archivo de respaldo.';
  end if;
  if document_value='external_url' and(link_value is null or link_value!~*'^https://[^[:space:]]+$')then raise exception 'Ingrese un enlace externo HTTPS válido.';end if;

  if not found_event then
    insert into public.tax_calendar_events(id,subsidiary_id,tax_type_code,period,due_date,assigned_user_id,status,document_type,document_url,external_link,filing_date,filing_reference_number,notes,created_by)
    values(event_key,sid,code_value,period_value,due_value,assigned_value,status_value,document_value,
      case when document_value='file_upload'then'/api/tax-calendar/events/'||event_key::text||'/document'end,
      case when document_value='external_url'then link_value end,filing_value,reference_value,notes_value,uid);
  else
    update public.tax_calendar_events set subsidiary_id=sid,tax_type_code=code_value,period=period_value,due_date=due_value,
      assigned_user_id=assigned_value,status=status_value,document_type=document_value,
      document_url=case when document_value='file_upload'then'/api/tax-calendar/events/'||event_key::text||'/document'end,
      external_link=case when document_value='external_url'then link_value end,
      filing_date=case when status_value='filed'then filing_value end,
      filing_reference_number=case when status_value='filed'then reference_value end,
      notes=notes_value,updated_by=uid
    where id=event_key;
    if due_value is distinct from prior.due_date then update public.tax_calendar_reminders set is_sent=false,sent_at=null where event_id=event_key;end if;
  end if;

  select storage_path into old_path from public.tax_calendar_documents where event_id=event_key;
  if file_value is not null then
    insert into public.tax_calendar_documents(event_id,storage_path,file_name,mime_type,file_size,uploaded_by)
    values(event_key,path_value,file_name_value,mime_value,size_value,uid)
    on conflict(event_id)do update set storage_path=excluded.storage_path,file_name=excluded.file_name,mime_type=excluded.mime_type,file_size=excluded.file_size,uploaded_by=excluded.uploaded_by;
  elsif document_value<>'file_upload' then
    delete from public.tax_calendar_documents where event_id=event_key;
  end if;

  if can_manage and p_payload ? 'followers' then
    if jsonb_typeof(p_payload->'followers')<>'array' then raise exception 'La lista de seguidores no es válida.';end if;
    delete from public.tax_calendar_followers where event_id=event_key;
    for item in select value from jsonb_array_elements(p_payload->'followers')loop
      follower_user:=nullif(item->>'userId','')::bigint;
      if follower_user is null or not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)where u.user_id=follower_user and u.is_active and us.subsidiary_id=sid)then raise exception 'Todos los seguidores deben ser usuarios activos autorizados en la subsidiaria.';end if;
      if item->>'notificationChannel'not in('email','in_app','both')then raise exception 'Seleccione un canal de notificación válido.';end if;
      insert into public.tax_calendar_followers(event_id,user_id,notification_channel)values(event_key,follower_user,item->>'notificationChannel')
      on conflict(event_id,user_id)do update set notification_channel=excluded.notification_channel;
    end loop;
  end if;

  if can_manage and p_payload ? 'reminders' then
    if jsonb_typeof(p_payload->'reminders')<>'array' then raise exception 'La lista de recordatorios no es válida.';end if;
    delete from public.tax_calendar_reminders where event_id=event_key;
    for item in select value from jsonb_array_elements(p_payload->'reminders')loop
      reminder_days:=nullif(item->>'daysBeforeDue','')::integer;
      if reminder_days not between 0 and 365 then raise exception 'Los días de recordatorio deben estar entre 0 y 365.';end if;
      insert into public.tax_calendar_reminders(event_id,days_before_due)values(event_key,reminder_days)on conflict do nothing;
    end loop;
  elsif not found_event then
    insert into public.tax_calendar_reminders(event_id,days_before_due)values(event_key,7),(event_key,3),(event_key,1),(event_key,0);
  end if;
  return jsonb_build_object('success',true,'id',event_key,'obsoleteStoragePath',case when old_path is distinct from path_value then old_path end);
end$$;

create or replace function public.tax_calendar_document(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare e public.tax_calendar_events%rowtype;d public.tax_calendar_documents%rowtype;
begin
  select * into e from public.tax_calendar_events where id=p_event_id;
  if e.id is null or not public.tax_calendar_can(e.subsidiary_id,'tax_calendar.view') then raise exception using errcode='42501',message='No tiene acceso al respaldo solicitado.';end if;
  select * into d from public.tax_calendar_documents where event_id=p_event_id;
  if d.id is null then raise exception 'La obligación no tiene un archivo de respaldo.';end if;
  return jsonb_build_object('eventId',e.id,'storagePath',d.storage_path,'fileName',d.file_name,'mimeType',d.mime_type,'fileSize',d.file_size);
end$$;

create or replace function public.tax_calendar_enqueue_recipient(
  p_event_id uuid,p_user_id bigint,p_channel text,p_kind text,p_reminder_id uuid,p_days integer,p_priority text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.tax_calendar_events%rowtype;u public.users%rowtype;s public.subsidiaries%rowtype;assigned_name text;key_base text;title_value text;message_value text;payload_value jsonb;
begin
  if p_user_id is null or p_channel not in('email','in_app','both')then return;end if;
  select * into e from public.tax_calendar_events where id=p_event_id;
  select * into u from public.users where user_id=p_user_id and is_active;
  select * into s from public.subsidiaries where subsidiary_id=e.subsidiary_id;
  if e.id is null or u.user_id is null or not exists(select 1 from public.user_subsidiaries us where us.user_id=p_user_id and us.subsidiary_id=e.subsidiary_id)then return;end if;
  select trim(concat_ws(' ',first_name,last_name))into assigned_name from public.users where user_id=e.assigned_user_id;
  key_base:=p_kind||':'||e.id::text||':'||coalesce(p_reminder_id::text,e.due_date::text)||':'||p_user_id::text;
  title_value:=case when p_kind='overdue'then'Obligación tributaria vencida'else'Recordatorio tributario · '||e.tax_type_code end;
  message_value:=case when p_kind='overdue'then e.tax_type_code||' del período '||e.period||' venció el '||to_char(e.due_date,'DD/MM/YYYY')||'.' when p_days=0 then e.tax_type_code||' vence hoy.'else e.tax_type_code||' vence en '||p_days||case when p_days=1 then' día.'else' días.'end end;
  payload_value:=jsonb_build_object('taxTypeCode',e.tax_type_code,'period',e.period,'dueDate',e.due_date,'daysBeforeDue',p_days,
    'status',case when p_kind='overdue'then'overdue'else e.status end,'subsidiaryName',s.name,'assignedUserName',assigned_name,
    'deepLink','/tax-calendar.html?event='||e.id::text);
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

create or replace function public.tax_calendar_schedule(p_clock timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.tax_calendar_events%rowtype;r public.tax_calendar_reminders%rowtype;f record;local_day date;days_left integer;supervisor bigint;scheduled_count integer:=0;overdue_count integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Esta función es exclusiva del servicio interno.';end if;
  if not pg_try_advisory_xact_lock(hashtextextended('tax-calendar-schedule',0))then return jsonb_build_object('scheduled',0,'overdue',0,'busy',true);end if;
  for e in select * from public.tax_calendar_events where status not in('filed','exempt') order by due_date,id for update skip locked loop
    local_day:=public.tax_calendar_local_date(e.subsidiary_id,p_clock);
    if e.due_date<local_day and e.status in('pending','in_review')then
      update public.tax_calendar_events set status='overdue'where id=e.id;
      overdue_count:=overdue_count+1;
      select coalesce(s.tax_supervisor_user_id,
        case when s.administrative_approver~'^user:[1-9][0-9]*$'then split_part(s.administrative_approver,':',2)::bigint
             when s.administrative_approver~'^employee:[1-9][0-9]*$'then(select em.user_id from public.employees em where em.employee_id=split_part(s.administrative_approver,':',2)::bigint)end)
      into supervisor from public.subsidiaries s where s.subsidiary_id=e.subsidiary_id;
      perform public.tax_calendar_enqueue_recipient(e.id,supervisor,'both','overdue',null,e.due_date-local_day,'high');
    end if;
    days_left:=e.due_date-local_day;
    for r in select * from public.tax_calendar_reminders where event_id=e.id and not is_sent and days_before_due=days_left for update skip locked loop
      perform public.tax_calendar_enqueue_recipient(e.id,e.assigned_user_id,'both','reminder',r.id,r.days_before_due,'normal');
      for f in select user_id,notification_channel from public.tax_calendar_followers where event_id=e.id loop
        perform public.tax_calendar_enqueue_recipient(e.id,f.user_id,f.notification_channel,'reminder',r.id,r.days_before_due,'normal');
      end loop;
      update public.tax_calendar_reminders set is_sent=true,sent_at=p_clock where id=r.id;
      scheduled_count:=scheduled_count+1;
    end loop;
  end loop;
  return jsonb_build_object('scheduled',scheduled_count,'overdue',overdue_count,'busy',false);
end$$;

create or replace function public.tax_calendar_claim() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare job public.tax_calendar_email_outbox%rowtype;token uuid:=gen_random_uuid();
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Esta función es exclusiva del servicio interno.';end if;
  update public.tax_calendar_email_outbox set status='ERROR',last_error='La preparación excedió el tiempo permitido.',finished_at=now(),lease=null,lease_until=null
  where status='PREPARANDO'and lease_until<now();
  update public.tax_calendar_email_outbox set status='INCIERTO',last_error='No se confirmó el resultado SMTP antes de vencer la concesión.',finished_at=now(),lease=null,lease_until=null
  where status='ENVIANDO'and lease_until<now();
  select * into job from public.tax_calendar_email_outbox where status='PENDIENTE'order by created_at,id for update skip locked limit 1;
  if job.id is null then return null;end if;
  update public.tax_calendar_email_outbox set status='PREPARANDO',lease=token,lease_until=now()+interval'5 minutes'where id=job.id;
  return jsonb_build_object('id',job.id,'lease',token,'event_id',job.event_id,'subsidiary_id',job.subsidiary_id,
    'recipient_user_id',job.recipient_user_id,'recipient_email',job.recipient_email,'priority',job.priority,'payload',job.payload);
end$$;

create or replace function public.tax_calendar_begin_send(p_id uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Esta función es exclusiva del servicio interno.';end if;
  update public.tax_calendar_email_outbox set status='ENVIANDO',lease_until=now()+interval'5 minutes'
  where id=p_id and lease=p_lease and status='PREPARANDO'and lease_until>now();
  return found;
end$$;

create or replace function public.tax_calendar_finish(p_id uuid,p_lease uuid,p_status text,p_message text default null,p_error text default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Esta función es exclusiva del servicio interno.';end if;
  if p_status not in('ENVIADO','ERROR','INCIERTO')then raise exception 'Estado final de correo no válido.';end if;
  update public.tax_calendar_email_outbox set status=p_status,message_id=nullif(p_message,''),last_error=nullif(p_error,''),
    sent_at=case when p_status='ENVIADO'then now()end,finished_at=now(),lease=null,lease_until=null
  where id=p_id and lease=p_lease and status in('PREPARANDO','ENVIANDO');
  return found;
end$$;

revoke all on function public.tax_calendar_has_permission(text),public.tax_calendar_can(bigint,text),
 public.tax_calendar_local_date(bigint,timestamptz),public.tax_calendar_manage(text,jsonb),public.tax_calendar_document(uuid),
 public.tax_calendar_enqueue_recipient(uuid,bigint,text,text,uuid,integer,text),public.tax_calendar_schedule(timestamptz),
 public.tax_calendar_claim(),public.tax_calendar_begin_send(uuid,uuid),public.tax_calendar_finish(uuid,uuid,text,text,text)
from public,anon,authenticated,service_role;

grant execute on function public.tax_calendar_manage(text,jsonb),public.tax_calendar_document(uuid) to authenticated;
grant execute on function public.tax_calendar_schedule(timestamptz),public.tax_calendar_claim(),
 public.tax_calendar_begin_send(uuid,uuid),public.tax_calendar_finish(uuid,uuid,text,text,text) to service_role;

notify pgrst,'reload schema';
