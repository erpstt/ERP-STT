-- Generación automática por filial y período hacia USD para STT Group Latin American.
alter table public.consolidated_exchange_rates add column if not exists source_subsidiary_id bigint references public.subsidiaries(subsidiary_id);
update public.consolidated_exchange_rates set source_subsidiary_id=(select subsidiary_id from fiscal_periods where fiscal_period_id=consolidated_exchange_rates.fiscal_period_id)where source_subsidiary_id is null;
alter table public.consolidated_exchange_rates alter column source_subsidiary_id set not null;
drop index if exists public.consolidated_exchange_rates_holding_period_pair_uq;
create unique index if not exists consolidated_exchange_rates_company_period_pair_uq on public.consolidated_exchange_rates(holding_subsidiary_id,source_subsidiary_id,period,from_currency_id,to_currency_id);
create index if not exists consolidated_exchange_rates_company_lookup_idx on public.consolidated_exchange_rates(source_subsidiary_id,period);

create or replace function public.validate_consolidated_exchange_rate()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare fp public.fiscal_periods%rowtype;uid bigint:=public.app_user_id();automated boolean:=coalesce(current_setting('nexo.consolidated_automation',true),'')='on';local_currency bigint;usd bigint;expected_holding bigint;
begin
 if tg_op in('UPDATE','DELETE')and old.is_locked then raise exception 'El período % está cerrado. Sus tasas consolidadas son inmutables.',old.period;end if;
 if not automated and not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=uid and p.code='consolidation:rates:manage')then raise exception 'No tiene permiso para administrar tipos de cambio consolidados.';end if;
 if tg_op='DELETE'then return old;end if;
 select subsidiary_id into expected_holding from subsidiaries where lower(trim(name))='stt group latin american'and is_active order by subsidiary_id limit 1;
 select currency_id into usd from currencies where currency_code='USD';
 if expected_holding is null or usd is null then raise exception 'Configure la holding STT Group Latin American y la moneda USD.';end if;
 new.holding_subsidiary_id:=expected_holding;new.to_currency_id:=usd;
 select*into fp from fiscal_periods where fiscal_period_id=new.fiscal_period_id;
 if fp.fiscal_period_id is null or fp.subsidiary_id<>new.source_subsidiary_id then raise exception 'El período fiscal debe pertenecer a la filial de origen seleccionada.';end if;
 select currency_id into local_currency from subsidiaries where subsidiary_id=new.source_subsidiary_id and is_active;
 if local_currency is null then raise exception 'La filial de origen no existe o está inactiva.';end if;
 new.from_currency_id:=local_currency;new.period:=to_char(fp.end_date,'YYYY-MM');
 if new.from_currency_id=new.to_currency_id then raise exception 'Las filiales cuya moneda local es USD no requieren tasa consolidada.';end if;
 if least(new.closing_rate,new.average_rate,new.historical_rate)<=0 then raise exception 'Todas las tasas de conversión deben ser mayores que cero.';end if;
 if new.is_locked and(tg_op='INSERT'or not old.is_locked)then
  if not automated and not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=uid and p.code='consolidation:rates:lock')then raise exception 'No tiene permiso para bloquear tasas consolidadas.';end if;
  new.locked_at:=clock_timestamp();new.locked_by:=uid;
 end if;return new;
end$$;

