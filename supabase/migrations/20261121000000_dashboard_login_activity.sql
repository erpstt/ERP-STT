-- Login summaries use successful authentication records, not financial transactions.
-- A login is global: scope is the current membership of users in the active company.
set local lock_timeout='5s';
create or replace function public.run_managerial_dashboard(p_month text,p_role_id bigint default null,p_user_id bigint default null,p_subsidiary_id bigint default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;first_day date;previous_day date;next_day date;result jsonb;
begin
 sid:=asset_posting_private.access('dashboard:managerial','view');
 if p_subsidiary_id is not null and p_subsidiary_id<>sid then raise exception using errcode='42501',message='Seleccione la sociedad desde la barra principal del ERP.';end if;
 if p_month is null or p_month!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then raise exception using errcode='22023',message='Seleccione un mes válido.';end if;
 first_day:=(p_month||'-01')::date;previous_day:=(first_day-interval '1 month')::date;next_day:=(first_day+interval '1 month')::date;
 if first_day<'2000-01-01' or first_day>'2100-12-01'then raise exception using errcode='22023',message='El año debe estar entre 2000 y 2100.';end if;
 if p_role_id is not null and not exists(select 1 from public.roles where role_id=p_role_id)then raise exception using errcode='22023',message='Rol inválido.';end if;
 if p_user_id is not null and not exists(select 1 from public.users u where u.user_id=p_user_id and (exists(select 1 from public.user_subsidiaries us where us.user_id=u.user_id and us.subsidiary_id=sid)or exists(select 1 from dashboard_private.events(sid,previous_day,next_day)e where e.actor_id=u.auth_user_id::text or (e.actor_id is null and e.legacy_user_id=u.user_id))))then raise exception using errcode='42501',message='Usuario no disponible en esta sociedad.';end if;
 with raw as materialized(select e.* from dashboard_private.events(sid,previous_day,next_day)e left join public.journal attached on attached.journal_id=e.journal_id and attached.subsidiary_id=sid where lower(coalesce(attached.status,''))not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed','reversado','reversada')),
 transaction_priority as(select transaction_id,min(priority)as priority from raw where transaction_id is not null group by transaction_id),
 journal_priority as(select journal_id,min(priority)as priority from raw where journal_id is not null group by journal_id),
 unique_events as materialized(select e.* from raw e left join transaction_priority t using(transaction_id)left join journal_priority j using(journal_id)where e.priority<=coalesce(t.priority,e.priority)and e.priority<=coalesce(j.priority,e.priority)),
 owners as materialized(select e.*,u.user_id as owner_id,coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),case when e.actor_type in('SYSTEM_JOB','AI_AGENT','EXTERNAL_API')then 'Proceso de sistema / integración' else 'Sin autor histórico identificado' end)as owner_name,c.role_id as captured_role,c.role_name as captured_name
 from unique_events e left join dashboard_private.creators c on c.source=e.source and c.row_id=e.row_id
 left join public.users u on e.actor_id=u.auth_user_id::text or(e.actor_id is null and u.user_id=coalesce(e.legacy_user_id,c.user_id))),
 selected as materialized(select * from owners e where (p_user_id is null or e.owner_id=p_user_id)and(p_role_id is null or e.captured_role=p_role_id or(e.captured_role is null and exists(select 1 from public.user_roles ur where ur.user_id=e.owner_id and ur.role_id=p_role_id)))),
 kinds(key,label,icon)as(values('sales','Facturas de venta','↗'),('purchases','Facturas de proveedor','↙'),('manual','Asientos manuales','≡'),('automatic','Asientos automáticos','⚙'),('collections','Cobros e ingresos','+'),('payments','Pagos y egresos','−'),('transfers','Transferencias','⇄'),('other','Notas y otros documentos','▤'),('requests','Solicitudes de pago','▧'),('approvals','Aprobaciones','✓')),
 metrics as(select k.key,k.label,k.icon,count(*)filter(where s.day>=first_day)as current_count,count(*)filter(where s.day<first_day)as previous_count from kinds k left join selected s on s.kind=k.key group by k.key,k.label,k.icon),
 operation_activity as(select coalesce(owner_id::text,case when actor_type in('SYSTEM_JOB','AI_AGENT','EXTERNAL_API')then 'system' else 'unknown' end)as owner_key,max(owner_id)as user_id,max(owner_name)as name,
 array_agg(distinct captured_name)filter(where captured_name is not null)as captured_names,bool_or(captured_role is null)as historical,
 count(*)filter(where kind='sales')as sales,count(*)filter(where kind='purchases')as purchases,count(*)filter(where kind='manual')as manual,count(*)filter(where kind='automatic')as automatic,count(*)filter(where kind='collections')as collections,count(*)filter(where kind='payments')as payments,count(*)filter(where kind='transfers')as transfers,count(*)filter(where kind='other')as other,count(*)filter(where kind='requests')as requests,count(*)filter(where kind='approvals')as approvals,count(*)as total from selected where day>=first_day group by 1),
 login_zone as materialized(select valid_tz.name as iana,case when tz.utc_offset~'^UTC[+-]([01][0-9]|2[0-3]):[0-5][0-9]$'then substring(tz.utc_offset from 4)::interval else interval '0'end as utc_offset,coalesce(valid_tz.name,tz.utc_offset,'UTC')as label from public.subsidiaries s left join public.timezones tz on tz.timezone_id=s.timezone_id left join pg_catalog.pg_timezone_names valid_tz on valid_tz.name=tz.name where s.subsidiary_id=sid),
 login_activity as materialized(select h.user_id,count(*)as logins,max(h.login_time)as last_login from public.login_history h cross join login_zone z
 where h.status='EXITOSO'and h.login_time>=(case when z.iana is not null then first_day::timestamp at time zone z.iana else first_day::timestamp at time zone z.utc_offset end)and h.login_time<(case when z.iana is not null then next_day::timestamp at time zone z.iana else next_day::timestamp at time zone z.utc_offset end)
 and exists(select 1 from public.user_subsidiaries us where us.user_id=h.user_id and us.subsidiary_id=sid)
 and(p_user_id is null or h.user_id=p_user_id)and(p_role_id is null or exists(select 1 from public.user_roles ur where ur.user_id=h.user_id and ur.role_id=p_role_id))group by h.user_id),
 activity as(select coalesce(o.owner_key,l.user_id::text)as owner_key,coalesce(o.user_id,l.user_id)as user_id,coalesce(o.name,nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),'Usuario #'||l.user_id)as name,o.captured_names,coalesce(o.historical,false)as historical,
 coalesce(o.sales,0)as sales,coalesce(o.purchases,0)as purchases,coalesce(o.manual,0)as manual,coalesce(o.automatic,0)as automatic,coalesce(o.collections,0)as collections,coalesce(o.payments,0)as payments,coalesce(o.transfers,0)as transfers,coalesce(o.other,0)as other,coalesce(o.requests,0)as requests,coalesce(o.approvals,0)as approvals,coalesce(o.total,0)as total,coalesce(l.logins,0)as logins,
 to_char(case when z.iana is not null then l.last_login at time zone z.iana else l.last_login at time zone z.utc_offset end,'YYYY-MM-DD"T"HH24:MI:SS')as last_login
 from operation_activity o full join login_activity l on l.user_id=o.user_id left join public.users u on u.user_id=l.user_id cross join login_zone z),
 daily_counts as materialized(select day,kind,count(*)as n from selected where day>=first_day group by day,kind),
 money_totals as materialized(select s.kind,coalesce(c.currency_code,'Sin moneda')as currency,round(sum(s.amount),2)as total from selected s left join public.currencies c on c.currency_id=s.currency_id where s.day>=first_day and s.amount is not null group by s.kind,c.currency_code),
 owner_role_options as materialized(select distinct owner_id,captured_role from owners where owner_id is not null),
 company_users as(select u.user_id,coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),'Usuario #'||u.user_id)as name,u.is_active from public.users u where exists(select 1 from public.user_subsidiaries us where us.user_id=u.user_id and us.subsidiary_id=sid)or exists(select 1 from owners e where e.owner_id=u.user_id))
 select jsonb_build_object(
 'company',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code)from public.subsidiaries s left join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sid),
 'month',p_month,'previousMonth',to_char(previous_day,'YYYY-MM'),
 'filters',jsonb_build_object('roleId',p_role_id,'userId',p_user_id),
 'roles',(select coalesce(jsonb_agg(jsonb_build_object('id',r.role_id,'name',r.role_name)order by r.role_name),'[]')from public.roles r),
 'users',(select coalesce(jsonb_agg(jsonb_build_object('id',u.user_id,'name',u.name,'active',u.is_active,'roleIds',(select coalesce(jsonb_agg(distinct role_id),'[]')from(select role_id from public.user_roles where user_id=u.user_id union select captured_role from owner_role_options where owner_id=u.user_id and captured_role is not null)x))order by u.name),'[]')from company_users u),
 'kpis',(select jsonb_agg(jsonb_build_object('key',k.key,'label',k.label,'icon',k.icon,'count',k.current_count,'previous',k.previous_count,'variation',case when k.previous_count=0 then case when k.current_count=0 then 0 else null end else round((k.current_count-k.previous_count)*100.0/k.previous_count,2)end,'amounts',(select coalesce(jsonb_agg(a),'[]')from(select currency,total from money_totals where kind=k.key order by currency)a))order by array_position(array['sales','purchases','manual','automatic','collections','payments','transfers','other','requests','approvals'],k.key))from metrics k),
 'daily',(select jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'total',(select coalesce(sum(n),0)from daily_counts s where s.day=d::date),'values',(select jsonb_object_agg(k.key,(select coalesce(sum(n),0)from daily_counts s where s.day=d::date and s.kind=k.key))from kinds k))order by d)from generate_series(first_day,next_day-interval '1 day',interval '1 day')d),
 'activity',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('roles',coalesce(nullif(array_to_string(a.captured_names,', '),''),(select string_agg(r.role_name,', 'order by r.role_name)from public.user_roles ur join public.roles r using(role_id)where ur.user_id=a.user_id),'Sin rol histórico'))order by a.total desc,a.name),'[]')from activity a),
 'total',(select count(*)from selected where day>=first_day),'previousTotal',(select count(*)from selected where day<first_day),
 'historicalRoleCount',(select count(*)from selected where day>=first_day and captured_role is null),
 'unidentifiedCount',(select count(*)from selected where day>=first_day and owner_id is null),
 'openingCount',(select count(*)from selected where day>=first_day and opening),
 'loginCount',(select coalesce(sum(logins),0)from login_activity),'loginUsers',(select count(*)from login_activity),'loginTimezone',(select label from login_zone),
 'generatedAt',now()
 )into result;
 return result;
end$$;
revoke all on function public.run_managerial_dashboard(text,bigint,bigint,bigint)from public,anon,authenticated,service_role;
grant execute on function public.run_managerial_dashboard(text,bigint,bigint,bigint)to authenticated;
create index dashboard_login_period on public.login_history(login_time,user_id)where status='EXITOSO';
notify pgrst,'reload schema';
