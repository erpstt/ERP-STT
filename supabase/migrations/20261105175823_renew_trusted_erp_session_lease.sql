-- A refresh continues an already registered Auth-session/device binding. These
-- RPCs are server-only: a signed refresh cookie and fresh provider proof for the
-- same user/session must be verified by the server before completion/logout.
-- An elapsed ERP expiry is only a technical lease; revocation remains final.
set local lock_timeout='5s';
set local statement_timeout='60s';

create function public.security_prepare_session_refresh(
 p_auth_user_id uuid,p_auth_session_id uuid,p_device_token_hash text
)returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare matches bigint;u bigint;token_hash text;expiry timestamptz;auth_limit timestamptz;
begin
 if p_auth_user_id is null or p_auth_session_id is null or p_device_token_hash is null or p_device_token_hash!~'^[0-9a-f]{64}$'then raise exception using errcode='42501',message='El vínculo de renovación no está autorizado.';end if;
 select count(*),min(s.user_id),min(s.session_token),min(s.expires_at),min(a.not_after)
 into matches,u,token_hash,expiry,auth_limit
 from public.users account join auth.sessions a on a.user_id=account.auth_user_id and a.id=p_auth_session_id
 join public.sessions s on s.user_id=account.user_id and s.auth_session_id=a.id
 join public.devices d on d.device_id=s.device_id and d.user_id=account.user_id
 where account.auth_user_id=p_auth_user_id and account.is_active
 and d.device_token=p_device_token_hash and d.revoked_at is null and s.revoked_at is null
 and s.session_token~'^[0-9a-f]{64}$'and s.expires_at is not null and isfinite(s.expires_at)
 and(a.not_after is null or a.not_after>clock_timestamp());
 if matches<>1 then raise exception using errcode='42501',message='La sesión de renovación no existe, está revocada o no es única.';end if;
 return jsonb_build_object('userId',u,'sessionTokenHash',token_hash,'expiresAt',expiry,
  'authNotAfter',case when auth_limit is null or not isfinite(auth_limit)then null else auth_limit end);
end$$;

create function public.security_refresh_session(
 p_auth_user_id uuid,p_auth_session_id uuid,p_device_token_hash text,
 p_expected_session_token_hash text,p_session_token_hash text,p_expires_at timestamptz
)returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $$
declare matches bigint;erp_session bigint;u bigint;did bigint;token_hash text;auth_limit timestamptz;expiry timestamptz;affected bigint;
begin
 if p_auth_user_id is null or p_auth_session_id is null or p_device_token_hash is null or p_device_token_hash!~'^[0-9a-f]{64}$'
 or p_expected_session_token_hash is null or p_expected_session_token_hash!~'^[0-9a-f]{64}$'
 or p_session_token_hash is null or p_session_token_hash!~'^[0-9a-f]{64}$'
 or p_expires_at is null or not isfinite(p_expires_at)or p_expires_at<=clock_timestamp()then raise exception using errcode='42501',message='La renovación de sesión no está autorizada.';end if;
 -- The same lock is used by login, device/session revocation and logout.
 perform pg_advisory_xact_lock(793153,1);
 select count(*),min(s.session_id),min(s.user_id),min(s.device_id),min(s.session_token),min(a.not_after)
 into matches,erp_session,u,did,token_hash,auth_limit
 from public.users account join auth.sessions a on a.user_id=account.auth_user_id and a.id=p_auth_session_id
 join public.sessions s on s.user_id=account.user_id and s.auth_session_id=a.id
 join public.devices d on d.device_id=s.device_id and d.user_id=account.user_id
 where account.auth_user_id=p_auth_user_id and account.is_active
 and d.device_token=p_device_token_hash and d.revoked_at is null and s.revoked_at is null
 and s.session_token~'^[0-9a-f]{64}$'and s.expires_at is not null and isfinite(s.expires_at)
 and(a.not_after is null or a.not_after>clock_timestamp());
 if matches<>1 then raise exception using errcode='42501',message='La sesión de renovación no existe, está revocada o no es única.';end if;
 if token_hash is distinct from p_expected_session_token_hash then raise exception using errcode='PT409',message='La sesión cambió durante la renovación. Descarte el resultado y vuelva a preparar la sesión.';end if;
 expiry:=least(p_expires_at,clock_timestamp()+interval'15 minutes',coalesce(auth_limit,'infinity'::timestamptz));
 if expiry<=clock_timestamp()then raise exception using errcode='42501',message='La autorización de renovación ya venció.';end if;
 begin
  update public.sessions set session_token=p_session_token_hash,expires_at=expiry
  where session_id=erp_session and user_id=u and auth_session_id=p_auth_session_id and device_id=did
   and revoked_at is null and session_token=p_expected_session_token_hash;
  get diagnostics affected=row_count;
 exception when unique_violation then
  raise exception using errcode='PT409',message='El token de renovación ya pertenece a otro vínculo de sesión.';
 end;
 if affected<>1 then raise exception using errcode='PT409',message='La sesión cambió durante la renovación. Vuelva a preparar la sesión.';end if;
 return jsonb_build_object('userId',u,'expiresAt',expiry);
