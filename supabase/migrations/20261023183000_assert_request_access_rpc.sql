-- Valida en una sola ida a la base de datos la sesión y el dispositivo
-- asociados al usuario autenticado. Los tokens llegan previamente resumidos
-- con SHA-256; la función nunca recibe ni persiste el token original.

create or replace function public.assert_request_access(
  p_session_token_hash text,
  p_device_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  current_email text:=lower(coalesce(auth.jwt()->>'email',''));
  current_user_id bigint;
  current_device_id bigint;
  checked_at timestamptz:=clock_timestamp();
begin
  if p_session_token_hash is null
    or p_session_token_hash !~ '^[0-9a-f]{64}$'
    or p_device_token_hash is null
    or p_device_token_hash !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('allowed',false,'reason','INVALID_CREDENTIAL_FORMAT');
  end if;

  select account.user_id
    into current_user_id
  from public.users account
  where lower(account.email)=current_email
    and account.is_active=true
  limit 1;

  if current_user_id is null then
    return jsonb_build_object('allowed',false,'reason','USER_INACTIVE');
  end if;

  if not exists(
    select 1
    from public.sessions active_session
    where active_session.user_id=current_user_id
      and active_session.session_token=p_session_token_hash
      and active_session.expires_at>checked_at
  ) then
    return jsonb_build_object('allowed',false,'reason','SESSION_INVALID');
  end if;

  select registered_device.device_id
    into current_device_id
  from public.devices registered_device
  where registered_device.user_id=current_user_id
    and registered_device.device_token=p_device_token_hash
  limit 1;

  if current_device_id is null then
    return jsonb_build_object('allowed',false,'reason','DEVICE_INVALID');
  end if;

  -- Evita una escritura por solicitud. También vuelve atómica la comprobación
  -- frente a peticiones concurrentes: solo actualiza si la marca ya venció.
  update public.devices registered_device
  set last_used=checked_at
  where registered_device.device_id=current_device_id
    and(
      registered_device.last_used is null
      or registered_device.last_used<=checked_at-interval '5 minutes'
    );

  return jsonb_build_object('allowed',true);
end;
$$;

comment on function public.assert_request_access(text,text) is
  'Valida usuario activo, sesión vigente y dispositivo registrado en una sola operación; limita last_used a una escritura cada cinco minutos.';

revoke all on function public.assert_request_access(text,text) from public;
revoke all on function public.assert_request_access(text,text) from anon;
revoke all on function public.assert_request_access(text,text) from authenticated;
grant execute on function public.assert_request_access(text,text) to authenticated;
