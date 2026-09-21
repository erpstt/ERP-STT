create table public.scheduled_reports(
 id bigint generated always as identity primary key,subsidiary_id bigint not null references subsidiaries,
 owner_id bigint not null references users,name text not null check(length(trim(name))between 1 and 100),
 report_kind text not null check(report_kind in('AR','AP')),frequency text not null check(frequency in('WEEKLY','MONTHLY')),
 weekday integer not null default 1 check(weekday between 0 and 6),month_day integer not null default 1 check(month_day between 1 and 31),
 send_time time not null,cutoff_rule text not null check(cutoff_rule in('PREVIOUS_DAY','PREVIOUS_MONTH_END','SEND_DATE')),
 recipients text[] not null check(cardinality(recipients)between 1 and 20),format text not null check(format in('PDF','CSV','BOTH')),
 active boolean not null default false,archived boolean not null default false,next_run_at timestamptz not null,
 revision integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.scheduled_report_jobs(
 id uuid primary key default gen_random_uuid(),schedule_id bigint not null references scheduled_reports,subsidiary_id bigint not null references subsidiaries,
 occurrence timestamptz not null,cutoff date not null,recipient text not null,configuration jsonb not null,
 status text not null default 'PENDIENTE'check(status in('PENDIENTE','PREPARANDO','ENVIANDO','ENVIADO','ERROR','INCIERTO','CANCELADO')),
 lease uuid,lease_until timestamptz,message_id text,last_error text,created_at timestamptz not null default now(),finished_at timestamptz,
 unique(schedule_id,occurrence,recipient)
);
create index scheduled_reports_due on scheduled_reports(next_run_at)where active and not archived;
create index scheduled_report_jobs_pending on scheduled_report_jobs(created_at)where status='PENDIENTE';
alter table scheduled_reports enable row level security;alter table scheduled_report_jobs enable row level security;
revoke all on scheduled_reports,scheduled_report_jobs from public,anon,authenticated;
insert into permissions(code,module,description)values('REPORT_SCHEDULE_MANAGE','Informes','Configurar envíos programados de reportes y consultar su historial.')on conflict(code)do nothing;
insert into role_permissions(role_id,permission_id)select r.role_id,p.permission_id from roles r cross join permissions p where p.code='REPORT_SCHEDULE_MANAGE'and(r.role_id in(2,5)or lower(r.role_name)in('administrador','administrator','admin'))on conflict do nothing;

create function scheduled_report_access()returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();begin
 if app_user_id()is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)
 or not(app_is_admin()or exists(select 1 from role_permissions rp join permissions p using(permission_id)where rp.role_id=app_active_role_id()and p.code='REPORT_SCHEDULE_MANAGE'))then raise exception using errcode='42501',message='No tiene permiso para administrar envíos programados en esta sociedad.';end if;
 return sid;
end$$;
-- Day 29/30/31 falls on the last available day of shorter months. All wall times are Costa Rica.
create function scheduled_report_occurrence(p_frequency text,p_weekday int,p_day int,p_time time,p_clock timestamptz,p_next boolean)
returns timestamptz language sql stable set search_path=public,pg_temp as $$
 with dates as(select (p_clock at time zone 'America/Costa_Rica')::date+i d from generate_series(case when p_next then 0 else -35 end,case when p_next then 35 else 0 end)i),
 candidates as(select(d+p_time)at time zone 'America/Costa_Rica't from dates where
 (p_frequency='WEEKLY'and extract(dow from d)=p_weekday)or
 (p_frequency='MONTHLY'and extract(day from d)=least(p_day,extract(day from(date_trunc('month',d)+interval '1 month -1 day'))::int)))
 select t from candidates where case when p_next then t>p_clock else t<=p_clock end order by case when p_next then t end asc,case when not p_next then t end desc limit 1
$$;
create function scheduled_report_cutoff(p_rule text,p_occurrence timestamptz)returns date language sql stable as $$
 select case p_rule when 'PREVIOUS_MONTH_END'then date_trunc('month',p_occurrence at time zone 'America/Costa_Rica')::date-1 when 'PREVIOUS_DAY'then(p_occurrence at time zone 'America/Costa_Rica')::date-1 else(p_occurrence at time zone 'America/Costa_Rica')::date end
$$;