end$$;

create function public.security_logout_session_binding(
 p_auth_user_id uuid,p_auth_session_id uuid,p_device_token_hash text,p_expected_session_token_hash text
)returns boolean language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $$
declare matches bigint;erp_session bigint;u bigint;did bigint;token_hash text;affected bigint;
begin
 if p_auth_user_id is null or p_auth_session_id is null or p_device_token_hash is null or p_device_token_hash!~'^[0-9a-f]{64}$'
 or p_expected_session_token_hash is null or p_expected_session_token_hash!~'^[0-9a-f]{64}$'then raise exception using errcode='42501',message='El cierre de sesión no está autorizado.';end if;
 perform pg_advisory_xact_lock(793153,1);
 select count(*),min(s.session_id),min(s.user_id),min(s.device_id),min(s.session_token)
 into matches,erp_session,u,did,token_hash
 from public.users account join auth.sessions a on a.user_id=account.auth_user_id and a.id=p_auth_session_id
 join public.sessions s on s.user_id=account.user_id and s.auth_session_id=a.id
 join public.devices d on d.device_id=s.device_id and d.user_id=account.user_id
 where account.auth_user_id=p_auth_user_id and account.is_active
 and d.device_token=p_device_token_hash and d.revoked_at is null and s.revoked_at is null
 and s.session_token~'^[0-9a-f]{64}$'and s.expires_at is not null and isfinite(s.expires_at)
 and(a.not_after is null or a.not_after>clock_timestamp());
 if matches<>1 then raise exception using errcode='42501',message='La sesión de cierre no existe, está revocada o no es única.';end if;
 if token_hash is distinct from p_expected_session_token_hash then raise exception using errcode='PT409',message='La sesión cambió durante el cierre. Vuelva a preparar y verificar la sesión.';end if;
 update public.sessions set revoked_at=clock_timestamp()
 where session_id=erp_session and user_id=u and auth_session_id=p_auth_session_id and device_id=did
  and revoked_at is null and session_token=p_expected_session_token_hash;
 get diagnostics affected=row_count;
 if affected<>1 then raise exception using errcode='PT409',message='La sesión cambió durante el cierre. Vuelva a preparar la sesión.';end if;
 delete from public.user_role_sessions where session_id=p_auth_session_id::text and user_id=u;
 delete from public.user_company_sessions where session_id=p_auth_session_id::text and user_id=u;
 return true;
end$$;

revoke all on function public.security_prepare_session_refresh(uuid,uuid,text),
 public.security_refresh_session(uuid,uuid,text,text,text,timestamptz),
 public.security_logout_session_binding(uuid,uuid,text,text)from public,anon,authenticated,service_role;
grant execute on function public.security_prepare_session_refresh(uuid,uuid,text),
 public.security_refresh_session(uuid,uuid,text,text,text,timestamptz),
 public.security_logout_session_binding(uuid,uuid,text,text)to service_role;

-- A prepare result is a point-in-time CAS expectation, not an access grant.
-- Fresh provider proof must follow that prepare. A PT409 result is never retried
-- with the same provider result and a newly read expectation: that could replace
-- a newer token with an older one. Coordinate refresh per binding in the server
-- and browser; after a conflict obtain a new prepare AND new provider proof.
comment on function public.security_prepare_session_refresh(uuid,uuid,text)is 'Server-only binding read after signed-cookie verification; does not authorize ordinary access or extend a lease.';
comment on function public.security_refresh_session(uuid,uuid,text,text,text,timestamptz)is 'Server-only same-Auth-session refresh after fresh provider proof; CAS conflict PT409 requires new prepare and new proof, without replaying the old result.';
comment on function public.security_logout_session_binding(uuid,uuid,text,text)is 'Server-only same-binding logout after verified provider proof; technical ERP expiry may be elapsed, revocation and CAS remain authoritative.';
notify pgrst,'reload schema';
