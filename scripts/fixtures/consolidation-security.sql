-- Synthetic PostgreSQL fixture. Never run against a remote database.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema auth to authenticated,anon;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
create table public.users(user_id bigint primary key,auth_user_id uuid,is_active boolean default true);
create table public.roles(role_id bigint primary key,role_name text,is_system_role boolean default false);
create table public.user_roles(user_id bigint,role_id bigint,primary key(user_id,role_id));
create table public.permissions(permission_id bigint generated always as identity primary key,code text unique,module text,description text);
create table public.role_permissions(role_id bigint,permission_id bigint,primary key(role_id,permission_id));
create table public.user_role_sessions(session_id text primary key,user_id bigint,role_id bigint);
create table public.user_company_sessions(session_id text primary key,user_id bigint,subsidiary_id bigint);
create table public.user_subsidiaries(user_id bigint,subsidiary_id bigint,primary key(user_id,subsidiary_id));
create table public.role_access_matrix(role_id bigint,resource_key text,can_view boolean,can_create boolean,can_edit boolean,can_delete boolean);
create table public.currencies(currency_id bigint primary key,currency_code text);
create table public.subsidiaries(subsidiary_id bigint primary key,name text,is_active boolean,currency_id bigint references currencies);
create table public.fiscal_periods(fiscal_period_id bigint primary key,subsidiary_id bigint,end_date date,is_closed boolean);
create table public.account_group(group_id bigint primary key,category text);
create table public.chart_accounts(account_id bigint primary key,account_number text,account_name text,category text,account_group_id bigint);
create table public.gl_impact(subsidiary_id bigint,account_id bigint,posting_date date,debit_amount numeric,credit_amount numeric);
create table public.consolidated_exchange_rates(holding_subsidiary_id bigint,source_subsidiary_id bigint,period text,
  from_currency_id bigint,to_currency_id bigint,closing_rate numeric,average_rate numeric,historical_rate numeric);
create function public.install_actor_audit(regclass) returns void language sql as $$select$$;
create function public.app_user_id() returns bigint language sql stable security definer set search_path=public,pg_temp as $$
  select account.user_id from public.users account where account.auth_user_id=auth.uid() and account.is_active limit 1
$$;
create function public.app_session_id() returns text language sql stable as $$select coalesce(auth.jwt()->>'session_id',auth.jwt()->>'sub')$$;
create function public.app_active_role_id() returns bigint language sql stable security definer set search_path=public,pg_temp as $$
  select selected.role_id from public.user_role_sessions selected
  join public.users account on account.user_id=selected.user_id and account.is_active
  join public.user_roles membership on membership.user_id=selected.user_id and membership.role_id=selected.role_id
  where selected.session_id=public.app_session_id() and selected.user_id=public.app_user_id() limit 1
$$;
create function public.active_subsidiary_id() returns bigint language sql stable security definer set search_path=public,pg_temp as $$
  select selected.subsidiary_id from public.user_company_sessions selected
  join public.users account on account.user_id=selected.user_id and account.is_active
  join public.user_subsidiaries membership on membership.user_id=selected.user_id and membership.subsidiary_id=selected.subsidiary_id
  where selected.session_id=public.app_session_id() and selected.user_id=public.app_user_id() limit 1
$$;
create function public.app_is_admin() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.roles r where r.role_id=public.app_active_role_id() and lower(r.role_name) in ('administrador','administrator','admin'))
$$;
create function public.security_assert_role_access(p_resource_key text,p_action text default 'view')
returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if public.app_is_admin() then return;end if;
  if p_action not in ('view','create','edit','delete') then raise exception 'Invalid action';end if;
  if not exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id() and (
    m.resource_key='legacy:all' or(m.resource_key=p_resource_key and case p_action when 'view' then m.can_view
      when 'create' then m.can_create when 'edit' then m.can_edit else m.can_delete end)
  )) then raise exception using errcode='42501',message='Active role denied';end if;
end$$;

insert into public.users values
  (1,'00000000-0000-0000-0000-000000000001',true),
  (2,'00000000-0000-0000-0000-000000000002',true),
  (3,'00000000-0000-0000-0000-000000000003',true),
  (4,'00000000-0000-0000-0000-000000000004',true);
insert into public.roles values(1,'Runner',false),(2,'Publisher',false),(3,'Reader',false),(4,'No access',false),(5,'admin',false);
insert into public.user_roles values(1,1),(1,2),(1,3),(2,4),(3,1),(4,5);
insert into public.currencies values(1,'USD'),(2,'CRC');
insert into public.subsidiaries values(1,'STT Group Latin American S.A.',true,1),(2,'Synthetic subsidiary',true,2),
  (3,'Inactive historical subsidiary',false,1),(4,'Other holding',false,1);
insert into public.user_subsidiaries values(1,1),(1,2),(2,1),(2,2),(3,1),(4,1),(4,2);
insert into public.role_access_matrix values
  (1,'consolidation:financial-consolidation',true,true,true,false),
  (2,'consolidation:financial-consolidation',true,false,true,false),
  (3,'consolidation:financial-consolidation',true,false,false,false);
insert into public.fiscal_periods values(1,2,'2026-10-31',true);
insert into public.chart_accounts values(1,'1000','Synthetic asset','Activo',null),(2,'3000','Synthetic equity','Patrimonio',null);
insert into public.gl_impact values(2,1,'2026-10-01',100,0),(2,2,'2026-10-01',0,100);
insert into public.consolidated_exchange_rates values(1,2,'2026-10',2,1,0.002,0.002,0.002);