create function scheduled_report_manage(p_action text,p jsonb default '{}')returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=scheduled_report_access();s scheduled_reports%rowtype;emails text[];key bigint:=nullif(p->>'id','')::bigint;next_time timestamptz;
begin
 if p_action='list'then
 return jsonb_build_object('company',(select jsonb_build_object('id',subsidiary_id,'name',name)from subsidiaries where subsidiary_id=sid),'timezone','America/Costa_Rica',
 'schedules',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('lastStatus',(select j.status from scheduled_report_jobs j where j.schedule_id=x.id order by j.created_at desc limit 1))order by x.id desc)from scheduled_reports x where x.subsidiary_id=sid and not x.archived),'[]'),
 'history',coalesce((select jsonb_agg(to_jsonb(x)order by created_at desc)from(select j.id,j.schedule_id,j.occurrence,j.cutoff,j.recipient,j.status,j.last_error,j.message_id,j.created_at,j.finished_at,j.configuration->>'name'name,j.configuration->>'report_kind'report_kind from scheduled_report_jobs j where j.subsidiary_id=sid order by j.created_at desc limit 100)x),'[]'));
 end if;
 if key is not null then
 select * into s from scheduled_reports where id=key and subsidiary_id=sid and not archived for update;
 if s.id is null then raise exception 'Programación no encontrada.';end if;
 if s.revision is distinct from(p->>'revision')::int then raise exception 'La programación cambió. Actualice la pantalla.';end if;
 end if;
 if p_action='save'then
 if jsonb_typeof(p->'recipients')is distinct from 'array'then raise exception 'Ingrese los destinatarios.';end if;
 select array_agg(distinct lower(trim(value)))into emails from jsonb_array_elements_text(p->'recipients');
 if coalesce(cardinality(emails),0)not between 1 and 20 or exists(select 1 from unnest(emails)e where length(e)>254 or e!~'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$')then raise exception 'Ingrese entre 1 y 20 correos válidos.';end if;
 if coalesce(p->>'time','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'then raise exception 'Seleccione una hora válida.';end if;
 next_time:=scheduled_report_occurrence(p->>'frequency',(p->>'weekday')::int,(p->>'monthDay')::int,(p->>'time')::time,now(),true);
 if key is null then
 insert into scheduled_reports(subsidiary_id,owner_id,name,report_kind,frequency,weekday,month_day,send_time,cutoff_rule,recipients,format,active,next_run_at)
 values(sid,app_user_id(),trim(p->>'name'),p->>'report',p->>'frequency',(p->>'weekday')::int,(p->>'monthDay')::int,(p->>'time')::time,p->>'cutoff',emails,p->>'format',coalesce((p->>'active')::boolean,false),next_time)returning id into key;
 else
 update scheduled_reports set owner_id=app_user_id(),name=trim(p->>'name'),report_kind=p->>'report',frequency=p->>'frequency',weekday=(p->>'weekday')::int,month_day=(p->>'monthDay')::int,send_time=(p->>'time')::time,cutoff_rule=p->>'cutoff',recipients=emails,format=p->>'format',active=coalesce((p->>'active')::boolean,false),next_run_at=next_time,revision=revision+1,updated_at=now()where id=key;
 end if;
 elsif p_action in('toggle','delete')and key is not null then
 update scheduled_reports set active=case when p_action='delete'then false else coalesce((p->>'active')::boolean,false)end,archived=p_action='delete',revision=revision+1,updated_at=now(),next_run_at=scheduled_report_occurrence(frequency,weekday,month_day,send_time,now(),true)where id=key;
 else raise exception 'Acción inválida.';end if;
 update scheduled_report_jobs set status='CANCELADO',last_error='La programación fue modificada, pausada o eliminada.',finished_at=now(),lease=null,lease_until=null where schedule_id=key and status in('PENDIENTE','PREPARANDO');
 return(select to_jsonb(x)from scheduled_reports x where id=key);
end$$;

create function scheduled_report_snapshot(p_sid bigint,p_kind text,p_cutoff date)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare report jsonb;rows jsonb:='[]';page int:=1;begin
 if coalesce(auth.role(),'')<>'service_role'and p_sid is distinct from scheduled_report_access()then raise exception 'Sociedad no autorizada.';end if;
 if p_kind not in('AR','AP')or p_kind is null or p_cutoff is null then raise exception 'Reporte o fecha de corte inválidos.';end if;
 loop
 report:=run_aging_report(p_kind,jsonb_build_object('subsidiaryIds',jsonb_build_array(p_sid),'dateTo',p_cutoff,'agingCurrencyMode','LOCAL','onlyPending',true,'page',page,'pageSize',250));
 if coalesce((report->>'total')::int,0)>20000 then raise exception 'El reporte supera 20.000 documentos. No se enviará un archivo incompleto.';end if;
 rows:=rows||coalesce(report->'rows','[]');exit when page*250>=coalesce((report->>'total')::int,0);page:=page+1;
 end loop;
 return jsonb_build_object('kind',p_kind,'cutoff',p_cutoff,'company',(select name from subsidiaries where subsidiary_id=p_sid),'currency',(select c.currency_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=p_sid),'rows',rows,'summary',report->'summary');
end$$;

create function scheduled_report_owner_allowed(p_user bigint,p_sid bigint)returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from users u join user_subsidiaries us on us.user_id=u.user_id join user_roles ur on ur.user_id=u.user_id join role_permissions rp on rp.role_id=ur.role_id join permissions p using(permission_id)
 where u.user_id=p_user and us.subsidiary_id=p_sid and coalesce((to_jsonb(u)->>'is_active')::boolean,true)and p.code='REPORT_SCHEDULE_MANAGE')
