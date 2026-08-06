insert into public.roles(role_name,description,is_system_role)
values('Administrador','Acceso administrativo global a todas las empresas y configuraciones',true)
on conflict(role_name) do update set description=excluded.description,is_system_role=true;

insert into public.user_roles(user_id,role_id)
select u.user_id,r.role_id
from public.users u
join public.roles r on lower(r.role_name)='administrador'
where lower(u.email)='danny.valderrama@grupostt.com'
on conflict(user_id,role_id) do nothing;

create or replace function public.app_is_admin() returns boolean
language sql stable security definer set search_path=public
as $$
  select exists(
    select 1
    from public.user_roles ur
    join public.roles r on r.role_id=ur.role_id
    where ur.user_id=public.app_user_id()
      and lower(r.role_name) in('administrador','administrator','admin')
  )
$$;
grant execute on function public.app_is_admin() to authenticated;

do $$
declare p record; using_expression text; check_expression text;
begin
  for p in
    select schemaname,tablename,policyname,cmd,qual,with_check
    from pg_policies
    where schemaname='public' and policyname like 'company_%'
  loop
    using_expression:=coalesce(p.qual,'false');
    check_expression:=coalesce(p.with_check,p.qual,'false');
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
    if p.cmd='SELECT' then
      execute format('create policy %I on public.%I for select to authenticated using(public.app_is_admin() or (%s))',p.policyname,p.tablename,using_expression);
    elsif p.cmd='INSERT' then
      execute format('create policy %I on public.%I for insert to authenticated with check(public.app_is_admin() or (%s))',p.policyname,p.tablename,check_expression);
    elsif p.cmd='UPDATE' then
      execute format('create policy %I on public.%I for update to authenticated using(public.app_is_admin() or (%s)) with check(public.app_is_admin() or (%s))',p.policyname,p.tablename,using_expression,check_expression);
    elsif p.cmd='DELETE' then
      execute format('create policy %I on public.%I for delete to authenticated using(public.app_is_admin() or (%s))',p.policyname,p.tablename,using_expression);
    end if;
  end loop;
end$$;
