-- Activate after all official-source clients use RPC ingestion.
create function rate_security_private.guard_daily()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.exchange_rates;begin if not rate_security_private.has_context('daily')then raise exception using errcode='42501',message='Use el mantenimiento protegido de tasas.';end if;
 if tg_op='DELETE'then r:=old;else r:=new;end if;if not rate_security_private.positive(r.spot_rate)or r.from_currency_id=r.to_currency_id then raise exception using errcode='22023',message='Tasa invalida.';end if;
 if rate_security_private.frozen(r.from_currency_id,r.to_currency_id,r.effective_date)then raise exception using errcode='55000',message='Soporte de tasa cerrado.';end if;
 if tg_op='UPDATE'and row(new.from_currency_id,new.to_currency_id,new.effective_date)is distinct from row(old.from_currency_id,old.to_currency_id,old.effective_date)then raise exception using errcode='55000',message='Par y fecha inmutables.';end if;return r;end$$;
create trigger protected_daily_rate before insert or update or delete on public.exchange_rates for each row execute function rate_security_private.guard_daily();

create or replace function public.validate_consolidated_exchange_rate()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare fp public.fiscal_periods;usd bigint;local_currency bigint;auto boolean;manual boolean;
begin if tg_op='DELETE'then raise exception using errcode='42501',message='No se eliminan tasas consolidadas.';end if;
 auto:=rate_security_private.has_context('auto',new.source_subsidiary_id,new.fiscal_period_id);manual:=rate_security_private.has_context('manual',new.source_subsidiary_id,new.fiscal_period_id);
 if not auto and not manual then raise exception using errcode='42501',message='Use el mantenimiento protegido de tasas consolidadas.';end if;
 if manual and(not rate_security_private.allowed('consolidated-exchange-rates','edit')or not rate_security_private.special('consolidation:rates:manage')or not rate_security_private.visible_consolidated(new.holding_subsidiary_id,new.source_subsidiary_id))then raise exception using errcode='42501',message='Mantenimiento consolidado no autorizado.';end if;
 if tg_op='UPDATE'and(old.is_locked or row(new.holding_subsidiary_id,new.source_subsidiary_id,new.fiscal_period_id,new.period,new.from_currency_id,new.to_currency_id)is distinct from row(old.holding_subsidiary_id,old.source_subsidiary_id,old.fiscal_period_id,old.period,old.from_currency_id,old.to_currency_id))then raise exception using errcode='55000',message='La tasa bloqueada o utilizada conserva su origen.';end if;
 select *into fp from public.fiscal_periods where fiscal_period_id=new.fiscal_period_id;select currency_id into local_currency from public.subsidiaries where subsidiary_id=new.source_subsidiary_id and is_active;select currency_id into usd from public.currencies where currency_code='USD';
 if fp.fiscal_period_id is null or fp.subsidiary_id<>new.source_subsidiary_id or rate_security_private.closed(fp.fiscal_period_id)then raise exception using errcode='55000',message='Periodo consolidado no disponible.';end if;
 if new.holding_subsidiary_id is distinct from public.consolidation_holding_subsidiary_id()or new.from_currency_id is distinct from local_currency or new.to_currency_id is distinct from usd or new.from_currency_id=new.to_currency_id or new.period<>to_char(fp.end_date,'YYYY-MM')then raise exception using errcode='22023',message='Origen consolidado invalido.';end if;
 if not rate_security_private.positive(new.closing_rate)or not rate_security_private.positive(new.average_rate)or not rate_security_private.positive(new.historical_rate)then raise exception using errcode='22023',message='Tasas consolidadas invalidas.';end if;
 if new.is_locked and(tg_op='INSERT'or not old.is_locked)then if auto or not rate_security_private.special('consolidation:rates:lock')then raise exception using errcode='42501',message='Requiere permiso de bloqueo.';end if;new.locked_at:=clock_timestamp();new.locked_by:=public.app_user_id();end if;return new;end$$;
create or replace function public.auto_sync_consolidated_rates()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.exchange_rates;usd bigint;local_currency bigint;
begin if tg_table_name='fiscal_periods'then perform rate_security_private.sync(null,new.subsidiary_id,new.fiscal_period_id);return new;end if;
 if tg_op='DELETE'then r:=old;else r:=new;end if;select currency_id into usd from public.currencies where currency_code='USD';if r.from_currency_id=usd then local_currency:=r.to_currency_id;elsif r.to_currency_id=usd then local_currency:=r.from_currency_id;end if;
 if local_currency is not null then perform rate_security_private.sync(null,null,null,local_currency,r.effective_date,tg_op='DELETE');end if;return r;end$$;
drop trigger auto_consolidated_rates_from_spot on public.exchange_rates;
create trigger auto_consolidated_rates_from_spot after insert or update of spot_rate,effective_date or delete on public.exchange_rates for each row execute function public.auto_sync_consolidated_rates();

