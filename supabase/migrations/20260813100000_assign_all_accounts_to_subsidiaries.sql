drop policy if exists "company_scope_select" on public.account_subsidiaries;
drop policy if exists "company_scope_insert" on public.account_subsidiaries;
drop policy if exists "company_scope_update" on public.account_subsidiaries;
drop policy if exists "company_scope_delete" on public.account_subsidiaries;

create policy "company_scope_select" on public.account_subsidiaries
for select to authenticated
using (
  exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=account_subsidiaries.subsidiary_id)
  or lower(coalesce(auth.jwt()->>'email',''))='demo@nexo.com'
);
create policy "company_scope_insert" on public.account_subsidiaries
for insert to authenticated
with check (
  exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=account_subsidiaries.subsidiary_id)
  or lower(coalesce(auth.jwt()->>'email',''))='demo@nexo.com'
);
create policy "company_scope_update" on public.account_subsidiaries
for update to authenticated
using (
  exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=account_subsidiaries.subsidiary_id)
  or lower(coalesce(auth.jwt()->>'email',''))='demo@nexo.com'
)
with check (
  exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=account_subsidiaries.subsidiary_id)
  or lower(coalesce(auth.jwt()->>'email',''))='demo@nexo.com'
);
create policy "company_scope_delete" on public.account_subsidiaries
for delete to authenticated
using (
  exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id() and access.subsidiary_id=account_subsidiaries.subsidiary_id)
  or lower(coalesce(auth.jwt()->>'email',''))='demo@nexo.com'
);

insert into public.account_subsidiaries(account_id,subsidiary_id,is_active)
select account.account_id,subsidiary.subsidiary_id,true
from public.chart_accounts account
cross join public.subsidiaries subsidiary
where subsidiary.is_active
on conflict(account_id,subsidiary_id) do update set is_active=true;
