-- Read the actor and grants once, then evaluate scope as a set. The protected
-- write routines and their per-record DTOs remain unchanged.
set local lock_timeout='5s';
set local statement_timeout='30s';

do $guard$
declare definition text:=replace(pg_get_functiondef('public.exchange_rate_catalog(text)'::regprocedure),E'\r\n',E'\n');
begin
 if position('perform rate_security_private.access(p_catalog,''view'');if p_catalog=''exchange-rates''then' in definition)=0
   or position('rate_security_private.daily_dto(r)' in definition)=0
   or position('rate_security_private.consolidated_dto(r)' in definition)=0 then
  raise exception 'Unexpected exchange rate catalog definition';
 end if;
end
$guard$;

create or replace function public.exchange_rate_catalog(p_catalog text)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare
 actor_id bigint:=rate_security_private.access(p_catalog,'view');
 can_edit boolean:=rate_security_private.allowed(p_catalog,'edit');
 can_delete boolean;
 active_sid bigint;
 administrator boolean;
 manages_consolidation boolean;
 result jsonb;
begin
 if p_catalog='exchange-rates' then
  can_delete:=rate_security_private.allowed(p_catalog,'delete');
  active_sid:=public.active_subsidiary_id();
  administrator:=public.app_is_admin();
  with memberships as materialized (
   select subsidiary_id from public.user_subsidiaries where user_id=actor_id
  ), visible_currencies as materialized (
   select currency_id from public.subsidiaries where subsidiary_id=active_sid
   union
   select currency_scope.currency_id from public.subsidiary_currencies currency_scope
   join public.subsidiaries subsidiary on subsidiary.subsidiary_id=currency_scope.subsidiary_id
   where subsidiary.subsidiary_id=active_sid
  ), visible_pairs as materialized (
   select distinct r.from_currency_id,r.to_currency_id
   from public.exchange_rates r
   where administrator
     or r.from_currency_id in(select currency_id from visible_currencies)
     or r.to_currency_id in(select currency_id from visible_currencies)
  ), pair_scope as materialized (
   select pair.*,
    not exists(
     select 1 from public.subsidiaries subsidiary
     where subsidiary.is_active
       and (subsidiary.currency_id in(pair.from_currency_id,pair.to_currency_id)
         or exists(select 1 from public.subsidiary_currencies currency_scope
           where currency_scope.subsidiary_id=subsidiary.subsidiary_id
             and currency_scope.currency_id in(pair.from_currency_id,pair.to_currency_id)))
       and not exists(select 1 from memberships member where member.subsidiary_id=subsidiary.subsidiary_id)
    ) as global_scope
   from visible_pairs pair
  ), qualified_rows as materialized (
   select r as rate,
    case when (can_edit or can_delete) and scope.global_scope
      then not rate_security_private.frozen(r.from_currency_id,r.to_currency_id,r.effective_date)
      else false end as writable
   from public.exchange_rates r
   join pair_scope scope
     on scope.from_currency_id is not distinct from r.from_currency_id
    and scope.to_currency_id is not distinct from r.to_currency_id
  )
  select coalesce(jsonb_agg(
    to_jsonb(row.rate)||jsonb_build_object(
      '_revision',md5(to_jsonb(row.rate)::text),
      '_actions',jsonb_build_object('canEdit',can_edit and row.writable,'canDelete',can_delete and row.writable)
    ) order by (row.rate).effective_date desc,(row.rate).exchange_rate_id desc
   ),'[]'::jsonb) into result
  from qualified_rows row;
 else
  manages_consolidation:=rate_security_private.special('consolidation:rates:manage');
  with memberships as materialized (
   select subsidiary_id from public.user_subsidiaries where user_id=actor_id
  ), visible_rows as materialized (
   select r as rate from public.consolidated_exchange_rates r
   where exists(select 1 from memberships member where member.subsidiary_id=r.holding_subsidiary_id)
     and exists(select 1 from memberships member where member.subsidiary_id=r.source_subsidiary_id)
  ), periods as materialized (
   select distinct (row.rate).fiscal_period_id as fiscal_period_id from visible_rows row
  ), period_state as materialized (
   select period.fiscal_period_id,
     case when can_edit and manages_consolidation
       then rate_security_private.closed(period.fiscal_period_id) else true end as closed
   from periods period
  )
  select coalesce(jsonb_agg(
    to_jsonb(row.rate)||jsonb_build_object(
      '_revision',md5(to_jsonb(row.rate)::text),
      'fiscal_year',split_part((row.rate).period,'-',1),
      'month_name',(array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[(split_part((row.rate).period,'-',2))::int],
      '_actions',jsonb_build_object('canEdit',not (row.rate).is_locked and not state.closed and can_edit and manages_consolidation,'canDelete',false)
    ) order by (row.rate).rate_id
   ),'[]'::jsonb) into result
  from visible_rows row
  join period_state state on state.fiscal_period_id is not distinct from (row.rate).fiscal_period_id;
 end if;
 return result;
end
$$;

notify pgrst,'reload schema';
