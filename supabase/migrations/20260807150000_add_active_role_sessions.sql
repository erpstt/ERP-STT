create table if not exists public.user_role_sessions(
  session_id text primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  role_id bigint not null references public.roles(role_id) on delete cascade,
  selected_at timestamptz not null default now()
);
alter table public.user_role_sessions enable row level security;
drop policy if exists "user_role_sessions_access" on public.user_role_sessions;
create policy "user_role_sessions_access" on public.user_role_sessions for all to authenticated
using(user_id=public.app_user_id())
with check(user_id=public.app_user_id() and exists(select 1 from public.user_roles ur where ur.user_id=public.app_user_id() and ur.role_id=user_role_sessions.role_id));

create or replace function public.app_active_role_id() returns bigint
language sql stable security definer set search_path=public
as $$select role_id from public.user_role_sessions where session_id=public.app_session_id() and user_id=public.app_user_id() limit 1$$;
grant execute on function public.app_active_role_id() to authenticated;

create or replace function public.app_is_admin() returns boolean
language sql stable security definer set search_path=public
as $$
  select exists(
    select 1 from public.roles r
    where r.role_id=public.app_active_role_id()
      and lower(r.role_name) in('administrador','administrator','admin')
  )
$$;
grant execute on function public.app_is_admin() to authenticated;