$$;

create function scheduled_report_schedule()returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare s scheduled_reports%rowtype;due timestamptz;count int:=0;begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Operación exclusiva del servicio.';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('scheduled-reports',0))then return 0;end if;
 for s in select * from scheduled_reports where active and not archived and next_run_at<=now()order by next_run_at limit 50 for update skip locked loop
 if not scheduled_report_owner_allowed(s.owner_id,s.subsidiary_id)then update scheduled_reports set active=false,revision=revision+1 where id=s.id;continue;end if;
 due:=scheduled_report_occurrence(s.frequency,s.weekday,s.month_day,s.send_time,now(),false);
 insert into scheduled_report_jobs(schedule_id,subsidiary_id,occurrence,cutoff,recipient,configuration)
 select s.id,s.subsidiary_id,due,scheduled_report_cutoff(s.cutoff_rule,due),e,to_jsonb(s) from unnest(s.recipients)e on conflict(schedule_id,occurrence,recipient)do nothing;
 update scheduled_reports set next_run_at=scheduled_report_occurrence(s.frequency,s.weekday,s.month_day,s.send_time,now(),true)where id=s.id;
 count:=count+1;
 end loop;return count;
end$$;
create function scheduled_report_claim()returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j scheduled_report_jobs%rowtype;begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Operación exclusiva del servicio.';end if;
 update scheduled_report_jobs set status=case when status='ENVIANDO'then 'INCIERTO'else 'ERROR'end,last_error='El procesamiento se interrumpió. No se reenvía automáticamente para evitar duplicados.',finished_at=now(),lease=null where status in('PREPARANDO','ENVIANDO')and lease_until<now();
 select x.* into j from scheduled_report_jobs x join scheduled_reports s on s.id=x.schedule_id where x.status='PENDIENTE'and s.active and not s.archived and scheduled_report_owner_allowed(s.owner_id,s.subsidiary_id)order by x.created_at limit 1 for update of x skip locked;
 if j.id is null then return null;end if;
 update scheduled_report_jobs set status='PREPARANDO',lease=gen_random_uuid(),lease_until=now()+interval '10 minutes'where id=j.id returning * into j;
 return to_jsonb(j);
end$$;
create function scheduled_report_begin_send(p_id uuid,p_lease uuid)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare schedule_key bigint;begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Operación exclusiva del servicio.';end if;
 select schedule_id into schedule_key from scheduled_report_jobs where id=p_id and lease=p_lease;
 perform 1 from scheduled_reports where id=schedule_key for update;
 update scheduled_report_jobs j set status='ENVIANDO',lease_until=now()+interval '10 minutes'where j.id=p_id and j.lease=p_lease and j.status='PREPARANDO'and j.lease_until>now()and exists(select 1 from scheduled_reports s where s.id=j.schedule_id and s.active and not s.archived and scheduled_report_owner_allowed(s.owner_id,s.subsidiary_id));
 return found;
end$$;
create function scheduled_report_finish(p_id uuid,p_lease uuid,p_status text,p_message text default null,p_error text default null)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if coalesce(auth.role(),'')<>'service_role'or p_status not in('ENVIADO','ERROR','INCIERTO')then raise exception 'Estado o acceso inválido.';end if;
 update scheduled_report_jobs set status=p_status,message_id=left(p_message,500),last_error=left(p_error,1000),finished_at=now(),lease_until=null where id=p_id and lease=p_lease and status in('PREPARANDO','ENVIANDO');return found;
end$$;
do $$declare f record;begin for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'scheduled_report_%'loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);end loop;end$$;
grant execute on function scheduled_report_manage(text,jsonb),scheduled_report_snapshot(bigint,text,date)to authenticated;
grant execute on function scheduled_report_snapshot(bigint,text,date),scheduled_report_schedule(),scheduled_report_claim(),scheduled_report_begin_send(uuid,uuid),scheduled_report_finish(uuid,uuid,text,text,text)to service_role;
notify pgrst,'reload schema';
