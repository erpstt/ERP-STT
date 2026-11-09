-- A group supplies the default; a global account may explicitly opt in/out.
-- Keep all current effective flags, writers' authorization and financial history.
set local lock_timeout='5s';set local statement_timeout='60s';
do $guard$declare item record;begin
 for item in select *from(values
  ('public.inherit_account_fx_flag()','75e0bdeb1680e906ff4935561d441912'),
  ('public.cascade_account_fx_flag()','c34000f3d85eb50b8a907e6093c31750'),
  ('public.save_chart_account_catalog(bigint,jsonb,bigint[])','7183e90ff806a36ff7c8b5fcb6562f46'),
  ('public.chart_accounts_catalog()','721a437de592e01032b3de98c5909620'),
  ('public.save_chart_account_subsidiaries(bigint,bigint[])','a050351a25f03c18a5f2f1c776036c3f'),
  ('public.assign_chart_account_number()','db75e753202003908cfb64b5e3eb242a')
 )v(signature,source_md5)loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature)and md5(prosrc)=item.source_md5)then
   raise exception 'Unexpected chart-account FX override dependency: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from pg_attribute where attrelid='public.chart_accounts'::regclass
  and attname='pending_fx_revaluation_override'and not attisdropped)then raise exception 'Chart-account FX override already exists';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.chart_accounts'::regclass and tgname='chart_account_inherit_fx'
  and tgfoid='public.inherit_account_fx_flag()'::regprocedure and tgenabled='O'and not tgisinternal)
  or not exists(select 1 from pg_trigger where tgrelid='public.account_group'::regclass and tgname='account_group_cascade_fx'
  and tgfoid='public.cascade_account_fx_flag()'::regprocedure and tgenabled='O'and not tgisinternal)then raise exception 'Missing current account/group FX inheritance triggers';end if;
 if exists(select 1 from public.chart_accounts where category not in('Activo','Pasivo')and pending_fx_revaluation)then
  raise exception 'Review unexpected nonmonetary account FX flags before installing account overrides';
 end if;
end$guard$;

alter table public.chart_accounts add column pending_fx_revaluation_override boolean;
-- Only a legacy exception needs metadata initialization. The deployed baseline
-- has no such exceptions: this does not change effective flags or group defaults.
update public.chart_accounts a set pending_fx_revaluation_override=a.pending_fx_revaluation
from public.account_group g where g.group_id=a.account_group_id and a.category in('Activo','Pasivo')
 and a.pending_fx_revaluation is distinct from coalesce(g.pending_fx_revaluation,false);

do $inherit$declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('public.inherit_account_fx_flag()'::regprocedure);
 needle:='new.pending_fx_revaluation:=coalesce(enabled,false) and coalesce(new.category in (''Activo'',''Pasivo''),false);';
 replacement:=$body$if coalesce(new.category in('Activo','Pasivo'),false)then
    new.pending_fx_revaluation:=coalesce(new.pending_fx_revaluation_override,enabled,false);
  else
    new.pending_fx_revaluation_override:=null;
    new.pending_fx_revaluation:=false;
  end if;$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected account FX inheritance boundary';end if;
 execute replace(definition,needle,replacement);
end$inherit$;

do $cascade$declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('public.cascade_account_fx_flag()'::regprocedure);
 needle:='where account_group_id=new.group_id and pending_fx_revaluation is distinct from (new.pending_fx_revaluation and coalesce(category in (''Activo'',''Pasivo''),false));';
 replacement:='where account_group_id=new.group_id and pending_fx_revaluation_override is null and pending_fx_revaluation is distinct from (new.pending_fx_revaluation and coalesce(category in (''Activo'',''Pasivo''),false));';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected group FX cascade boundary';end if;
 execute replace(definition,needle,replacement);
end$cascade$;

drop trigger chart_account_inherit_fx on public.chart_accounts;
create trigger chart_account_inherit_fx before insert or update of account_group_id,pending_fx_revaluation,pending_fx_revaluation_override,category
on public.chart_accounts for each row execute function public.inherit_account_fx_flag();

do $save$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('public.save_chart_account_catalog(bigint,jsonb,bigint[])'::regprocedure);
 needle:='pending_fx_value boolean:=case when p_payload ? ''pending_fx_revaluation'' then coalesce(nullif(p_payload->>''pending_fx_revaluation'','''')::boolean,false) end;';
 replacement:='pending_fx_value boolean;pending_fx_override_value boolean;';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected legacy effective-FX input boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:='if account_name_value is null then';
 replacement:=$body$if p_payload ? 'pending_fx_revaluation_override'and jsonb_typeof(p_payload->'pending_fx_revaluation_override')not in('boolean','null')then
    raise exception using errcode='22023',message='La selección de revaluación debe ser verdadera, falsa o heredada.';
  end if;
  if account_name_value is null then$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected authorized account validation boundary';end if;
 definition:=replace(definition,needle,replacement);
 -- Same order as the group's cascade: group first, then account. This also
 -- stabilizes the inherited default while the account's override is saved.
 needle:='where group_id=group_id_value;';replacement:='where group_id=group_id_value for share;';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected chart-account group lookup boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$body$pending_fx_value:=case when category_value in('Activo','Pasivo')
    then coalesce(pending_fx_value,existing_account.pending_fx_revaluation,account_group.pending_fx_revaluation,false)
    else false end;$body$;
 replacement:=$body$if category_value in('Activo','Pasivo')then
    pending_fx_override_value:=case when p_payload ? 'pending_fx_revaluation_override'
      then (p_payload->>'pending_fx_revaluation_override')::boolean
      else existing_account.pending_fx_revaluation_override end;
    pending_fx_value:=coalesce(pending_fx_override_value,account_group.pending_fx_revaluation,false);
  else
    pending_fx_override_value:=null;
    pending_fx_value:=false;
  end if;$body$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected inherited account FX computation boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:='pending_fx_revaluation,cash_flow_activity,is_inactive';replacement:='pending_fx_revaluation,pending_fx_revaluation_override,cash_flow_activity,is_inactive';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected chart-account insert columns boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:='payment_request_value,full_ifrs_value,pending_fx_value,';replacement:='payment_request_value,full_ifrs_value,pending_fx_value,pending_fx_override_value,';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected chart-account insert values boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:='pending_fx_revaluation=pending_fx_value,';replacement:='pending_fx_revaluation=pending_fx_value,pending_fx_revaluation_override=pending_fx_override_value,';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected chart-account update FX boundary';end if;
 definition:=replace(definition,needle,replacement);
 execute definition;
end$save$;
notify pgrst,'reload schema';