create or replace function public.sync_consolidated_exchange_rates(p_period varchar default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare h bigint:=public.consolidation_holding_subsidiary_id();begin perform rate_security_private.access('consolidated-exchange-rates','edit');if not rate_security_private.special('consolidation:rates:manage')or not rate_security_private.member(h)or exists(select 1 from public.fiscal_periods p join public.subsidiaries s using(subsidiary_id)where s.is_active and(p_period is null or to_char(p.end_date,'YYYY-MM')=p_period)and not rate_security_private.member(s.subsidiary_id))then raise exception using errcode='42501',message='Sincronizacion global no autorizada.';end if;return rate_security_private.sync(p_period);end$$;

alter function public.consolidated_exchange_rate_suggestion(bigint,varchar,bigint,bigint)set schema rate_security_private;
alter function public.consolidated_rate_for(bigint,varchar,bigint,bigint,text)set schema rate_security_private;
create function public.consolidated_exchange_rate_suggestion(p_holding bigint,p_period varchar,p_from bigint,p_to bigint)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform rate_security_private.access('consolidated-exchange-rates','view');if not rate_security_private.member(p_holding)or not rate_security_private.visible_daily(p_from,p_to)then raise exception using errcode='42501',message='Sugerencia no autorizada.';end if;if p_period is null or p_period!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then raise exception using errcode='22023',message='Periodo invalido.';end if;return rate_security_private.consolidated_exchange_rate_suggestion(p_holding,p_period,p_from,p_to);end$$;
create function public.consolidated_rate_for(p_holding bigint,p_period varchar,p_from bigint,p_to bigint,p_account_category text)returns numeric language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin perform rate_security_private.actor();if not rate_security_private.member(p_holding)or exists(select 1 from public.consolidated_exchange_rates r where r.holding_subsidiary_id=p_holding and r.period=p_period and r.from_currency_id=p_from and r.to_currency_id=p_to and not rate_security_private.visible_consolidated(r.holding_subsidiary_id,r.source_subsidiary_id))then raise exception using errcode='42501',message='Tasa consolidada no autorizada.';end if;return rate_security_private.consolidated_rate_for(p_holding,p_period,p_from,p_to,p_account_category);end$$;

do $$declare t text;p record;c record;predicate text;begin foreach t in array array['exchange_rates','consolidated_exchange_rates']loop
 for p in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for c in select column_name from information_schema.columns where table_schema='public'and table_name=t loop execute format('revoke select(%I),insert(%I),update(%I),references(%I)on public.%I from public,anon,authenticated,service_role',c.column_name,c.column_name,c.column_name,c.column_name,t);end loop;
 predicate:=case t when'exchange_rates'then'rate_security_private.visible_daily(from_currency_id,to_currency_id)'else'rate_security_private.visible_consolidated(holding_subsidiary_id,source_subsidiary_id)'end;execute format('create policy protected_rate_read on public.%I for select to authenticated using(%s)',t,predicate);execute format('grant select on public.%I to authenticated,service_role',t);end loop;end$$;
revoke all on all functions in schema rate_security_private from public,anon,authenticated,service_role;
grant execute on function rate_security_private.visible_daily(bigint,bigint),rate_security_private.visible_consolidated(bigint,bigint)to authenticated;
revoke all on function public.sync_consolidated_exchange_rates(varchar),public.consolidated_exchange_rate_suggestion(bigint,varchar,bigint,bigint),public.consolidated_rate_for(bigint,varchar,bigint,bigint,text),public.auto_sync_consolidated_rates(),public.validate_consolidated_exchange_rate()from public,anon,authenticated,service_role;
grant execute on function public.sync_consolidated_exchange_rates(varchar),public.consolidated_exchange_rate_suggestion(bigint,varchar,bigint,bigint),public.consolidated_rate_for(bigint,varchar,bigint,bigint,text)to authenticated;
-- A referenced currency code defines the meaning of protected rate pairs.
create function rate_security_private.guard_currency_identity()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if tg_op='UPDATE' and new.currency_code is not distinct from old.currency_code then return new;end if;
 if exists(select 1 from public.exchange_rates where from_currency_id=old.currency_id or to_currency_id=old.currency_id)
 or exists(select 1 from public.consolidated_exchange_rates where from_currency_id=old.currency_id or to_currency_id=old.currency_id)
 or exists(select 1 from public.subsidiaries where currency_id=old.currency_id)
 or exists(select 1 from public.subsidiary_currencies where currency_id=old.currency_id)then
 raise exception using errcode='55000',message='La moneda utilizada conserva su identidad.';
 end if;
 if tg_op='DELETE'then return old;end if;return new;
end$$;
revoke all on function rate_security_private.guard_currency_identity()from public,anon,authenticated,service_role;
create trigger rate_currency_identity before update of currency_code or delete on public.currencies for each row execute function rate_security_private.guard_currency_identity();
notify pgrst,'reload schema';