create or replace function public.sync_consolidated_exchange_rates(p_period varchar default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare holding bigint;usd bigint;r record;start_day date;end_day date;closing numeric;average numeric;historical numeric;created_count int:=0;updated_count int:=0;missing_count int:=0;existing_id bigint;
begin
 select subsidiary_id into holding from subsidiaries where lower(trim(name))='stt group latin american'and is_active order by subsidiary_id limit 1;
 select currency_id into usd from currencies where currency_code='USD';
 if holding is null or usd is null then raise exception 'Configure la holding STT Group Latin American y la moneda USD.';end if;
 perform set_config('nexo.consolidated_automation','on',true);
 for r in select fp.fiscal_period_id,fp.start_date,fp.end_date,s.subsidiary_id,s.currency_id
  from fiscal_periods fp join subsidiaries s using(subsidiary_id)
  where s.is_active and s.currency_id<>usd and(p_period is null or to_char(fp.end_date,'YYYY-MM')=p_period)
 loop
  start_day:=r.start_date;end_day:=r.end_date;closing:=null;average:=null;historical:=null;
  select case when e.from_currency_id=r.currency_id then e.spot_rate else 1/e.spot_rate end into closing from exchange_rates e
   where((e.from_currency_id=r.currency_id and e.to_currency_id=usd)or(e.from_currency_id=usd and e.to_currency_id=r.currency_id))and e.effective_date<=end_day order by e.effective_date desc,e.exchange_rate_id desc limit 1;
  select avg(case when e.from_currency_id=r.currency_id then e.spot_rate else 1/e.spot_rate end)into average from exchange_rates e
   where((e.from_currency_id=r.currency_id and e.to_currency_id=usd)or(e.from_currency_id=usd and e.to_currency_id=r.currency_id))and e.effective_date between start_day and end_day;
  select case when e.from_currency_id=r.currency_id then e.spot_rate else 1/e.spot_rate end into historical from exchange_rates e
   where((e.from_currency_id=r.currency_id and e.to_currency_id=usd)or(e.from_currency_id=usd and e.to_currency_id=r.currency_id))and e.effective_date<=start_day order by e.effective_date desc,e.exchange_rate_id desc limit 1;
  if closing is null or average is null then missing_count:=missing_count+1;continue;end if;historical:=coalesce(historical,closing);
  select rate_id into existing_id from consolidated_exchange_rates where holding_subsidiary_id=holding and source_subsidiary_id=r.subsidiary_id and period=to_char(end_day,'YYYY-MM')and from_currency_id=r.currency_id and to_currency_id=usd;
  if existing_id is null then
   insert into consolidated_exchange_rates(holding_subsidiary_id,source_subsidiary_id,period,from_currency_id,to_currency_id,fiscal_period_id,closing_rate,average_rate,historical_rate,is_locked)
   values(holding,r.subsidiary_id,to_char(end_day,'YYYY-MM'),r.currency_id,usd,r.fiscal_period_id,closing,average,historical,false);created_count:=created_count+1;
  elsif not(select is_locked from consolidated_exchange_rates where rate_id=existing_id)then
   update consolidated_exchange_rates set fiscal_period_id=r.fiscal_period_id,closing_rate=closing,average_rate=average,historical_rate=historical where rate_id=existing_id;updated_count:=updated_count+1;
  end if;
 end loop;
 return jsonb_build_object('holdingId',holding,'presentationCurrency','USD','period',p_period,'created',created_count,'updated',updated_count,'missingDailyRates',missing_count);
end$$;

create or replace function public.auto_sync_consolidated_rates()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare target_period varchar(7);
begin
 if tg_table_name='exchange_rates'then target_period:=to_char(new.effective_date,'YYYY-MM');
 else target_period:=to_char(new.end_date,'YYYY-MM');end if;
 perform sync_consolidated_exchange_rates(target_period);return new;
end$$;
drop trigger if exists auto_consolidated_rates_from_spot on public.exchange_rates;
create trigger auto_consolidated_rates_from_spot after insert or update of spot_rate,effective_date on public.exchange_rates for each row execute function public.auto_sync_consolidated_rates();
drop trigger if exists auto_consolidated_rates_from_period on public.fiscal_periods;
create trigger auto_consolidated_rates_from_period after insert or update of start_date,end_date on public.fiscal_periods for each row execute function public.auto_sync_consolidated_rates();
grant execute on function public.sync_consolidated_exchange_rates(varchar)to authenticated,service_role;
