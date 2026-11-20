-- Read-only dashboard aggregation and prospective creator-role attribution.
set local lock_timeout='5s';
create schema dashboard_private;
revoke all on schema dashboard_private from public,anon,authenticated,service_role;
create table dashboard_private.creators(source text not null,row_id bigint not null,user_id bigint,role_id bigint,role_name text,recorded_at timestamptz not null default now(),primary key(source,row_id));
alter table dashboard_private.creators enable row level security;
revoke all on dashboard_private.creators from public,anon,authenticated,service_role;
create function dashboard_private.capture_creator()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare uid bigint;rid bigint;rname text;begin
 if auth.uid() is not null then
  uid:=public.app_user_id();rid:=public.app_active_role_id();
  select r.role_name into rname from public.roles r join public.user_roles ur using(role_id) where ur.user_id=uid and r.role_id=rid;
  if rname is null then rid:=null;end if;
 end if;
 insert into dashboard_private.creators(source,row_id,user_id,role_id,role_name)values(tg_table_name,(to_jsonb(new)->>tg_argv[0])::bigint,uid,rid,rname)on conflict do nothing;
 return new;end$$;
create trigger dashboard_creator after insert on public.invoice for each row execute function dashboard_private.capture_creator('invoice_id');
create trigger dashboard_creator after insert on public.supplier_invoice for each row execute function dashboard_private.capture_creator('invoice_id');
create trigger dashboard_creator after insert on public.credit_note for each row execute function dashboard_private.capture_creator('cn_id');
create trigger dashboard_creator after insert on public.debit_note for each row execute function dashboard_private.capture_creator('dn_id');
create trigger dashboard_creator after insert on public.supplier_credit_note for each row execute function dashboard_private.capture_creator('cn_id');
create trigger dashboard_creator after insert on public.supplier_debit_note for each row execute function dashboard_private.capture_creator('dn_id');
create trigger dashboard_creator after insert on public.customer_payment for each row execute function dashboard_private.capture_creator('payment_id');
create trigger dashboard_creator after insert on public.supplier_payment for each row execute function dashboard_private.capture_creator('payment_id');
create trigger dashboard_creator after insert on public.bank_transfer for each row execute function dashboard_private.capture_creator('transfer_id');
create trigger dashboard_creator after insert on public.bank_check for each row execute function dashboard_private.capture_creator('check_id');
create trigger dashboard_creator after insert on public.bank_deposit for each row execute function dashboard_private.capture_creator('deposit_id');
create trigger dashboard_creator after insert on public.bank_fee for each row execute function dashboard_private.capture_creator('fee_id');
create trigger dashboard_creator after insert on public.journal for each row execute function dashboard_private.capture_creator('journal_id');
create function dashboard_private.events(p_sid bigint,p_start date,p_end date)returns table(source text,row_id bigint,day date,kind text,amount numeric,currency_id bigint,actor_id text,legacy_user_id bigint,actor_type text,transaction_id bigint,journal_id bigint,priority integer,opening boolean)
language sql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
select 'invoice'::text,a.invoice_id,a.invoice_date,'sales'::text,a.total_amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,10,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.invoice a  where a.subsidiary_id=p_sid and a.invoice_date>=p_start and a.invoice_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_invoice'::text,a.invoice_id,a.invoice_date,'purchases'::text,a.total_amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,10,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_invoice a  where a.subsidiary_id=p_sid and a.invoice_date>=p_start and a.invoice_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'credit_note'::text,a.cn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.credit_note a join public.invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'debit_note'::text,a.dn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.debit_note a join public.invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_credit_note'::text,a.cn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_credit_note a join public.supplier_invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_debit_note'::text,a.dn_id,a.note_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,20,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_debit_note a join public.supplier_invoice i on i.invoice_id=a.invoice_id where i.subsidiary_id=p_sid and a.note_date>=p_start and a.note_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'customer_payment'::text,a.payment_id,a.payment_date,'collections'::text,a.amount_received,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,30,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.customer_payment a join public.journal j on j.journal_id=a.journal_id where j.subsidiary_id=p_sid and a.payment_date>=p_start and a.payment_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'supplier_payment'::text,a.payment_id,a.payment_date,'payments'::text,a.amount_paid,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,30,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.supplier_payment a join public.journal j on j.journal_id=a.journal_id where j.subsidiary_id=p_sid and a.payment_date>=p_start and a.payment_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_transfer'::text,a.transfer_id,a.transfer_date,'transfers'::text,coalesce(a.source_amount,a.amount),ba.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,40,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_transfer a left join public.bank_account ba on ba.bank_account_id=a.from_account_id where a.subsidiary_id=p_sid and a.transfer_date>=p_start and a.transfer_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_check'::text,a.check_id,a.payment_date,'payments'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,50,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_check a  where a.subsidiary_id=p_sid and a.payment_date>=p_start and a.payment_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_deposit'::text,a.deposit_id,a.deposit_date,'collections'::text,a.total_amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,null::bigint,a.journal_id,50,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_deposit a  where a.subsidiary_id=p_sid and a.deposit_date>=p_start and a.deposit_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'bank_fee'::text,a.fee_id,a.fee_date,'other'::text,a.amount,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,50,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.bank_fee a  where a.subsidiary_id=p_sid and a.fee_date>=p_start and a.fee_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed')
union all
select 'journal'::text,a.journal_id,a.journal_date,case when tt.abbreviation in('ASI_DIA','ASI_PEN','ASI_NOM','ASI_LIQ') then 'manual' else 'automatic' end,null::numeric,a.currency_id,nullif(a.created_by_id::text,''),nullif(to_jsonb(a)->>'created_by','')::bigint,a.actor_type::text,a.transaction_id,a.journal_id,90,coalesce((to_jsonb(a)->>'is_opening_balance')::boolean,false) from public.journal a left join public.transaction_types tt on tt.name=a.journal_type where a.subsidiary_id=p_sid and a.journal_date>=p_start and a.journal_date<p_end and lower(coalesce(to_jsonb(a)->>'status','')) not in('anulado','anulada','cancelado','cancelada','void','voided','cancelled','reversed');
$$;

