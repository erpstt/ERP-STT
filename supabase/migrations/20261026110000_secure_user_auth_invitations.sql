-- Enlace estable entre el usuario ERP y Supabase Auth.
do $$
begin
  if exists(
    select 1 from public.users
    group by lower(trim(email))
    having count(*)>1
  ) then
    raise exception 'Existen usuarios duplicados al comparar el correo sin distinguir mayúsculas. Corríjalos antes de aplicar la migración.';
  end if;
end;
$$;

update public.users set email=lower(trim(email)) where email is distinct from lower(trim(email));
create unique index if not exists users_email_lower_uidx on public.users(lower(email));

alter table public.users add column if not exists auth_user_id uuid;
alter table public.users add column if not exists invitation_sent_at timestamptz;
alter table public.users add column if not exists invitation_accepted_at timestamptz;

update public.users
set auth_user_id=substring(password_hash from '^auth:([0-9a-fA-F-]{36})$')::uuid
where auth_user_id is null
  and password_hash ~ '^auth:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

create unique index if not exists users_auth_user_id_uidx
  on public.users(auth_user_id)
  where auth_user_id is not null;

-- Estado adicional, opaco y de un solo uso. El enlace de Supabase también es
-- de un solo uso, pero este control impide utilizar una sesión OTP distinta.
create table if not exists public.user_invitation_grants(
  invitation_id bigint generated always as identity primary key,
  email_hash text not null check(email_hash~'^[a-f0-9]{64}$'),
  state_hash text not null unique check(state_hash~'^[a-f0-9]{64}$'),
  auth_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint user_invitation_grants_expiry_check check(expires_at>created_at)
);

create index if not exists user_invitation_grants_open_idx
  on public.user_invitation_grants(expires_at)
  where consumed_at is null;

alter table public.user_invitation_grants enable row level security;
alter table public.user_invitation_grants force row level security;
revoke all on table public.user_invitation_grants from public,anon,authenticated;
revoke all on sequence public.user_invitation_grants_invitation_id_seq from public,anon,authenticated;
grant select,insert,update,delete on table public.user_invitation_grants to service_role;
grant usage,select on sequence public.user_invitation_grants_invitation_id_seq to service_role;

create or replace function public.consume_user_invitation_grant(
  p_state_hash text,
  p_email_hash text,
  p_auth_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare affected integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Operación reservada al servicio.' using errcode='42501';
  end if;
  if p_state_hash!~'^[a-f0-9]{64}$' or p_email_hash!~'^[a-f0-9]{64}$' or p_auth_user_id is null then
    return false;
  end if;
  update public.user_invitation_grants
     set consumed_at=clock_timestamp()
   where state_hash=p_state_hash
     and email_hash=p_email_hash
     and auth_user_id=p_auth_user_id
     and consumed_at is null
     and expires_at>clock_timestamp();
  get diagnostics affected=row_count;
  return affected=1;
end;
$$;

revoke all on function public.consume_user_invitation_grant(text,text,uuid) from public,anon,authenticated;
grant execute on function public.consume_user_invitation_grant(text,text,uuid) to service_role;

comment on column public.users.auth_user_id is 'Identificador no secreto de la cuenta correspondiente en Supabase Auth.';
comment on table public.user_invitation_grants is 'Estados SHA-256 de un solo uso para completar invitaciones de usuarios.';

notify pgrst,'reload schema';
