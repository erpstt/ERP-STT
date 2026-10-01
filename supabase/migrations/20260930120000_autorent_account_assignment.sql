-- A recently-created subsidiary can use the shared chart of accounts without
-- receiving thousands of unrelated account links.  Only the two compatible
-- balance accounts selected for income autorent are enabled for it.  This
-- BEFORE trigger runs ahead of validate_subsidiary_income_autorent_trigger, so
-- the account assignment and the subsidiary update are one transaction.

create or replace function public.ensure_subsidiary_income_autorent_accounts()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if not coalesce(new.applies_income_autorent,false) then
    return new;
  end if;

  if new.autorent_active_account_id is null
     or not exists(
       select 1
       from public.chart_accounts a
       where a.account_id=new.autorent_active_account_id
         and a.category='Activo'
         and a.nature='Deudora'
         and a.financial_statement='Balance General'
         and a.level=4
         and a.accepts_entries
         and not a.is_inactive
     ) then
    raise exception 'Seleccione una cuenta de Activo, naturaleza deudora, de Balance General y habilitada para movimientos.';
  end if;

  if new.autorent_passive_account_id is null
     or not exists(
       select 1
       from public.chart_accounts a
       where a.account_id=new.autorent_passive_account_id
         and a.category='Pasivo'
         and a.nature='Acreedora'
         and a.financial_statement='Balance General'
         and a.level=4
         and a.accepts_entries
         and not a.is_inactive
     ) then
    raise exception 'Seleccione una cuenta de Pasivo, naturaleza acreedora, de Balance General y habilitada para movimientos.';
  end if;

  insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
  values
    (new.autorent_active_account_id,new.subsidiary_id,true),
    (new.autorent_passive_account_id,new.subsidiary_id,true)
  on conflict(account_id,subsidiary_id)
  do update set is_active=true;

  return new;
end
$$;

revoke all on function public.ensure_subsidiary_income_autorent_accounts()
  from public,anon,authenticated;

drop trigger if exists ensure_subsidiary_income_autorent_accounts_trigger
  on public.subsidiaries;
create trigger ensure_subsidiary_income_autorent_accounts_trigger
before update of applies_income_autorent,autorent_active_account_id,
  autorent_passive_account_id,autorent_percentage
on public.subsidiaries
for each row
when(new.applies_income_autorent)
execute function public.ensure_subsidiary_income_autorent_accounts();