create function public.run_managerial_dashboard(p_month text,p_role_id bigint default null,p_user_id bigint default null,p_subsidiary_id bigint default null)returns jsonb
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
 kinds(key,label,icon)as(values('sales','Facturas de venta','↗'),('purchases','Facturas de proveedor','↙'),('manual','Asientos manuales','≡'),('automatic','Asientos automáticos','⚙'),('collections','Cobros e ingresos','+'),('payments','Pagos y egresos','−'),('transfers','Transferencias','⇄'),('other','Notas y otros documentos','▤')),
 metrics as(select k.key,k.label,k.icon,count(*)filter(where s.day>=first_day)as current_count,count(*)filter(where s.day<first_day)as previous_count from kinds k left join selected s on s.kind=k.key group by k.key,k.label,k.icon),
 activity as(select coalesce(owner_id::text,case when actor_type in('SYSTEM_JOB','AI_AGENT','EXTERNAL_API')then 'system' else 'unknown' end)as owner_key,max(owner_id)as user_id,max(owner_name)as name,
 array_agg(distinct captured_name)filter(where captured_name is not null)as captured_names,bool_or(captured_role is null)as historical,
 count(*)filter(where kind='sales')as sales,count(*)filter(where kind='purchases')as purchases,count(*)filter(where kind='manual')as manual,count(*)filter(where kind='automatic')as automatic,count(*)filter(where kind='collections')as collections,count(*)filter(where kind='payments')as payments,count(*)filter(where kind='transfers')as transfers,count(*)filter(where kind='other')as other,count(*)as total from selected where day>=first_day group by 1),
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
 'kpis',(select jsonb_agg(jsonb_build_object('key',k.key,'label',k.label,'icon',k.icon,'count',k.current_count,'previous',k.previous_count,'variation',case when k.previous_count=0 then case when k.current_count=0 then 0 else null end else round((k.current_count-k.previous_count)*100.0/k.previous_count,2)end,'amounts',(select coalesce(jsonb_agg(a),'[]')from(select currency,total from money_totals where kind=k.key order by currency)a))order by array_position(array['sales','purchases','manual','automatic','collections','payments','transfers','other'],k.key))from metrics k),
 'daily',(select jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'total',(select coalesce(sum(n),0)from daily_counts s where s.day=d::date),'values',(select jsonb_object_agg(k.key,(select coalesce(sum(n),0)from daily_counts s where s.day=d::date and s.kind=k.key))from kinds k))order by d)from generate_series(first_day,next_day-interval '1 day',interval '1 day')d),
 'activity',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('roles',coalesce(nullif(array_to_string(a.captured_names,', '),''),(select string_agg(r.role_name,', 'order by r.role_name)from public.user_roles ur join public.roles r using(role_id)where ur.user_id=a.user_id),'Sin rol histórico'))order by a.total desc,a.name),'[]')from activity a),
 'total',(select count(*)from selected where day>=first_day),'previousTotal',(select count(*)from selected where day<first_day),
 'historicalRoleCount',(select count(*)from selected where day>=first_day and captured_role is null),
 'unidentifiedCount',(select count(*)from selected where day>=first_day and owner_id is null),
 'openingCount',(select count(*)from selected where day>=first_day and opening),
 'generatedAt',now()
 )into result;
 return result;
end$$;
revoke all on all functions in schema dashboard_private from public,anon,authenticated,service_role;
revoke all on function public.run_managerial_dashboard(text,bigint,bigint,bigint)from public,anon,authenticated,service_role;
grant execute on function public.run_managerial_dashboard(text,bigint,bigint,bigint)to authenticated;
create index dashboard_invoice_scope on public.invoice(subsidiary_id,invoice_date);
create index dashboard_supplier_invoice_scope on public.supplier_invoice(subsidiary_id,invoice_date);
create index dashboard_journal_scope on public.journal(subsidiary_id,journal_date);
notify pgrst,'reload schema';
