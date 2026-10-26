-- One-time server-side state for password recovery links. Only the service
-- role can read or mutate these rows; neither anon nor authenticated clients
-- receive the email/state values (only SHA-256 digests are stored).
create table if not exists public.password_recovery_grants (
  recovery_id bigint generated always as identity primary key,
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  state_hash text not null unique check (state_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint password_recovery_grants_expiration_check check (expires_at > created_at)
);

create index if not exists password_recovery_grants_expiry_idx
  on public.password_recovery_grants (expires_at)
  where consumed_at is null;

alter table public.password_recovery_grants enable row level security;
alter table public.password_recovery_grants force row level security;

revoke all on table public.password_recovery_grants from public, anon, authenticated;
revoke all on sequence public.password_recovery_grants_recovery_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.password_recovery_grants to service_role;
grant usage, select on sequence public.password_recovery_grants_recovery_id_seq to service_role;

create or replace function public.consume_password_recovery_grant(
  p_state_hash text,
  p_email_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operación reservada al servicio.' using errcode = '42501';
  end if;
  if p_state_hash !~ '^[a-f0-9]{64}$' or p_email_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;
  update public.password_recovery_grants
     set consumed_at = clock_timestamp()
   where state_hash = p_state_hash
     and email_hash = p_email_hash
     and consumed_at is null
     and expires_at > clock_timestamp();
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.consume_password_recovery_grant(text, text) from public, anon, authenticated;
grant execute on function public.consume_password_recovery_grant(text, text) to service_role;

comment on table public.password_recovery_grants is
  'Estados opacos, de un solo uso y vida corta para validar enlaces de recuperación de contraseña.';

