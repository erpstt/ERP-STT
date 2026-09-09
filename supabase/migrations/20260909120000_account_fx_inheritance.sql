-- The direct account group owns the FX eligibility flag.
create or replace function public.inherit_account_fx_flag() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare enabled boolean;
begin
  select pending_fx_revaluation into enabled from public.account_group where group_id=new.account_group_id for share;
  new.pending_fx_revaluation:=coalesce(enabled,false) and coalesce(new.category in ('Activo','Pasivo'),false);
  return new;
end$$;
drop trigger if exists chart_account_inherit_fx on public.chart_accounts;
create trigger chart_account_inherit_fx before insert or update of account_group_id,pending_fx_revaluation,category on public.chart_accounts
for each row execute function public.inherit_account_fx_flag();
create or replace function public.cascade_account_fx_flag() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.chart_accounts set pending_fx_revaluation=new.pending_fx_revaluation and coalesce(category in ('Activo','Pasivo'),false)
  where account_group_id=new.group_id and pending_fx_revaluation is distinct from (new.pending_fx_revaluation and coalesce(category in ('Activo','Pasivo'),false));
  return new;
end$$;
drop trigger if exists account_group_cascade_fx on public.account_group;
create trigger account_group_cascade_fx after update of pending_fx_revaluation on public.account_group
for each row execute function public.cascade_account_fx_flag();
revoke all on function public.inherit_account_fx_flag(),public.cascade_account_fx_flag() from public,anon,authenticated;
update public.chart_accounts a set pending_fx_revaluation=g.pending_fx_revaluation and coalesce(a.category in ('Activo','Pasivo'),false)
from public.account_group g where a.account_group_id=g.group_id
and a.pending_fx_revaluation is distinct from (g.pending_fx_revaluation and coalesce(a.category in ('Activo','Pasivo'),false));
