-- Tasas de consolidación por holding y período (NIC 21 / NIIF 10).
do $$begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='consolidated_exchange_rates' and column_name='current_rate')
 and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='consolidated_exchange_rates' and column_name='closing_rate') then
  alter table public.consolidated_exchange_rates rename column current_rate to closing_rate;
 end if;
end$$;

alter table public.consolidated_exchange_rates
 add column if not exists holding_subsidiary_id bigint references public.subsidiaries(subsidiary_id),
 add column if not exists period varchar(7),
 add column if not exists is_locked boolean not null default false,
 add column if not exists locked_at timestamptz,
 add column if not exists locked_by bigint references public.users(user_id);

update public.consolidated_exchange_rates r set
 holding_subsidiary_id=coalesce(r.holding_subsidiary_id,p.subsidiary_id),
 period=coalesce(r.period,to_char(p.end_date,'YYYY-MM'))
from public.fiscal_periods p where p.fiscal_period_id=r.fiscal_period_id;

alter table public.consolidated_exchange_rates alter column holding_subsidiary_id set not null,alter column period set not null;
alter table public.consolidated_exchange_rates drop constraint if exists consolidated_exchange_rates_period_format;
alter table public.consolidated_exchange_rates add constraint consolidated_exchange_rates_period_format check(period~'^[0-9]{4}-(0[1-9]|1[0-2])$');
create unique index if not exists consolidated_exchange_rates_holding_period_pair_uq on public.consolidated_exchange_rates(holding_subsidiary_id,period,from_currency_id,to_currency_id);
create index if not exists consolidated_exchange_rates_lookup_idx on public.consolidated_exchange_rates(holding_subsidiary_id,period,from_currency_id,to_currency_id,is_locked);

insert into public.permissions(code,module,description) values
 ('consolidation:rates:view','Consolidación','Consultar tipos de cambio consolidados.'),
 ('consolidation:rates:manage','Consolidación','Crear y modificar tipos de cambio consolidados.'),
 ('consolidation:rates:lock','Consolidación','Bloquear definitivamente las tasas de un período.')
on conflict(code)do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.role_id,p.permission_id from public.roles r cross join public.permissions p
where p.code in('consolidation:rates:view','consolidation:rates:manage','consolidation:rates:lock')and(r.is_system_role or lower(r.role_name)like'%admin%')on conflict do nothing;

create or replace function public.validate_consolidated_exchange_rate()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare fp public.fiscal_periods%rowtype; uid bigint:=public.app_user_id();
begin
 if tg_op in('UPDATE','DELETE')and old.is_locked then raise exception 'El período % está cerrado. Sus tasas consolidadas son inmutables.',old.period;end if;
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=uid and p.code='consolidation:rates:manage')then raise exception 'No tiene permiso para administrar tipos de cambio consolidados.';end if;
 if tg_op='DELETE'then return old;end if;
 select*into fp from fiscal_periods where fiscal_period_id=new.fiscal_period_id;
 if fp.fiscal_period_id is null or fp.subsidiary_id<>new.holding_subsidiary_id then raise exception 'El período fiscal debe pertenecer a la holding seleccionada.';end if;
 new.period:=to_char(fp.end_date,'YYYY-MM');
 if new.from_currency_id=new.to_currency_id then raise exception 'La moneda de origen y la moneda de consolidación deben ser diferentes.';end if;
 if least(new.closing_rate,new.average_rate,new.historical_rate)<=0 then raise exception 'Todas las tasas de conversión deben ser mayores que cero.';end if;
 if new.is_locked and(tg_op='INSERT'or not old.is_locked)then
  if not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=uid and p.code='consolidation:rates:lock')then raise exception 'No tiene permiso para bloquear tasas consolidadas.';end if;
  new.locked_at:=clock_timestamp();new.locked_by:=uid;
 end if;
 return new;
end$$;
drop trigger if exists validate_consolidated_exchange_rate_trigger on public.consolidated_exchange_rates;
create trigger validate_consolidated_exchange_rate_trigger before insert or update or delete on public.consolidated_exchange_rates for each row execute function public.validate_consolidated_exchange_rate();

create or replace function public.consolidated_exchange_rate_suggestion(p_holding bigint,p_period varchar,p_from bigint,p_to bigint)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare start_day date:=(p_period||'-01')::date;end_day date:=(start_day+interval'1 month'-interval'1 day')::date;closing numeric;average numeric;historical numeric;
begin
 if not exists(select 1 from subsidiaries where subsidiary_id=p_holding and is_active)then raise exception 'La holding seleccionada no existe o está inactiva.';end if;
 select spot_rate into closing from exchange_rates where from_currency_id=p_from and to_currency_id=p_to and effective_date<=end_day order by effective_date desc,exchange_rate_id desc limit 1;
 select avg(spot_rate)into average from exchange_rates where from_currency_id=p_from and to_currency_id=p_to and effective_date between start_day and end_day;
 select spot_rate into historical from exchange_rates where from_currency_id=p_from and to_currency_id=p_to and effective_date<=start_day order by effective_date desc,exchange_rate_id desc limit 1;
 return jsonb_build_object('period',p_period,'startDate',start_day,'endDate',end_day,'closingRate',closing,'averageRate',average,'historicalRate',historical,'dailyRates',
  (select count(*)from exchange_rates where from_currency_id=p_from and to_currency_id=p_to and effective_date between start_day and end_day));
end$$;

create or replace function public.consolidated_rate_for(p_holding bigint,p_period varchar,p_from bigint,p_to bigint,p_account_category text)
returns numeric language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r consolidated_exchange_rates%rowtype;category text:=lower(trim(p_account_category));
begin
 select*into r from consolidated_exchange_rates where holding_subsidiary_id=p_holding and period=p_period and from_currency_id=p_from and to_currency_id=p_to;
 if r.rate_id is null then raise exception 'No existen tasas consolidadas para el período y par de monedas solicitado.';end if;
 return case when category in('activo','pasivo')then r.closing_rate when category in('ingreso','costo','gasto')then r.average_rate when category in('patrimonio','capital','reserva')then r.historical_rate else null end;
end$$;

create or replace function public.consolidation_translation_adjustment(p_holding bigint,p_period varchar,p_from bigint,p_to bigint,p_assets numeric,p_liabilities numeric,p_equity numeric,p_period_result numeric)
returns numeric language sql stable security definer set search_path=public,pg_temp as $$
 select round(p_assets*r.closing_rate-p_liabilities*r.closing_rate-p_equity*r.historical_rate-p_period_result*r.average_rate,2)
 from consolidated_exchange_rates r where r.holding_subsidiary_id=p_holding and r.period=p_period and r.from_currency_id=p_from and r.to_currency_id=p_to
$$;
grant execute on function public.consolidated_exchange_rate_suggestion(bigint,varchar,bigint,bigint),public.consolidated_rate_for(bigint,varchar,bigint,bigint,text),public.consolidation_translation_adjustment(bigint,varchar,bigint,bigint,numeric,numeric,numeric,numeric)to authenticated,service_role;
