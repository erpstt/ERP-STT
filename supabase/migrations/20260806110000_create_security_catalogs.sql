create table if not exists public.users (
  user_id bigint generated always as identity primary key,
  timezone_id bigint references public.timezones(timezone_id) on delete set null,
  email text not null unique check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  password_hash text not null,
  first_name text not null,
  last_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.roles (
  role_id bigint generated always as identity primary key,
  role_name text not null unique,
  description text,
  is_system_role boolean not null default false
);
create table if not exists public.permissions (
  permission_id bigint generated always as identity primary key,
  code text not null unique,
  module text not null,
  description text
);
create table if not exists public.role_permissions (
  id bigint generated always as identity primary key,
  role_id bigint not null references public.roles(role_id) on delete cascade,
  permission_id bigint not null references public.permissions(permission_id) on delete cascade,
  unique(role_id, permission_id)
);
create table if not exists public.user_roles (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  role_id bigint not null references public.roles(role_id) on delete cascade,
  unique(user_id, role_id)
);
create table if not exists public.sessions (
  session_id bigint generated always as identity primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  session_token text not null unique,
  ip_address inet,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.devices (
  device_id bigint generated always as identity primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  device_name text not null,
  device_token text not null unique,
  last_used timestamptz
);
create table if not exists public.login_history (
  history_id bigint generated always as identity primary key,
  user_id bigint references public.users(user_id) on delete set null,
  login_time timestamptz not null default now(),
  ip_address inet,
  status text not null
);
create table if not exists public.password_history (
  history_id bigint generated always as identity primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.api_keys (
  api_key_id bigint generated always as identity primary key,
  user_id bigint not null references public.users(user_id) on delete cascade,
  key_hash text not null unique,
  name text not null,
  is_active boolean not null default true,
  expires_at timestamptz
);
create table if not exists public.oauth_clients (
  client_id bigint generated always as identity primary key,
  client_secret text not null unique,
  name text not null,
  redirect_uri text not null,
  is_active boolean not null default true
);
create table if not exists public.menus (
  menu_id bigint generated always as identity primary key,
  title text not null,
  icon text,
  route text unique,
  parent_id bigint references public.menus(menu_id) on delete set null,
  sort_order integer not null default 0
);
create table if not exists public.menu_permissions (
  id bigint generated always as identity primary key,
  menu_id bigint not null references public.menus(menu_id) on delete cascade,
  role_id bigint not null references public.roles(role_id) on delete cascade,
  unique(menu_id, role_id)
);

create index if not exists users_timezone_idx on public.users(timezone_id);
create index if not exists sessions_user_idx on public.sessions(user_id);
create index if not exists devices_user_idx on public.devices(user_id);
create index if not exists login_history_user_idx on public.login_history(user_id);
create index if not exists password_history_user_idx on public.password_history(user_id);
create index if not exists api_keys_user_idx on public.api_keys(user_id);
create index if not exists menus_parent_idx on public.menus(parent_id);

do $$
declare target_table text;
begin
  foreach target_table in array array['users','roles','permissions','role_permissions','user_roles','sessions','devices','login_history','password_history','api_keys','oauth_clients','menus','menu_permissions'] loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('drop policy if exists "security_select" on public.%I', target_table);
    execute format('drop policy if exists "security_insert" on public.%I', target_table);
    execute format('drop policy if exists "security_update" on public.%I', target_table);
    execute format('drop policy if exists "security_delete" on public.%I', target_table);
    execute format('create policy "security_select" on public.%I for select to authenticated using (true)', target_table);
    execute format('create policy "security_insert" on public.%I for insert to authenticated with check (true)', target_table);
    execute format('create policy "security_update" on public.%I for update to authenticated using (true) with check (true)', target_table);
    execute format('create policy "security_delete" on public.%I for delete to authenticated using (true)', target_table);
  end loop;
end $$;
