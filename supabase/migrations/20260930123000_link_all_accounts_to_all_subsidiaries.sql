-- El plan contable de NEXO es compartido: toda cuenta debe estar disponible
-- en toda subsidiaria. El backfill repara la matriz actual y los triggers
-- conservan la regla para altas futuras.

insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
select account.account_id,subsidiary.subsidiary_id,true
from public.chart_accounts account
cross join public.subsidiaries subsidiary
on conflict(account_id,subsidiary_id)
do update set is_active=true;

create or replace function public.link_all_accounts_to_new_subsidiary()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
  select account_id,new.subsidiary_id,true
  from public.chart_accounts
  on conflict(account_id,subsidiary_id)
  do update set is_active=true;
  return new;
end
$$;

revoke all on function public.link_all_accounts_to_new_subsidiary()
  from public,anon,authenticated;

drop trigger if exists link_all_accounts_to_new_subsidiary_trigger
  on public.subsidiaries;
create trigger link_all_accounts_to_new_subsidiary_trigger
after insert on public.subsidiaries
for each row execute function public.link_all_accounts_to_new_subsidiary();

create or replace function public.link_new_account_to_all_subsidiaries()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
  select new.account_id,subsidiary_id,true
  from public.subsidiaries
  on conflict(account_id,subsidiary_id)
  do update set is_active=true;
  return new;
end
$$;

revoke all on function public.link_new_account_to_all_subsidiaries()
  from public,anon,authenticated;

drop trigger if exists link_new_account_to_all_subsidiaries_trigger
  on public.chart_accounts;
create trigger link_new_account_to_all_subsidiaries_trigger
after insert on public.chart_accounts
for each row execute function public.link_new_account_to_all_subsidiaries();

