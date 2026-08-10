drop policy if exists "company_scope_select" on public.subsidiaries;
create policy "company_scope_select" on public.subsidiaries
for select to authenticated
using(
  subsidiary_id=public.active_subsidiary_id()
  or exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=public.app_user_id()
      and access.subsidiary_id=subsidiaries.subsidiary_id
  )
  or (
    lower(coalesce(auth.jwt()->>'email',''))='demo@nexo.com'
    and not exists(select 1 from public.user_subsidiaries access where access.user_id=public.app_user_id())
  )
);
